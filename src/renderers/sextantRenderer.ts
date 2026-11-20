import type { PixelFrame } from './pixelExtractor.js';
import {
  COLOR_DEFAULT,
  formatBgSgr,
  formatFgSgr,
  resolvePresetBg,
  type BackgroundPreset,
  type PostProcessOptions,
} from '../utils/ansiPostProcessor.js';

function packAvgRgb(sumR: number, sumG: number, sumB: number, count: number): number {
  return (
    (Math.round(sumR / count) << 16) |
    (Math.round(sumG / count) << 8) |
    Math.round(sumB / count)
  );
}

/**
 * Unicode 13.0 Symbols for Legacy Computing (U+1FB00..U+1FB3B) 기반
 * 2x3 서브픽셀 64-패턴 불변 룩업 테이블.
 *
 * - 비트 레이아웃: top-left(1), top-right(2), mid-left(4), mid-right(8), bot-left(16), bot-right(32)
 * - 기존 ASCII/Block Elements와 중복되는 4개 예외 패턴(0: ' ', 21: '▌', 42: '▐', 63: '█')을 건너뛰는
 *   비연속 코드포인트 테이블을 정확히 매핑한다.
 */
export const SEXTANT_LUT: readonly string[] = Object.freeze(
  Array.from({ length: 64 }, (_, mask) => {
    if (mask === 0) return ' ';
    if (mask <= 20) return String.fromCodePoint(0x1fb00 + mask - 1);
    if (mask === 21) return '▌';
    if (mask <= 41) return String.fromCodePoint(0x1fb00 + mask - 2);
    if (mask === 42) return '▐';
    if (mask <= 62) return String.fromCodePoint(0x1fb00 + mask - 3);
    return '█';
  }),
);

/**
 * RGBA PixelFrame을 2x3 Unicode Sextant 트루컬러 ANSI 문자열로 변환한다.
 * - 6개 서브픽셀 Luma 극점 기반 2-클러스터 평균 양자화
 * - 색차 < 15 단색 셀을 ' ' + 배경색으로 치환해 폰트 경계 심(Seam) 줄무늬 제거
 * - 투명 배경(\x1b[49m) 및 테마 프리셋('dark' | 'light' | 'checkerboard') + 행 단위 RLE 적용
 */
