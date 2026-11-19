/**
 * pixelExtractor.ts - 프리빌트 termvg.wasm 무수정 RGBA 픽셀 프레임버퍼 브릿지
 *
 * - Emscripten embind로 노출된 Mode 0 (Half-block: \x1b[48;2;R;G;Bm\x1b[38;2;R;G;Bm▄)
 *   무손실 24-bit ANSI 출력을 정규식 없이 1-Pass charCodeAt 정수 파서로 디코딩한다.
 * - 동일/축소 해상도 연속 재생 시 내부 Uint8Array를 재사용하여 GC 스파이크를 차단한다.
 * - 크로마키 배경(0;0;0) 및 SGR 리셋 영역은 alpha = 0, 전경 픽셀은 alpha = 255로 복원한다.
 */

export interface PixelFrame {
  width: number;
  height: number;
  /** RGBA 4 bytes/px (row-major, length === width * height * 4), alpha=0 on chroma-key bg */
  data: Uint8Array;
}

/**
 * WASM Mode 0 루프(y < height / 2)에서 홀수 높이로 인한 마지막 스캔라인 누락과
 * 버퍼 크기 불일치를 막기 위해 양수 높이를 짝수로 올림 정규화한다.
 */
export function normalizeEvenHeight(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return 0;
  const h = Math.floor(height);
  return h % 2 === 0 ? h : h + 1;
}

export class WasmPixelExtractor {
  private buffer: Uint8Array = new Uint8Array(0);

