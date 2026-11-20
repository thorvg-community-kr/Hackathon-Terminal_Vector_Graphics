/**
 * ansiPostProcessor.ts - 단일 패스 ANSI 상태 차분(RLE) 압축 및 배경 프리셋 후처리기
 *
 * - 프리빌트 termvg.wasm을 수정하지 않고 중복 트루컬러 SGR 시퀀스를 제거(50~90% 압축)
 * - 투명(\x1b[49m + 반블록/사분면 보수 글리프 반전) 및 테마 배경 프리셋 치환 지원
 * - 불투명 프리셋 경계 셀(inBg / inFg) 양방향 크로마키 치환으로 Black Halo 방지
 */

export type BackgroundPreset = 'transparent' | 'dark' | 'light' | 'checkerboard';

export interface PostProcessOptions {
  /** 배경 치환 프리셋 (기본값: 'transparent') */
  background?: BackgroundPreset;
  /** 인접 셀 동일 색상 SGR 시퀀스 생략 여부 (기본값: true) */
  optimizeRle?: boolean;
}

const COLOR_DEFAULT = -1;
const COLOR_WASM_BG = 0x000000;
// 출력 SGR 상태를 알 수 없음(원문 SGR 통과 후). 다음 셀에서 SGR 재출력과 줄 끝 리셋을 강제한다.
const OUT_UNKNOWN = -2;

const PRESET_DARK = 0x181825;
const PRESET_LIGHT = 0xf5f5f7;
const CHECKER_EVEN = 0x2a2a37;
const CHECKER_ODD = 0x1e1e28;

const SGR_BG_DARK = '\x1b[48;2;24;24;37m';
const SGR_FG_DARK = '\x1b[38;2;24;24;37m';
const SGR_BG_LIGHT = '\x1b[48;2;245;245;247m';
const SGR_FG_LIGHT = '\x1b[38;2;245;245;247m';
const SGR_BG_CHECKER_EVEN = '\x1b[48;2;42;42;55m';
const SGR_FG_CHECKER_EVEN = '\x1b[38;2;42;42;55m';
const SGR_BG_CHECKER_ODD = '\x1b[48;2;30;30;40m';
const SGR_FG_CHECKER_ODD = '\x1b[38;2;30;30;40m';

/** 0~255 정수 문자열 룩업 테이블 (핫 루프 내 .toString() 할당 제거) */
const BYTE_STR: readonly string[] = Array.from({ length: 256 }, (_, i) => String(i));

/** 공백 런(run-length) 일괄 출력용 사전 할당 문자열 테이블 */
const SPACES_LUT: readonly string[] = Array.from({ length: 257 }, (_, n) => ' '.repeat(n));

function isChromaCellAt(rawAnsi: string, i: number): boolean {
  const g = rawAnsi.charCodeAt(i + 26);
  if (g !== 0x2584 && g !== 0x20) return false;
  return (
    rawAnsi.charCodeAt(i + 1) === 0x5b &&
    rawAnsi.charCodeAt(i + 2) === 0x34 &&
    rawAnsi.charCodeAt(i + 3) === 0x38 &&
    rawAnsi.charCodeAt(i + 4) === 0x3b &&
    rawAnsi.charCodeAt(i + 5) === 0x32 &&
    rawAnsi.charCodeAt(i + 6) === 0x3b &&
    rawAnsi.charCodeAt(i + 7) === 0x30 &&
    rawAnsi.charCodeAt(i + 8) === 0x3b &&
    rawAnsi.charCodeAt(i + 9) === 0x30 &&
    rawAnsi.charCodeAt(i + 10) === 0x3b &&
    rawAnsi.charCodeAt(i + 11) === 0x30 &&
    rawAnsi.charCodeAt(i + 12) === 0x6d &&
    rawAnsi.charCodeAt(i + 13) === 0x1b &&
    rawAnsi.charCodeAt(i + 14) === 0x5b &&
    rawAnsi.charCodeAt(i + 15) === 0x33 &&
    rawAnsi.charCodeAt(i + 16) === 0x38 &&
    rawAnsi.charCodeAt(i + 17) === 0x3b &&
    rawAnsi.charCodeAt(i + 18) === 0x32 &&
    rawAnsi.charCodeAt(i + 19) === 0x3b &&
    rawAnsi.charCodeAt(i + 20) === 0x30 &&
    rawAnsi.charCodeAt(i + 21) === 0x3b &&
    rawAnsi.charCodeAt(i + 22) === 0x30 &&
    rawAnsi.charCodeAt(i + 23) === 0x3b &&
    rawAnsi.charCodeAt(i + 24) === 0x30 &&
    rawAnsi.charCodeAt(i + 25) === 0x6d
  );
}

