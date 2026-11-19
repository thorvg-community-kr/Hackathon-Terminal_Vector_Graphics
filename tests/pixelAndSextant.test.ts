import React from 'react';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  normalizeEvenHeight,
  WasmPixelExtractor,
  type PixelFrame,
} from '../src/renderers/pixelExtractor.js';
import {
  renderPixelsToSextant,
  SEXTANT_LUT,
} from '../src/renderers/sextantRenderer.js';
import { realWasmModule } from '../src/realWasmModule.js';
import {
  getModePixelAspect,
  preprocessVectorData,
} from '../src/utils/vectorPreprocessor.js';
import { InteractiveMenu } from '../src/InteractiveMenu.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function measureNonSpaceSextantBoundingBox(ansi: string): {
  cols: number;
  rows: number;
} {
  let col = 0;
  let row = 0;
  let minCol = Infinity;
  let maxCol = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  let bg = -1;
  let i = 0;

  while (i < ansi.length) {
    const code = ansi.charCodeAt(i);
    if (code === 0x1b && ansi[i + 1] === '[') {
      const mIdx = ansi.indexOf('m', i + 2);
      if (mIdx !== -1) {
        const body = ansi.slice(i + 2, mIdx);
        if (body === '' || body === '0') {
          bg = -1;
        } else {
          const parts = body.split(';').map(Number);
          for (let p = 0; p < parts.length; p++) {
            if (parts[p] === 0) bg = -1;
            else if (parts[p] === 49) bg = -1;
            else if (parts[p] === 48 && parts[p + 1] === 2) {
              bg = (parts[p + 2] << 16) | (parts[p + 3] << 8) | parts[p + 4];
              p += 4;
            } else if (parts[p] === 38 && parts[p + 1] === 2) {
              p += 4;
            }
          }
        }
        i = mIdx + 1;
        continue;
      }
    }

    if (code === 0x0a) {
      row++;
      col = 0;
      i++;
      continue;
    }

    let isSpace = false;
    if (code === 0x20) {
      isSpace = true;
      i++;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < ansi.length) {
      i += 2;
    } else {
      i++;
    }

    if (!isSpace || bg !== -1) {
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
    }
    col++;
  }

  return {
    cols: maxCol >= minCol ? maxCol - minCol + 1 : 0,
    rows: maxRow >= minRow ? maxRow - minRow + 1 : 0,
  };
}