  /**
   * WASM Mode 0 (Half-block) ANSI 문자열을 1-Pass 정수 스캐너로 파싱하여
   * 재사용 가능한 내부 RGBA Uint8Array 프레임버퍼에 기록한다.
   */
  public extractFromHalfBlockAnsi(ansi: string, width: number, height: number): PixelFrame {
    const safeW = Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
    const safeH = safeW === 0 ? 0 : normalizeEvenHeight(height);
    const requiredBytes = safeW * safeH * 4;

    if (this.buffer.length < requiredBytes) {
      this.buffer = new Uint8Array(requiredBytes);
    }

    const out =
      this.buffer.length === requiredBytes ? this.buffer : this.buffer.subarray(0, requiredBytes);
    out.fill(0);

    if (requiredBytes === 0 || !ansi) {
      return { width: safeW, height: safeH, data: out };
    }

    const len = ansi.length;
    let cellX = 0;
    let cellY = 0;
    let bgR = 0;
    let bgG = 0;
    let bgB = 0;
    let bgOpaque = false;
    let fgR = 0;
    let fgG = 0;
    let fgB = 0;
    let fgOpaque = false;

    let i = 0;
    while (i < len) {
      const code = ansi.charCodeAt(i);

      // 1. ANSI CSI 시퀀스 파싱 (제로 힙 할당)
      if (code === 0x1b && i + 1 < len && ansi.charCodeAt(i + 1) === 0x5b /* '[' */) {
        let j = i + 2;
        while (j < len) {
          const c = ansi.charCodeAt(j);
          if ((c >= 0x30 && c <= 0x39) || c === 0x3b /* ';' */) {
            j++;
          } else {
            break;
          }
        }

        if (j >= len) {
          break;
        }

        const term = ansi.charCodeAt(j);
        if (term === 0x6d /* 'm' */) {
          const start = i + 2;
          const sgrLen = j - start;

          if (sgrLen === 0 || (sgrLen === 1 && ansi.charCodeAt(start) === 0x30)) {
            bgOpaque = false;
            fgOpaque = false;
            i = j + 1;
            continue;
          }

          let p = start;
          while (p < j) {
            let param = 0;
            let hasDigits = false;
            while (p < j) {
              const chCode = ansi.charCodeAt(p);
              if (chCode === 0x3b) {
                p++;
                break;
              }
              param = param * 10 + (chCode - 0x30);
              hasDigits = true;
              p++;
            }

            if (!hasDigits || param === 0) {
              bgOpaque = false;
              fgOpaque = false;
            } else if (param === 39) {
              fgOpaque = false;
            } else if (param === 49) {
              bgOpaque = false;
            } else if (param === 38 || param === 48) {
              const isFg = param === 38;
              let colorMode = 0;
              let hasMode = false;
              while (p < j) {
                const chCode = ansi.charCodeAt(p);
                if (chCode === 0x3b) {
                  p++;
                  break;
                }
                colorMode = colorMode * 10 + (chCode - 0x30);
                hasMode = true;
                p++;
              }

              if (!hasMode || colorMode !== 2) {
                // 256색(38;5;n) 등 비-TrueColor 시퀀스는 다음 파라미터 1개 스킵
                if (colorMode === 5) {
                  while (p < j && ansi.charCodeAt(p) !== 0x3b) p++;
                  if (p < j) p++;
                }
                continue;
              }

              let r = 0;
              let hasR = false;
              let sep1 = false;
              while (p < j) {
                const chCode = ansi.charCodeAt(p);
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
                const chCode = ansi.charCodeAt(p);
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
                const chCode = ansi.charCodeAt(p);
                if (chCode === 0x3b) {
                  p++;
                  break;
                }
                b = b * 10 + (chCode - 0x30);
                hasB = true;
                p++;
              }

              if (!hasR || !sep1 || !hasG || !sep2 || !hasB) {
                break;
              }

              if (r > 255) r = 255;
              if (g > 255) g = 255;
              if (b > 255) b = 255;

              const isChromaBg = (r | g | b) === 0;
              if (isFg) {
                fgR = r;
                fgG = g;
                fgB = b;
                fgOpaque = !isChromaBg;
              } else {
                bgR = r;
                bgG = g;
                bgB = b;
                bgOpaque = !isChromaBg;
              }
            }
          }

          i = j + 1;
          continue;
        }

        // 비-SGR CSI 시퀀스 안전 스킵
        while (j < len && (ansi.charCodeAt(j) < 0x40 || ansi.charCodeAt(j) > 0x7e)) {
          j++;
        }
        i = j < len ? j + 1 : len;
        continue;
      }

      // 2. 줄바꿈 / 캐리지 리턴 처리
      if (code === 0x0a /* '\n' */) {
        cellY++;
        cellX = 0;
        i++;
        continue;
      }
      if (code === 0x0d /* '\r' */) {
        i++;
        continue;
      }

      // UTF-16 서로게이트 페어 처리 (열 인덱스만 1 전진)
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
        const low = ansi.charCodeAt(i + 1);
        i += low >= 0xdc00 && low <= 0xdfff ? 2 : 1;
        cellX++;
        continue;
      }

      i++;

      // 3. 가시 셀(상단/하단 2픽셀)을 RGBA 프레임버퍼에 기록
      if (cellX < safeW) {
        const topY = cellY * 2;
        const botY = topY + 1;

        if (code === 0x2584 /* '▄' */) {
          if (bgOpaque && topY < safeH) {
            const idx = (topY * safeW + cellX) * 4;
            out[idx] = bgR;
            out[idx + 1] = bgG;
            out[idx + 2] = bgB;
            out[idx + 3] = 255;
          }
          if (fgOpaque && botY < safeH) {
            const idx = (botY * safeW + cellX) * 4;
            out[idx] = fgR;
            out[idx + 1] = fgG;
            out[idx + 2] = fgB;
            out[idx + 3] = 255;
          }
        } else if (code === 0x2580 /* '▀' */) {
          if (fgOpaque && topY < safeH) {
            const idx = (topY * safeW + cellX) * 4;
            out[idx] = fgR;
            out[idx + 1] = fgG;
            out[idx + 2] = fgB;
            out[idx + 3] = 255;
          }
          if (bgOpaque && botY < safeH) {
            const idx = (botY * safeW + cellX) * 4;
            out[idx] = bgR;
            out[idx + 1] = bgG;
            out[idx + 2] = bgB;
            out[idx + 3] = 255;
          }
        } else if (code === 0x2588 /* '█' */) {
          if (fgOpaque && topY < safeH) {
            const idx = (topY * safeW + cellX) * 4;
            out[idx] = fgR;
            out[idx + 1] = fgG;
            out[idx + 2] = fgB;
            out[idx + 3] = 255;
          }
          if (fgOpaque && botY < safeH) {
            const idx = (botY * safeW + cellX) * 4;
            out[idx] = fgR;
            out[idx + 1] = fgG;
            out[idx + 2] = fgB;
            out[idx + 3] = 255;
          }
        } else if (code === 0x0020 /* ' ' */) {
          if (bgOpaque && topY < safeH) {
            const idx = (topY * safeW + cellX) * 4;
            out[idx] = bgR;
            out[idx + 1] = bgG;
            out[idx + 2] = bgB;
            out[idx + 3] = 255;
          }
          if (bgOpaque && botY < safeH) {
            const idx = (botY * safeW + cellX) * 4;
            out[idx] = bgR;
            out[idx + 1] = bgG;
            out[idx + 2] = bgB;
            out[idx + 3] = 255;
          }
        }
      }

      cellX++;
    }

    return { width: safeW, height: safeH, data: out };
  }

  /**
   * 공용 헬퍼: WASM setSize(짝수 높이 보정) + renderToString(frame, 0, invertDark) + 픽셀 추출 일괄 수행.
   */
  public renderAndExtract(
    wasmModule: any,
    frame: number,
    width: number,
    height: number,
    invertDark = false,
  ): PixelFrame {
    const safeW = Number.isFinite(width) && width > 0 ? Math.max(2, Math.floor(width)) : 2;
    const evenH = Math.max(2, normalizeEvenHeight(height));
    wasmModule.setSize(safeW, evenH);
    const rawAnsi = wasmModule.renderToString(Math.max(0, Math.floor(frame)), 0, invertDark);
    return this.extractFromHalfBlockAnsi(rawAnsi, safeW, evenH);
  }
}