/**
 * U+2580..U+259F 블록 문자 32슬롯 O(1) 보수 룩업 테이블 (null = 블록 글리프 아님).
 * 투명 배경 모드에서 상단/외곽이 전경색(inBg)이고 하단/내부 서브픽셀이 배경(0;0;0)일 때
 * 비트 보수 글리프로 뒤집고 fg/bg를 스왑하여 \x1b[49m 투명을 구현한다.
 */
const BLOCK_COMPLEMENT_LUT: (string | null)[] = new Array(32).fill(null);
const BLOCK_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['▄', '▀'],
  ['▀', '▄'],
  ['▌', '▐'],
  ['▐', '▌'],
  ['▘', '▟'],
  ['▟', '▘'],
  ['▝', '▙'],
  ['▙', '▝'],
  ['▖', '▜'],
  ['▜', '▖'],
  ['▗', '▛'],
  ['▛', '▗'],
  ['▞', '▚'],
  ['▚', '▞'],
  ['█', ' '],
];
for (const [src, dst] of BLOCK_PAIRS) {
  BLOCK_COMPLEMENT_LUT[src.charCodeAt(0) - 0x2580] = dst;
}

function isBg(color: number): boolean {
  return color === COLOR_WASM_BG || color === COLOR_DEFAULT;
}

function getBlockComplement(code: number): string | null {
  if (code < 0x2580 || code > 0x259f) return null;
  return BLOCK_COMPLEMENT_LUT[code - 0x2580];
}

function resolvePresetBg(background: BackgroundPreset, col: number, row: number): number {
  switch (background) {
    case 'dark':
      return PRESET_DARK;
    case 'light':
      return PRESET_LIGHT;
    case 'checkerboard':
      return ((col + row) & 1) === 0 ? CHECKER_EVEN : CHECKER_ODD;
    case 'transparent':
    default:
      return COLOR_DEFAULT;
  }
}

function formatBgSgr(rgb: number): string {
  if (rgb === COLOR_DEFAULT) return '\x1b[49m';
  if (rgb === PRESET_DARK) return SGR_BG_DARK;
  if (rgb === PRESET_LIGHT) return SGR_BG_LIGHT;
  if (rgb === CHECKER_EVEN) return SGR_BG_CHECKER_EVEN;
  if (rgb === CHECKER_ODD) return SGR_BG_CHECKER_ODD;
  return (
    '\x1b[48;2;' +
    BYTE_STR[(rgb >>> 16) & 0xff] +
    ';' +
    BYTE_STR[(rgb >>> 8) & 0xff] +
    ';' +
    BYTE_STR[rgb & 0xff] +
    'm'
  );
}

function formatFgSgr(rgb: number): string {
  if (rgb === COLOR_DEFAULT) return '\x1b[39m';
  if (rgb === PRESET_DARK) return SGR_FG_DARK;
  if (rgb === PRESET_LIGHT) return SGR_FG_LIGHT;
  if (rgb === CHECKER_EVEN) return SGR_FG_CHECKER_EVEN;
  if (rgb === CHECKER_ODD) return SGR_FG_CHECKER_ODD;
  return (
    '\x1b[38;2;' +
    BYTE_STR[(rgb >>> 16) & 0xff] +
    ';' +
    BYTE_STR[(rgb >>> 8) & 0xff] +
    ';' +
    BYTE_STR[rgb & 0xff] +
    'm'
  );
}

/**
 * 단일 패스 ANSI 후처리기.
 * ANSI 시퀀스가 없는 일반 문자열('Loading...', 'Failed to load file', '')은 O(1)로 즉시 반환한다.
 */
