import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { realWasmModule } from '../src/realWasmModule.js';
import {
  clampViewport,
  clearVectorPreprocessorCache,
  panViewport,
  preprocessVectorData,
  stepZoom,
  ZOOM_STEPS,
} from '../src/utils/vectorPreprocessor.js';
import {
  useAnimationLoop,
  type AnimationConfig,
  type AnimationControls,
} from '../src/hooks/useAnimationLoop.js';
import { InteractiveMenu } from '../src/InteractiveMenu.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function measureForegroundBoundingBox(rawAnsi: string): {
  cols: number;
  rows: number;
} {
  let fg = -1;
  let bg = -1;
  let col = 0;
  let row = 0;
  let minCol = Infinity;
  let maxCol = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  let i = 0;

  while (i < rawAnsi.length) {
    const code = rawAnsi.charCodeAt(i);
    if (code === 0x1b && rawAnsi[i + 1] === '[') {
      const mIdx = rawAnsi.indexOf('m', i + 2);
      if (mIdx !== -1) {
        const body = rawAnsi.slice(i + 2, mIdx);
        if (body === '' || body === '0') {
          fg = -1;
          bg = -1;
        } else {
          const parts = body.split(';').map(Number);
          for (let p = 0; p < parts.length; p++) {
            const c = parts[p];
            if (c === 0) {
              fg = -1;
              bg = -1;
            } else if (c === 39) {
              fg = -1;
            } else if (c === 49) {
              bg = -1;
            } else if (c === 38 && parts[p + 1] === 2) {
              fg = (parts[p + 2] << 16) | (parts[p + 3] << 8) | parts[p + 4];
              p += 4;
            } else if (c === 48 && parts[p + 1] === 2) {
              bg = (parts[p + 2] << 16) | (parts[p + 3] << 8) | parts[p + 4];
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

    const ch = rawAnsi[i];
    i++;

    const hasVisibleBg = bg !== -1 && bg !== 0x000000;
    const hasVisibleFg = ch !== ' ' && fg !== 0x000000;
    if (hasVisibleBg || hasVisibleFg) {
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

function createMockTerminalStreams(cols = 110, rows = 36) {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & PassThrough;
  (stdout as any).columns = cols;
  (stdout as any).rows = rows;
  (stdout as any).isTTY = true;

  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
  (stdin as any).isTTY = true;
  (stdin as any).setRawMode = vi.fn();
  (stdin as any).ref = vi.fn();
  (stdin as any).unref = vi.fn();

  const chunks: string[] = [];
  stdout.on('data', (chunk: Buffer | string) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });

  return {
    stdout,
    stdin,
    chunks,
    getOutput: () => chunks.join(''),
    getLatestChunk: () => chunks[chunks.length - 1] ?? '',
  };
}

const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CENTER_CIRCLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="8" fill="#ff3355"/>
</svg>`;

const CENTER_CIRCLE_LOTTIE = JSON.stringify({
  v: '5.7.4',
  fr: 30,
  ip: 0,
  op: 60,
  w: 100,
  h: 100,
  nm: 'SmallCenterCircle',
  ddd: 0,
  assets: [],
  layers: [
    {
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: 'Circle',
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [50, 50, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: { a: 0, k: [100, 100, 100] },
      },
      ao: 0,
      shapes: [
        {
          ty: 'gr',
          it: [
            { ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [16, 16] } },
            { ty: 'fl', c: { a: 0, k: [1, 0.2, 0.35, 1] }, o: { a: 0, k: 100 } },
            {
              ty: 'tr',
              p: { a: 0, k: [0, 0] },
              a: { a: 0, k: [0, 0] },
              s: { a: 0, k: [100, 100] },
              r: { a: 0, k: 0 },
              o: { a: 0, k: 100 },
            },
          ],
        },
      ],
      ip: 0,
      op: 60,
      st: 0,
    },
  ],
});

const LoopHarness: React.FC<{
  config: AnimationConfig;
  controlsRef: { current: AnimationControls | null };
}> = ({ config, controlsRef }) => {
  controlsRef.current = useAnimationLoop(config);
  return null;
};

describe('Task 08: Lossless Vector Zoom (1x-8x) & Viewport Panning', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    clearVectorPreprocessorCache();
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    realWasmModule.destroy();
  });

  it('losslessly scales SVG and Lottie circle diameter ~4x at zoom=4.0 inside real WASM without errors', async () => {
    await realWasmModule.init();
    realWasmModule.setSize(100, 100);

    for (const fixture of [
      { label: 'SVG', raw: CENTER_CIRCLE_SVG, format: 'svg' as const },
      { label: 'Lottie', raw: CENTER_CIRCLE_LOTTIE, format: 'lottie' as const },
    ]) {
      const proc1x = preprocessVectorData(fixture.raw, fixture.format, {
        pixelAspectX: 1,
        pixelAspectY: 1,
        zoom: 1.0,
      });
      expect(realWasmModule.loadContent(proc1x)).toBe(true);
      const box1x = measureForegroundBoundingBox(realWasmModule.renderToString(0, 0, false));

      const proc4x = preprocessVectorData(fixture.raw, fixture.format, {
        pixelAspectX: 1,
        pixelAspectY: 1,
        zoom: 4.0,
      });
      expect(realWasmModule.loadContent(proc4x)).toBe(true);
      const box4x = measureForegroundBoundingBox(realWasmModule.renderToString(0, 0, false));

      // 100x100 캔버스(50셀 높이)에서 r=8(지름 16) -> 1.0x: ~16 cols, 4.0x: ~64 cols (정확히 ~4배)
      expect(box1x.cols).toBeGreaterThanOrEqual(14);
      expect(box1x.cols).toBeLessThanOrEqual(18);
      expect(box4x.cols).toBeGreaterThanOrEqual(60);
      expect(box4x.cols).toBeLessThanOrEqual(68);
      expect(Math.abs(box4x.cols - box1x.cols * 4)).toBeLessThanOrEqual(4);
      expect(Math.abs(box4x.rows - box1x.rows * 4)).toBeLessThanOrEqual(2);

      // 8.0x 최대 배율 로드 안정성 검증
      const proc8x = preprocessVectorData(fixture.raw, fixture.format, { zoom: 8.0 });
      expect(realWasmModule.loadContent(proc8x)).toBe(true);
      expect(realWasmModule.renderToString(0, 0, false).length).toBeGreaterThan(0);
    }
  });

  it('clamps panX/panY to (0, 0) at 1.0x and strictly within +-(1 - 1/zoom) during repeated panning', () => {
    expect(clampViewport(1.0, 0.8, -0.5)).toEqual({ zoom: 1.0, panX: 0, panY: 0 });
    expect(clampViewport(0.25, 0.9, 0.9)).toEqual({ zoom: 1.0, panX: 0, panY: 0 });
    expect(clampViewport(12.0, 2.0, -2.0)).toEqual({
      zoom: 8.0,
      panX: 0.875,
      panY: -0.875,
    });

    // ZOOM_STEPS 순방향/역방향 이동 검증
    let z = 1.0;
    const walkedUp = [z];
    for (let i = 0; i < ZOOM_STEPS.length + 2; i++) {
      z = stepZoom(z, 1);
      walkedUp.push(z);
    }
    expect(walkedUp.slice(0, ZOOM_STEPS.length)).toEqual([...ZOOM_STEPS]);
    expect(z).toBe(8.0);
    for (let i = 0; i < ZOOM_STEPS.length + 2; i++) {
      z = stepZoom(z, -1);
    }
    expect(z).toBe(1.0);

    // 1.0x에서는 panViewport도 (0, 0) 고정
    expect(panViewport({ zoom: 1.0, panX: 0.4, panY: -0.4 }, 1, 1)).toEqual({
      zoom: 1.0,
      panX: 0,
      panY: 0,
    });

    // 2.0x에서 20회 연속 우/하단, 좌/상단 패닝 경계(+-0.5) 검증
    let vp = { zoom: 2.0, panX: 0, panY: 0 };
    for (let i = 0; i < 20; i++) {
      vp = panViewport(vp, 1, 1);
    }
    expect(vp.panX).toBe(0.5);
    expect(vp.panY).toBe(0.5);

    for (let i = 0; i < 20; i++) {
      vp = panViewport(vp, -1, -1);
    }
    expect(vp.panX).toBe(-0.5);
    expect(vp.panY).toBe(-0.5);

    // SVG 및 Lottie 변환 좌표 검증
    const pannedSvg = preprocessVectorData(CENTER_CIRCLE_SVG, 'svg', {
      zoom: 2.0,
      panX: 0.5,
      panY: -0.5,
    });
    expect(pannedSvg).toContain('width="50" height="50" viewBox="0 0 50 50"');
    expect(pannedSvg).toContain('translate(-50, 0)');

    const pannedLottie = JSON.parse(
      preprocessVectorData(CENTER_CIRCLE_LOTTIE, 'lottie', {
        zoom: 2.0,
        panX: 0.5,
        panY: -0.5,
      }),
    );
    expect(pannedLottie.layers[0].ks.a.k).toEqual([75, 25, 0]);
    expect(pannedLottie.layers[0].ks.s.k).toEqual([200, 200, 100]);
  });

  it('preserves current frame (60) and active burst frame (30) without resetting to 0 when zooming while paused', async () => {
    await realWasmModule.init();
    const fireworkPath = path.join(REPO_ROOT, 'assets/5317-fireworkds.json');
    const controlsRef = { current: null as AnimationControls | null };
    const reportedFrames: Array<{ ansi: string; frame: number; total: number }> = [];
    const reportedMeta: Array<{ frame: number; total: number }> = [];
    let resolveLoad: (() => void) | null = null;
    const loadedPromise = new Promise<void>((res) => {
      resolveLoad = res;
    });

    const makeConfig = (zoom: number): AnimationConfig => ({
      wasmModule: realWasmModule,
      filePath: fireworkPath,
      pixelWidth: 80,
      pixelHeight: 40,
      modeInt: 1,
      invertDark: false,
      transformOptions: { pixelAspectX: 2.0, pixelAspectY: 1.0, zoom, panX: 0, panY: 0 },
      loop: true,
      paused: true,
      onLoad: () => {
        resolveLoad?.();
      },
      onFrame: (ansi, frame, total) => {
        reportedFrames.push({ ansi, frame, total });
      },
      onMetaUpdate: (frame, total) => {
        reportedMeta.push({ frame, total });
      },
    });

    const { stdout, stdin } = createMockTerminalStreams();
    const inst = render(
      React.createElement(LoopHarness, { config: makeConfig(1.0), controlsRef }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await loadedPromise;
    await waitMs(20);
    expect(controlsRef.current).not.toBeNull();

    // 1. 프레임 30 (폭죽 활성 프레임)에서 줌 1.0 -> 2.0 전환 시 프레임 30 유지 + ANSI 출력 변화 검증
    // totalFrames = 150, step = 150 / 30 = 5 -> seek(6) => frame 30
    controlsRef.current!.seek(6);
    await waitMs(30);
    const before30 = reportedFrames[reportedFrames.length - 1];
    expect(before30.total).toBe(150);
    expect(before30.frame).toBe(30);

    reportedFrames.length = 0;
    inst.rerender(
      React.createElement(LoopHarness, { config: makeConfig(2.0), controlsRef }),
    );
    await waitMs(60);
    const after30 = reportedFrames[reportedFrames.length - 1];
    expect(after30.frame).toBe(30);
    expect(after30.ansi).not.toBe(before30.ansi);

    // 2. 프레임 60 (seek(+6) 추가)에서 줌 2.0 -> 3.0 전환 시 onFrame 보고 프레임이 60 그대로 유지됨을 검증
    controlsRef.current!.seek(6);
    await waitMs(30);
    expect(reportedMeta[reportedMeta.length - 1].frame).toBe(60);

    reportedFrames.length = 0;
    inst.rerender(
      React.createElement(LoopHarness, { config: makeConfig(3.0), controlsRef }),
    );
    await waitMs(60);
    expect(reportedFrames.length).toBeGreaterThanOrEqual(1);
    expect(reportedFrames[reportedFrames.length - 1].frame).toBe(60);

    inst.unmount();
  });

  it('hits bounded LRU AST cache so JSON.parse runs only once across 10 zoom/pan updates', () => {
    clearVectorPreprocessorCache();
    const parseSpy = vi.spyOn(JSON, 'parse');

    for (let i = 0; i < 10; i++) {
      const z = 1.5 + i * 0.5;
      const px = ((i % 5) - 2) * 0.1;
      const py = (((i + 2) % 5) - 2) * 0.1;
      const out = preprocessVectorData(CENTER_CIRCLE_LOTTIE, 'lottie', {
        pixelAspectX: 2,
        zoom: z,
        panX: px,
        panY: py,
      });
      expect(out).toContain('"TermVGTransformWrapper"');
    }

    expect(parseSpy).toHaveBeenCalledTimes(1);

    // 4개 초과(5번째) 서로 다른 Lottie JSON 주입 시 LRU 퇴출 동작 검증
    for (let k = 1; k <= 4; k++) {
      const other = CENTER_CIRCLE_LOTTIE.replace('SmallCenterCircle', `Other_${k}`);
      preprocessVectorData(other, 'lottie', { zoom: 2.0 });
    }
    expect(parseSpy).toHaveBeenCalledTimes(5);

    // 최초 항목은 LRU 퇴출되었으므로 재호출 시 다시 1회 파싱
    preprocessVectorData(CENTER_CIRCLE_LOTTIE, 'lottie', { zoom: 3.0 });
    expect(parseSpy).toHaveBeenCalledTimes(6);
  });

  it('wires +, -, 0, modal H/J/K/L pan vs L search, HUD badge, and file-switch reset in InteractiveMenu', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termvg-zoom-tui-'));
    tempDirs.push(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a-circle.svg'), CENTER_CIRCLE_SVG, 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, 'b-rect.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect x="10" y="10" width="60" height="60" fill="#00cc88"/></svg>',
      'utf8',
    );

    const { stdout, stdin, getLatestChunk } = createMockTerminalStreams(110, 36);
    const inst = render(
      React.createElement(InteractiveMenu, {
        wasmModule: realWasmModule,
        initialPath: tmpDir,
        initialDepth: 0,
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await waitMs(120);
    expect(getLatestChunk()).toContain('Name: a-circle.svg');
    expect(getLatestChunk()).not.toContain('HJKL:Pan');

    // 1. zoom === 1.0일 때 'L' 키는 LottieFiles MCP 검색을 연다
    stdin.write('l');
    await waitMs(40);
    expect(getLatestChunk()).toContain('LottieFiles 검색');
    stdin.write('\x1b');
    await waitMs(60);

    // 2. '+' 두 번 입력 -> 1.0x -> 1.5x -> 2.0x 배지 노출 및 H/J/K/L 패닝(L 검색 미오픈)
    stdin.write('+');
    await waitMs(40);
    expect(getLatestChunk()).toContain('1.5x (HJKL:Pan 0:Reset)');

    stdin.write('=');
    await waitMs(40);
    expect(getLatestChunk()).toContain('2.0x (HJKL:Pan 0:Reset)');

    stdin.write('l');
    stdin.write('h');
    stdin.write('j');
    stdin.write('k');
    await waitMs(50);
    expect(getLatestChunk()).not.toContain('LottieFiles 검색');
    expect(getLatestChunk()).toContain('2.0x (HJKL:Pan 0:Reset)');

    // 3. '0' 키로 리셋 시 배지 제거 및 L 검색 복귀
    stdin.write('0');
    await waitMs(40);
    expect(getLatestChunk()).not.toContain('HJKL:Pan');

    stdin.write('l');
    await waitMs(40);
    expect(getLatestChunk()).toContain('LottieFiles 검색');
    stdin.write('\x1b');
    await waitMs(60);

    // 4. 확대 후 다른 파일로 전환(↓) 시 자동 1.0x 리셋
    stdin.write('+');
    await waitMs(40);
    expect(getLatestChunk()).toContain('1.5x (HJKL:Pan 0:Reset)');

    stdin.write('\x1b[B'); // Arrow Down
    await waitMs(80);
    expect(getLatestChunk()).toContain('Name: b-rect.svg');
    expect(getLatestChunk()).not.toContain('HJKL:Pan');

    stdin.write('q');
    await inst.waitUntilExit();
  });
});