export function renderPixelsToSextant(frame: PixelFrame, options?: PostProcessOptions): string {
  const width = Math.floor(frame.width);
  const height = Math.floor(frame.height);
  const cols = Math.floor(width / 2);
  const rows = Math.floor(height / 3);

  if (cols <= 0 || rows <= 0 || frame.data.length < width * height * 4) {
    return '';
  }

  const data = frame.data;
  const background: BackgroundPreset = options?.background ?? 'transparent';
  const optimizeRle = options?.optimizeRle ?? true;
  const isTransparent = background === 'transparent';

  // 핫 루프 내 힙 할당을 막기 위한 고정 6-슬롯 스칼라 버퍼
  const subR = new Int32Array(6);
  const subG = new Int32Array(6);
  const subB = new Int32Array(6);
  const subA = new Uint8Array(6);

  let out = '';

  for (let ty = 0; ty < rows; ty++) {
    let outBg = COLOR_DEFAULT;
    let outFg = COLOR_DEFAULT;
    const pyBase = ty * 3;

    for (let tx = 0; tx < cols; tx++) {
      const pxBase = tx * 2;
      let opaqueCount = 0;

      // 2x3 서브픽셀 추출 (row-major: bit 0..5)
      for (let dy = 0; dy < 3; dy++) {
        const rowOffset = (pyBase + dy) * width;
        for (let dx = 0; dx < 2; dx++) {
          const k = dy * 2 + dx;
          const idx = (rowOffset + pxBase + dx) * 4;
          const alpha = data[idx + 3];
          subA[k] = alpha;
          if (alpha > 0) {
            subR[k] = data[idx];
            subG[k] = data[idx + 1];
            subB[k] = data[idx + 2];
            opaqueCount++;
          } else {
            subR[k] = 0;
            subG[k] = 0;
            subB[k] = 0;
          }
        }
      }

      let targetChar: string;
      let targetIsSpace = false;
      let targetBg: number;
      let targetFg = outFg;

      if (opaqueCount === 0) {
        targetChar = ' ';
        targetIsSpace = true;
        targetBg = resolvePresetBg(background, tx, ty);
      } else if (isTransparent && opaqueCount < 6) {
        // 투명 모드 경계 셀: 불투명 서브픽셀만 전경 마스크로 묶고 배경은 터미널 투명(\x1b[49m) 유지
        let pattern = 0;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        for (let k = 0; k < 6; k++) {
          if (subA[k] > 0) {
            pattern |= 1 << k;
            sumR += subR[k];
            sumG += subG[k];
            sumB += subB[k];
          }
        }
        targetChar = SEXTANT_LUT[pattern];
        targetBg = COLOR_DEFAULT;
        targetFg = packAvgRgb(sumR, sumG, sumB, opaqueCount);
      } else {
        // 불투명 테마 프리셋 합성 시 투명 서브픽셀을 먼저 프리셋 배경 RGB로 치환
        if (!isTransparent && opaqueCount < 6) {
          const presetRgb = resolvePresetBg(background, tx, ty);
          const pr = (presetRgb >>> 16) & 0xff;
          const pg = (presetRgb >>> 8) & 0xff;
          const pb = presetRgb & 0xff;
          for (let k = 0; k < 6; k++) {
            if (subA[k] === 0) {
              subR[k] = pr;
              subG[k] = pg;
              subB[k] = pb;
            }
          }
        }

        let minLuma = 0x7fffffff;
        let maxLuma = -1;
        let bgSeedIdx = 0;
        let fgSeedIdx = 0;
        let sumAllR = 0;
        let sumAllG = 0;
        let sumAllB = 0;

        for (let k = 0; k < 6; k++) {
          const r = subR[k];
          const g = subG[k];
          const b = subB[k];
          sumAllR += r;
          sumAllG += g;
          sumAllB += b;

          const luma = 299 * r + 587 * g + 114 * b;
          if (luma < minLuma) {
            minLuma = luma;
            bgSeedIdx = k;
          }
          if (luma > maxLuma) {
            maxLuma = luma;
            fgSeedIdx = k;
          }
        }

        const bgSeedR = subR[bgSeedIdx];
        const bgSeedG = subG[bgSeedIdx];
        const bgSeedB = subB[bgSeedIdx];
        const fgSeedR = subR[fgSeedIdx];
        const fgSeedG = subG[fgSeedIdx];
        const fgSeedB = subB[fgSeedIdx];

        const colorDist =
          Math.abs(fgSeedR - bgSeedR) +
          Math.abs(fgSeedG - bgSeedG) +
          Math.abs(fgSeedB - bgSeedB);

        if (colorDist < 15) {
          // 단색 최적화: 6픽셀 평균 배경색 + 공백으로 폰트 경계 심(Seam) 제거
          targetChar = ' ';
          targetIsSpace = true;
          targetBg = packAvgRgb(sumAllR, sumAllG, sumAllB, 6);
        } else {
          let pattern = 0;
          let fgSumR = 0;
          let fgSumG = 0;
          let fgSumB = 0;
          let fgCount = 0;
          let bgSumR = 0;
          let bgSumG = 0;
          let bgSumB = 0;
          let bgCount = 0;

          for (let k = 0; k < 6; k++) {
            const r = subR[k];
            const g = subG[k];
            const b = subB[k];
            const dFg = Math.abs(r - fgSeedR) + Math.abs(g - fgSeedG) + Math.abs(b - fgSeedB);
            const dBg = Math.abs(r - bgSeedR) + Math.abs(g - bgSeedG) + Math.abs(b - bgSeedB);

            if (dFg <= dBg) {
              pattern |= 1 << k;
              fgSumR += r;
              fgSumG += g;
              fgSumB += b;
              fgCount++;
            } else {
              bgSumR += r;
              bgSumG += g;
              bgSumB += b;
              bgCount++;
            }
          }

          if (bgCount === 0 || fgCount === 0) {
            targetChar = ' ';
            targetIsSpace = true;
            targetBg = bgCount === 0
              ? packAvgRgb(fgSumR, fgSumG, fgSumB, fgCount)
              : packAvgRgb(bgSumR, bgSumG, bgSumB, bgCount);
          } else {
            targetChar = SEXTANT_LUT[pattern];
            targetBg = packAvgRgb(bgSumR, bgSumG, bgSumB, bgCount);
            targetFg = packAvgRgb(fgSumR, fgSumG, fgSumB, fgCount);
          }
        }
      }

      if (!optimizeRle || targetBg !== outBg) {
        out += formatBgSgr(targetBg);
        outBg = targetBg;
      }
      if (!targetIsSpace && (!optimizeRle || targetFg !== outFg)) {
        out += formatFgSgr(targetFg);
        outFg = targetFg;
      }

      out += targetChar;
    }

    if (outBg !== COLOR_DEFAULT || outFg !== COLOR_DEFAULT) {
      out += '\x1b[0m';
    }
    if (ty < rows - 1) {
      out += '\n';
    }
  }

  return out;
}