export function postProcessAnsiFrame(
  rawAnsi: string,
  options?: PostProcessOptions
): string {
  if (!rawAnsi || rawAnsi.indexOf('\x1b') === -1) {
    return rawAnsi;
  }

  const background: BackgroundPreset = options?.background ?? 'transparent';
  const optimizeRle: boolean = options?.optimizeRle ?? true;
  const isTransparent = background === 'transparent';
  const len = rawAnsi.length;

  let out = '';
  let inFg: number = COLOR_DEFAULT;
  let inBg: number = COLOR_DEFAULT;
  let outFg: number = COLOR_DEFAULT;
  let outBg: number = COLOR_DEFAULT;
  let lineHadReset: boolean = false;
  // 원문 통과된 SGR(bold 등 비색상 속성 포함)이 있으면 줄 끝/EOF에서 반드시 리셋
  let lineHadPassthrough: boolean = false;
  let col = 0;
  let row = 0;
  let i = 0;

  while (i < len) {
    const code = rawAnsi.charCodeAt(i);

    // 1. Escape / CSI sequence handling
    if (code === 0x1b) {
      if (isTransparent && optimizeRle && i + 26 < len && isChromaCellAt(rawAnsi, i)) {
        let run = 1;
        i += 27;
        while (
          i + 26 < len &&
          rawAnsi.charCodeAt(i) === 0x1b &&
          isChromaCellAt(rawAnsi, i)
        ) {
          run++;
          i += 27;
        }
        inFg = COLOR_WASM_BG;
        inBg = COLOR_WASM_BG;
        if (outBg !== COLOR_DEFAULT) {
          out += '\x1b[49m';
          outBg = COLOR_DEFAULT;
        }
        col += run;
        while (run > 256) {
          out += SPACES_LUT[256];
          run -= 256;
        }
        out += SPACES_LUT[run];
        continue;
      }

      if (i + 1 < len && rawAnsi.charCodeAt(i + 1) === 0x5b /* '[' */) {
        let j = i + 2;
        while (j < len) {
          const c = rawAnsi.charCodeAt(j);
          if ((c >= 0x30 && c <= 0x39) || c === 0x3b /* ';' */) {
            j++;
          } else {
            break;
          }
        }

        // Incomplete CSI sequence at EOF -> preserve verbatim safely
        if (j >= len) {
          out += rawAnsi.slice(i, len);
          i = len;
          break;
        }

        const term = rawAnsi.charCodeAt(j);
        if (term === 0x6d /* 'm' */) {
          const start = i + 2;
          const sgrLen = j - start;
          // Fast path for \x1b[0m and \x1b[m
          if (sgrLen === 0 || (sgrLen === 1 && rawAnsi.charCodeAt(start) === 0x30)) {
            inFg = COLOR_DEFAULT;
            inBg = COLOR_DEFAULT;
            lineHadReset = true;
            i = j + 1;
            continue;
          }
          // Fast path for exact chroma-key SGR: \x1b[48;2;0;0;0m / \x1b[38;2;0;0;0m
          if (
            sgrLen === 10 &&
            rawAnsi.charCodeAt(start + 1) === 0x38 &&
            rawAnsi.charCodeAt(start + 2) === 0x3b &&
            rawAnsi.charCodeAt(start + 3) === 0x32 &&
            rawAnsi.charCodeAt(start + 4) === 0x3b &&
            rawAnsi.charCodeAt(start + 5) === 0x30 &&
            rawAnsi.charCodeAt(start + 6) === 0x3b &&
            rawAnsi.charCodeAt(start + 7) === 0x30 &&
            rawAnsi.charCodeAt(start + 8) === 0x3b &&
            rawAnsi.charCodeAt(start + 9) === 0x30
          ) {
            const first = rawAnsi.charCodeAt(start);
            if (first === 0x34) {
              inBg = COLOR_WASM_BG;
              i = j + 1;
              continue;
            }
            if (first === 0x33) {
              inFg = COLOR_WASM_BG;
              i = j + 1;
              continue;
            }
          }

          // Parse SGR parameters atomically with zero heap allocations
          const savedFg: number = inFg;
          const savedBg: number = inBg;
          const savedReset: boolean = lineHadReset;
          let supported = true;
          let p = start;

          while (p < j) {
            let param = 0;
            let hasDigits = false;
            while (p < j) {
              const chCode = rawAnsi.charCodeAt(p);
              if (chCode === 0x3b) {
                p++;
                break;
              }
              param = param * 10 + (chCode - 0x30);
              hasDigits = true;
              p++;
            }

            if (!hasDigits || param === 0) {
              inFg = COLOR_DEFAULT;
              inBg = COLOR_DEFAULT;
              lineHadReset = true;
            } else if (param === 39) {
              inFg = COLOR_DEFAULT;
            } else if (param === 49) {
              inBg = COLOR_DEFAULT;
            } else if (param === 38 || param === 48) {
              const isFg = param === 38;
              let mode = 0;
              let modeDigits = false;
              while (p < j) {
                const chCode = rawAnsi.charCodeAt(p);
                if (chCode === 0x3b) {
                  p++;
                  break;
                }
                mode = mode * 10 + (chCode - 0x30);
                modeDigits = true;
                p++;
              }

              if (!modeDigits || mode !== 2) {
                supported = false;
                break;
              }

              // Read R, G, B scalars without array allocation
              let r = 0;
              let hasR = false;
              let sep1 = false;
              while (p < j) {
                const chCode = rawAnsi.charCodeAt(p);
                if (chCode === 0x3b) {
                  p++;
                  sep1 = true;
                  break;
                }
                r = r * 10 + (chCode - 0x30);
                hasR = true;
                p++;
              }

              let g = 0;
              let hasG = false;
              let sep2 = false;
              while (p < j) {
                const chCode = rawAnsi.charCodeAt(p);
                if (chCode === 0x3b) {
                  p++;
                  sep2 = true;
                  break;
                }
                g = g * 10 + (chCode - 0x30);
                hasG = true;
                p++;
              }

              let b = 0;
              let hasB = false;
              while (p < j) {
                const chCode = rawAnsi.charCodeAt(p);
                if (chCode === 0x3b) {
                  p++;
                  break;
                }
                b = b * 10 + (chCode - 0x30);
                hasB = true;
                p++;
              }

              if (!hasR || !sep1 || !hasG || !sep2 || !hasB) {
                supported = false;
                break;
              }

              if (r > 255) r = 255;
              if (g > 255) g = 255;
              if (b > 255) b = 255;

              const packed = (r << 16) | (g << 8) | b;
              if (isFg) {
                inFg = packed;
              } else {
                inBg = packed;
              }
            } else {
              supported = false;
              break;
            }
          }

          if (!supported) {
            inFg = savedFg;
            inBg = savedBg;
            lineHadReset = savedReset;
            out += rawAnsi.slice(i, j + 1);
            outFg = OUT_UNKNOWN;
            outBg = OUT_UNKNOWN;
            lineHadPassthrough = true;
          }

          i = j + 1;
          continue;
        }

        // Non-SGR CSI sequence -> preserve verbatim without advancing terminal column
        while (j < len && (rawAnsi.charCodeAt(j) < 0x40 || rawAnsi.charCodeAt(j) > 0x7e)) {
          j++;
        }
        const endIdx = j < len ? j + 1 : len;
        if (j < len && rawAnsi.charCodeAt(j) === 0x6d /* 'm' (e.g. colon-separated SGR) */) {
          outFg = OUT_UNKNOWN;
          outBg = OUT_UNKNOWN;
          lineHadPassthrough = true;
        }
        out += rawAnsi.slice(i, endIdx);
        i = endIdx;
        continue;
      }

      // Standalone ESC or non-CSI escape -> preserve safely
      out += rawAnsi[i];
      i++;
      continue;
    }

    // 2. Line break handling (reset SGR before newline to prevent Color Bleed)
    if (code === 0x0a /* '\n' */) {
      if (outFg !== COLOR_DEFAULT || outBg !== COLOR_DEFAULT || lineHadReset || lineHadPassthrough) {
        out += '\x1b[0m';
      }
      out += '\n';
      inFg = COLOR_DEFAULT;
      inBg = COLOR_DEFAULT;
      outFg = COLOR_DEFAULT;
      outBg = COLOR_DEFAULT;
      lineHadReset = false;
      lineHadPassthrough = false;
      col = 0;
      row++;
      i++;
      continue;
    }

    if (code === 0x0d /* '\r' */) {
      out += '\r';
      col = 0;
      i++;
      continue;
    }

    // 3. Visible character cell (handle UTF-16 surrogate pairs as a single terminal cell)
    let ch: string;
    let isSpace = false;
    let complement: string | null = null;
    if (code === 0x20 /* ' ' */) {
      ch = ' ';
      isSpace = true;
      i++;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
      const low = rawAnsi.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        ch = rawAnsi.slice(i, i + 2);
        i += 2;
      } else {
        ch = rawAnsi[i];
        i++;
      }
    } else {
      ch = rawAnsi[i];
      complement = getBlockComplement(code);
      i++;
    }

    let targetCh = ch;
    let targetIsSpace = isSpace;
    let targetBg: number;
    let targetFg: number;

    if (isTransparent) {
      const bgIsChroma = isBg(inBg);
      if (bgIsChroma && (isSpace || (complement !== null && isBg(inFg)))) {
        targetCh = ' ';
        targetIsSpace = true;
        targetBg = COLOR_DEFAULT;
        targetFg = inFg;
      } else if (!bgIsChroma && complement !== null && isBg(inFg)) {
        targetCh = complement;
        targetIsSpace = complement === ' ';
        targetFg = inBg;
        targetBg = COLOR_DEFAULT;
      } else {
        targetBg = bgIsChroma ? COLOR_DEFAULT : inBg;
        targetFg = inFg;
      }
    } else {
      const presetRgb = resolvePresetBg(background, col, row);
      targetBg = isBg(inBg) ? presetRgb : inBg;
      targetFg = complement !== null && isBg(inFg) ? presetRgb : inFg;
    }

    if (optimizeRle) {
      if (targetBg !== outBg) {
        out += formatBgSgr(targetBg);
        outBg = targetBg;
      }
      if (!targetIsSpace && targetFg !== outFg) {
        out += formatFgSgr(targetFg);
        outFg = targetFg;
      }
    } else {
      out += formatBgSgr(targetBg);
      outBg = targetBg;
      if (!targetIsSpace) {
        out += formatFgSgr(targetFg);
        outFg = targetFg;
      }
    }

    out += targetCh;
    col++;
  }

  // Finalize any open SGR attributes at EOF
  if (outFg !== COLOR_DEFAULT || outBg !== COLOR_DEFAULT || lineHadReset || lineHadPassthrough) {
    out += '\x1b[0m';
  }

  return out;
}