describe('Task 06: WasmPixelExtractor & Unicode Sextant (2x3) Renderer', () => {
  afterAll(() => {
    realWasmModule.destroy();
  });

  it('losslessly extracts RGBA pixels and alpha mask from real WASM Mode 0 output', async () => {
    await realWasmModule.init();

    const syntheticSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
      <rect x="2" y="2" width="14" height="14" fill="#E02040"/>
      <rect x="24" y="24" width="14" height="14" fill="#20C060"/>
    </svg>`;

    realWasmModule.setSize(40, 40);
    expect(realWasmModule.loadContent(syntheticSvg)).toBe(true);
    const extractor = new WasmPixelExtractor();
    const frame = extractor.renderAndExtract(realWasmModule, 0, 40, 40, false);

    expect(frame.width).toBe(40);
    expect(frame.height).toBe(40);
    expect(frame.data.length).toBe(40 * 40 * 4);

    // 좌상단 빨강 사각형 중심 (9, 9)
    const redIdx = (9 * 40 + 9) * 4;
    expect(frame.data[redIdx]).toBe(0xe0);
    expect(frame.data[redIdx + 1]).toBe(0x20);
    expect(frame.data[redIdx + 2]).toBe(0x40);
    expect(frame.data[redIdx + 3]).toBe(255);

    // 우하단 초록 사각형 중심 (31, 31)
    const greenIdx = (31 * 40 + 31) * 4;
    expect(frame.data[greenIdx]).toBe(0x20);
    expect(frame.data[greenIdx + 1]).toBe(0xc0);
    expect(frame.data[greenIdx + 2]).toBe(0x60);
    expect(frame.data[greenIdx + 3]).toBe(255);

    // 투명 여백 (38, 2) -> alpha === 0
    const bgIdx = (2 * 40 + 38) * 4;
    expect(frame.data[bgIdx]).toBe(0);
    expect(frame.data[bgIdx + 1]).toBe(0);
    expect(frame.data[bgIdx + 2]).toBe(0);
    expect(frame.data[bgIdx + 3]).toBe(0);
  });

  it('reuses internal Uint8Array buffer across frames (Zero-GC) and handles odd heights safely', () => {
    expect(normalizeEvenHeight(0)).toBe(0);
    expect(normalizeEvenHeight(-5)).toBe(0);
    expect(normalizeEvenHeight(Number.NaN)).toBe(0);
    expect(normalizeEvenHeight(15)).toBe(16);
    expect(normalizeEvenHeight(75)).toBe(76);
    expect(normalizeEvenHeight(80)).toBe(80);

    const extractor = new WasmPixelExtractor();
    const sampleAnsi = '\x1b[48;2;10;20;30m\x1b[38;2;40;50;60m▄'.repeat(20);

    const first = extractor.extractFromHalfBlockAnsi(sampleAnsi, 160, 120);
    const second = extractor.extractFromHalfBlockAnsi(sampleAnsi, 160, 120);
    const smaller = extractor.extractFromHalfBlockAnsi(sampleAnsi, 80, 60);

    expect(second.data.buffer).toBe(first.data.buffer);
    expect(smaller.data.buffer).toBe(first.data.buffer);
    expect(smaller.data.length).toBe(80 * 60 * 4);

    // 홀수 높이(height=15 -> 16) 방어 및 Sextant 행 수 Math.floor(16 / 3) === 5 확인
    const oddFrame = extractor.extractFromHalfBlockAnsi(sampleAnsi, 20, 15);
    expect(oddFrame.width).toBe(20);
    expect(oddFrame.height).toBe(16);
    expect(oddFrame.data.length).toBe(20 * 16 * 4);

    const sextantOut = renderPixelsToSextant(oddFrame, { background: 'dark' });
    expect(sextantOut.split('\n')).toHaveLength(5);

    // 임의의 홀수 터미널 행 수 R에 대해 floor(normalizeEvenHeight(3R) / 3) === R 항등식 검증
    for (let rows = 1; rows <= 65; rows++) {
      expect(Math.floor(normalizeEvenHeight(rows * 3) / 3)).toBe(rows);
    }
  });

  it('defines an exact frozen 64-entry Unicode 13.0 SEXTANT_LUT with all 4 legacy exceptions', () => {
    expect(SEXTANT_LUT).toHaveLength(64);
    expect(Object.isFrozen(SEXTANT_LUT)).toBe(true);
    expect(new Set(SEXTANT_LUT).size).toBe(64);

    expect(SEXTANT_LUT[0]).toBe(' ');
    expect(SEXTANT_LUT[21]).toBe('▌');
    expect(SEXTANT_LUT[42]).toBe('▐');
    expect(SEXTANT_LUT[63]).toBe('█');

    const legacyCodepoints: number[] = [];
    for (let mask = 0; mask < 64; mask++) {
      const ch = SEXTANT_LUT[mask];
      expect(Array.from(ch)).toHaveLength(1);
      if (mask !== 0 && mask !== 21 && mask !== 42 && mask !== 63) {
        legacyCodepoints.push(ch.codePointAt(0)!);
      }
    }

    expect(legacyCodepoints).toHaveLength(60);
    for (let idx = 0; idx < 60; idx++) {
      expect(legacyCodepoints[idx]).toBe(0x1fb00 + idx);
    }
  });

  it('removes solid-color seams (<15 dist), applies presets, and preserves 1:1 physical aspect via pixelAspectX=4/3', async () => {
    // 1. 색차 < 15 단색 셀 -> Sextant 글리프 대신 공백 ' ' + 평균 배경색 출력 (Seam 제거)
    const solidData = new Uint8Array(2 * 3 * 4);
    for (let k = 0; k < 6; k++) {
      const off = k * 4;
      solidData[off] = 100 + (k % 2) * 3;
      solidData[off + 1] = 150 + (k % 2) * 2;
      solidData[off + 2] = 200;
      solidData[off + 3] = 255;
    }
    const solidFrame: PixelFrame = { width: 2, height: 3, data: solidData };
    const solidAnsi = renderPixelsToSextant(solidFrame);
    expect(solidAnsi).toContain('\x1b[48;2;');
    expect(solidAnsi.endsWith(' \x1b[0m')).toBe(true);

    // 2. 좌측 절반(bit 0,2,4 = mask 21 -> '▌') 패턴 + 배경 프리셋('transparent', 'dark', 'light', 'checkerboard')
    const leftHalfData = new Uint8Array(4 * 3 * 4);
    for (let ty = 0; ty < 3; ty++) {
      const off = (ty * 4 + 0) * 4; // 첫 번째 셀 좌측 열만 불투명 빨강
      leftHalfData[off] = 240;
      leftHalfData[off + 1] = 30;
      leftHalfData[off + 2] = 50;
      leftHalfData[off + 3] = 255;
    }
    const leftHalfFrame: PixelFrame = { width: 4, height: 3, data: leftHalfData };

    const transOut = renderPixelsToSextant(leftHalfFrame, { background: 'transparent' });
    expect(transOut).toContain('▌');
    expect(transOut).not.toContain('48;2;0;0;0');

    const darkOut = renderPixelsToSextant(leftHalfFrame, { background: 'dark' });
    expect(darkOut).toContain('24;24;37m');
    expect(darkOut).toContain('▌');

    const lightOut = renderPixelsToSextant(leftHalfFrame, { background: 'light' });
    expect(lightOut).toContain('245;245;247m');

    const checkerOut = renderPixelsToSextant(leftHalfFrame, { background: 'checkerboard' });
    expect(checkerOut).toContain('42;42;55m');
    expect(checkerOut).toContain('30;30;40m');

    // 3. 100x100 정사각형 SVG -> 80x40 터미널 (160x120 px) + pixelAspectX=4/3 => 물리 1:1 정방형
    await realWasmModule.init();
    const squareSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
      <rect x="10" y="10" width="80" height="80" fill="#ff4422"/>
    </svg>`;
    const aspect = getModePixelAspect('sextant');
    expect(aspect.pixelAspectX).toBeCloseTo(4 / 3, 6);

    const processedSvg = preprocessVectorData(squareSvg, 'svg', aspect);
    realWasmModule.setSize(160, 120);
    expect(realWasmModule.loadContent(processedSvg)).toBe(true);

    const extractor = new WasmPixelExtractor();
    const pxFrame = extractor.renderAndExtract(realWasmModule, 0, 160, 120, false);
    const sextantArt = renderPixelsToSextant(pxFrame, { background: 'transparent' });
    const box = measureNonSpaceSextantBoundingBox(sextantArt);

    expect(box.cols).toBeGreaterThan(30);
    expect(box.rows).toBeGreaterThan(15);
    expect(Math.abs(box.cols - box.rows * 2)).toBeLessThanOrEqual(2);
  });

  it('cycles M key through quadrant -> sextant -> braille -> half-block -> quadrant in InteractiveMenu', async () => {
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream & PassThrough;
    (stdout as any).columns = 100;
    (stdout as any).rows = 40;
    (stdout as any).isTTY = true;

    const stdin = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
    (stdin as any).isTTY = true;
    (stdin as any).setRawMode = vi.fn();
    (stdin as any).ref = vi.fn();
    (stdin as any).unref = vi.fn();

    const chunks: string[] = [];
    stdout.on('data', (c: Buffer | string) => chunks.push(c.toString('utf8')));

    const mockWasm = {
      init: vi.fn(async () => {}),
      setSize: vi.fn(),
      load: vi.fn(() => true),
      loadContent: vi.fn(() => true),
      getTotalFrames: vi.fn(() => 0),
      getDuration: vi.fn(() => 0),
      renderToString: vi.fn(() => ''),
      destroy: vi.fn(),
    };

    const inst = render(
      React.createElement(InteractiveMenu, {
        wasmModule: mockWasm,
        initialPath: path.join(REPO_ROOT, 'assets'),
        initialDepth: 0,
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    const waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await waitMs(60);
    expect(chunks[chunks.length - 1]).toContain('quadrant(M)');

    stdin.write('m');
    await waitMs(30);
    expect(chunks[chunks.length - 1]).toContain('sextant(M)');

    stdin.write('m');
    await waitMs(30);
    expect(chunks[chunks.length - 1]).toContain('braille(M)');

    stdin.write('m');
    await waitMs(30);
    expect(chunks[chunks.length - 1]).toContain('half-block(M)');

    stdin.write('m');
    await waitMs(30);
    expect(chunks[chunks.length - 1]).toContain('quadrant(M)');

    stdin.write('q');
    await inst.waitUntilExit();
  });

  it('extracts and converts 160x120 and 200x200 real WASM frames in < 10ms on average', async () => {
    await realWasmModule.init();
    const assetPath = path.join(REPO_ROOT, 'assets/5317-fireworkds.json');
    const extractor = new WasmPixelExtractor();

    for (const [w, h] of [
      [160, 120],
      [200, 200],
    ] as const) {
      realWasmModule.setSize(w, h);
      expect(realWasmModule.load(assetPath)).toBe(true);
      const rawMode0 = realWasmModule.renderToString(30, 0, false);

      // JIT 워밍업
      for (let i = 0; i < 10; i++) {
        const pf = extractor.extractFromHalfBlockAnsi(rawMode0, w, h);
        renderPixelsToSextant(pf, { background: 'transparent', optimizeRle: true });
      }

      const iterations = 20;
      const t0 = performance.now();
      for (let i = 0; i < iterations; i++) {
        const pf = extractor.extractFromHalfBlockAnsi(rawMode0, w, h);
        renderPixelsToSextant(pf, { background: 'transparent', optimizeRle: true });
      }
      const avgMs = (performance.now() - t0) / iterations;
      expect(avgMs).toBeLessThan(10.0);
    }
  });
});