const NEAR_BLACK_LOTTIE = 0.00784; // ~ 2 / 255

function isZeroRgbTriple(arr: unknown): arr is number[] {
  return (
    Array.isArray(arr) &&
    arr.length >= 3 &&
    arr[0] === 0 &&
    arr[1] === 0 &&
    arr[2] === 0
  );
}

function patchLottieColorProp(colorObj: any): boolean {
  if (!colorObj || typeof colorObj !== 'object') return false;
  let changed = false;
  if (!colorObj.a && isZeroRgbTriple(colorObj.k)) {
    colorObj.k[0] = NEAR_BLACK_LOTTIE;
    colorObj.k[1] = NEAR_BLACK_LOTTIE;
    colorObj.k[2] = NEAR_BLACK_LOTTIE;
    changed = true;
  } else if (colorObj.a === 1 && Array.isArray(colorObj.k)) {
    for (const kf of colorObj.k) {
      if (kf && typeof kf === 'object') {
        if (isZeroRgbTriple(kf.s)) {
          kf.s[0] = NEAR_BLACK_LOTTIE;
          kf.s[1] = NEAR_BLACK_LOTTIE;
          kf.s[2] = NEAR_BLACK_LOTTIE;
          changed = true;
        }
        if (isZeroRgbTriple(kf.e)) {
          kf.e[0] = NEAR_BLACK_LOTTIE;
          kf.e[1] = NEAR_BLACK_LOTTIE;
          kf.e[2] = NEAR_BLACK_LOTTIE;
          changed = true;
        }
      }
    }
  }
  return changed;
}

function walkLottieShapes(node: unknown): boolean {
  if (Array.isArray(node)) {
    let changed = false;
    for (const item of node) {
      if (walkLottieShapes(item)) changed = true;
    }
    return changed;
  }
  if (!node || typeof node !== 'object') return false;

  const obj = node as Record<string, any>;
  let changed = false;

  if ((obj.ty === 'fl' || obj.ty === 'st') && obj.c) {
    if (patchLottieColorProp(obj.c)) changed = true;
  }

  for (const key of Object.keys(obj)) {
    if (key === 'c' && (obj.ty === 'fl' || obj.ty === 'st')) continue;
    const val = obj[key];
    if (val && typeof val === 'object') {
      if (walkLottieShapes(val)) changed = true;
    }
  }

  return changed;
}

/**
 * 선택적 헬퍼: 에셋 내 순수 검정(#000000 / rgb(0,0,0) / Lottie [0,0,0]) 도형이
 * WASM 크로마키 결과값(0;0;0)과 혼동되지 않도록 시각적으로 동일한 근접 검정(#020202)으로 치환한다.
 */
export function remapPureBlackForeground(
  rawContent: string,
  format: 'svg' | 'lottie'
): string {
  if (!rawContent) return rawContent;

  if (format === 'svg') {
    return rawContent
      .replace(/([="'\s:;,])#(?:000000|000)(?![0-9a-fA-F])/g, '$1#020202')
      .replace(/rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)/gi, 'rgb(2, 2, 2)')
      .replace(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/gi, 'rgba(2, 2, 2,');
  }

  try {
    const parsed = JSON.parse(rawContent);
    if (!walkLottieShapes(parsed)) return rawContent;
    return JSON.stringify(parsed);
  } catch {
    return rawContent;
  }
}
