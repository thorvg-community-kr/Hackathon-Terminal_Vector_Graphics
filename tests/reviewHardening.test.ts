import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postProcessAnsiFrame, remapPureBlackForeground } from '../src/utils/ansiPostProcessor.js';
import { preprocessVectorData } from '../src/utils/vectorPreprocessor.js';
import { isLikelyLottieHead, scanDirectoryAsync, JSON_HEAD_BYTES } from '../src/hooks/useFileScanner.js';
import { calcPixelSize } from '../src/LottiePlayer.js';
import { InteractiveMenu } from '../src/InteractiveMenu.js';
import {
  useAnimationLoop,
  type AnimationConfig,
  type AnimationControls,
} from '../src/hooks/useAnimationLoop.js';

const FG_RED = '\x1b[38;2;255;0;0m';

function streams() {
  const stdout = new PassThrough() as any;
  stdout.columns = 100;
  stdout.rows = 40;
  stdout.isTTY = true;
  const stdin = new PassThrough() as any;
  stdin.isTTY = true;
  stdin.setRawMode = vi.fn();
  stdin.ref = vi.fn();
  stdin.unref = vi.fn();
  return { stdout, stdin };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

const Harness: React.FC<{ config: AnimationConfig; ref_: { current: AnimationControls | null } }> = ({
  config,
  ref_,
}) => {
  ref_.current = useAnimationLoop(config);
  return null;
};

function mockWasm(totalFrames = 30, duration = 1) {
  return {
    init: async () => {},
    setSize: () => {},
    getTotalFrames: () => totalFrames,
    getDuration: () => duration,
  };
}

function mount(config: Partial<AnimationConfig>) {
  const ref_ = { current: null as AnimationControls | null };
  const full: AnimationConfig = {
    wasmModule: mockWasm(),
    filePath: 'mock.json',
    pixelWidth: 32,
    pixelHeight: 16,
    modeInt: 1,
    invertDark: false,
    loop: true,
    paused: false,
    loadAsset: () => true,
    renderFrame: (f) => `frame-${f}`,
    onFrame: vi.fn(),
    ...config,
  };
  const { stdout, stdin } = streams();
  const inst = render(React.createElement(Harness, { config: full, ref_ }), {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return { inst, ref_, cfg: full };
}

describe('Task 14: Review hardening regressions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // review_a #1/#2
  it('invalidates RLE state and resets line after passthrough SGR', () => {
    const out = postProcessAnsiFrame(`${FG_RED}A\x1b[0;1m${FG_RED}B`);
    // 통과된 \x1b[0;1m 뒤에도 fg SGR이 다시 출력되어야 한다
    const afterPass = out.slice(out.indexOf('\x1b[0;1m'));
    expect(afterPass).toContain(FG_RED);

    const lines = postProcessAnsiFrame('\x1b[1mX\nY\x1b[1m').split('\n');
    expect(lines[0].endsWith('\x1b[0m')).toBe(true);
    expect(lines[1].endsWith('\x1b[0m')).toBe(true);
  });

  // review_a #3
  it('invalidates RLE state after colon-separated SGR', () => {
    const out = postProcessAnsiFrame(`${FG_RED}A\x1b[38:2::0:255:0m${FG_RED}B`);
    expect(out.slice(out.indexOf('\x1b[38:2::0:255:0m'))).toContain(FG_RED);
  });

  // review_a #7
  it('keeps url(#000) id references intact when remapping pure black', () => {
    const svg = '<svg><rect fill="url(#000)" stroke="#000"/></svg>';
    const out = remapPureBlackForeground(svg, 'svg');
    expect(out).toContain('url(#000)');
    expect(out).toContain('stroke="#020202"');
  });

  // review_a #5/#6
  it('strips DOCTYPE with internal subset and ignores <svg inside leading comments', () => {
    const svg =
      '<?xml version="1.0"?><!DOCTYPE svg [ <!ENTITY a "x"> ]>' +
      '<!-- <svg width="1" height="1"> --><svg width="10" height="10"><rect/></svg>';
    const out = preprocessVectorData(svg, 'svg', { pixelAspectX: 2 });
    expect(out).not.toContain('DOCTYPE');
    expect(out).not.toContain(']>');
    expect(out).toContain('<svg width="20" height="10"');

    const identity = preprocessVectorData(svg, 'svg', { pixelAspectX: 1, pixelAspectY: 1 });
    expect(identity).not.toContain('DOCTYPE');
  });

  // review_b #3
  it('classifies large JSON by head chunk only', async () => {
    expect(isLikelyLottieHead('{"v":"5.7","fr":30,"ip":0,"op":60,"assets":[')).toBe(true);
    expect(isLikelyLottieHead('{"users":[1,2,3]')).toBe(false);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termvg-head-'));
    try {
      const pad = 'x'.repeat(JSON_HEAD_BYTES);
      fs.writeFileSync(path.join(dir, 'big.json'), `{"v":"5.7","fr":30,"op":60,"assets":[{"p":"${pad}"}],"layers":[]}`);
      fs.writeFileSync(path.join(dir, 'data.json'), `{"rows":["${pad}"]}`);
      const readSpy = vi.spyOn(fs.promises, 'readFile');
      const items = await scanDirectoryAsync(dir, { maxDepth: 1 });
      const names = items.map((i) => path.basename(i.value));
      expect(names).toContain('big.json');
      expect(names).not.toContain('data.json');
      expect(readSpy).not.toHaveBeenCalled();
      readSpy.mockRestore();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // review_a #4
  it('applies pure-black remap in the default load pipeline (loadContent)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'performance'] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termvg-black-'));
    const file = path.join(dir, 'black.svg');
    fs.writeFileSync(file, '<svg width="10" height="10"><rect fill="#000" width="10" height="10"/></svg>');
    const loaded: string[] = [];
    const wasm = { ...mockWasm(1, 0), loadContent: (c: string) => (loaded.push(c), true) };
    try {
      const { inst } = mount({ wasmModule: wasm, filePath: file, loadAsset: undefined });
      await flush();
      expect(loaded[0]).toContain('fill="#020202"');
      inst.unmount();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // review_b #7
  it('sextant pixel height is a multiple of 6 (no bottom-row crop on odd heights)', () => {
    expect(calcPixelSize(10, 7, 'sextant')).toEqual({ w: 20, h: 18 });
    expect(calcPixelSize(10, 8, 'sextant')).toEqual({ w: 20, h: 24 });
    expect(calcPixelSize(10, 1, 'sextant').h % 6).toBe(0);
  });

  // review_b #1
  it('does not crash when renderFrame throws inside the interval; reports error frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'performance'] });
    let calls = 0;
    const onFrame = vi.fn();
    const { inst } = mount({
      onFrame,
      renderFrame: (f) => {
        if (++calls > 1) throw new Error('wasm boom');
        return `frame-${f}`;
      },
    });
    await flush();
    await vi.advanceTimersByTimeAsync(200);
    expect(onFrame).toHaveBeenLastCalledWith('Failed to render frame', 0, 1, 0);
    expect(vi.getTimerCount()).toBe(0);
    inst.unmount();
  });

  it('reports load failure instead of unhandled rejection when loadAsset throws', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'performance'] });
    const onFrame = vi.fn();
    const { inst } = mount({
      onFrame,
      loadAsset: () => {
        throw new Error('load boom');
      },
    });
    await flush();
    expect(onFrame).toHaveBeenCalledWith('Failed to load file', 0, 1, 0);
    inst.unmount();
  });

  // review_b #6
  it('rewinds on resume after loop=false completion', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'performance'] });
    const onComplete = vi.fn();
    const frames: number[] = [];
    const { inst, ref_ } = mount({
      loop: false,
      onComplete,
      renderFrame: (f) => {
        frames.push(f);
        return `frame-${f}`;
      },
    });
    await flush();
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(100);
    expect(onComplete).toHaveBeenCalledTimes(1);
    frames.length = 0;
    ref_.current!.resume();
    await vi.advanceTimersByTimeAsync(100);
    expect(frames[0]).toBeLessThan(29);
    inst.unmount();
  });

  // review_b #2
  it('falls back to page navigation with ←/→ while paused on a static SVG', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termvg-page-'));
    try {
      for (let i = 0; i < 40; i++) {
        fs.writeFileSync(path.join(dir, `f${String(i).padStart(2, '0')}.svg`), '<svg width="8" height="8"><rect width="8" height="8"/></svg>');
      }
      const wasm = {
        ...mockWasm(0, 0),
        load: () => true,
        loadContent: () => true,
        renderToString: () => 'x',
        destroy: () => {},
      };
      const { stdout, stdin } = streams();
      const chunks: string[] = [];
      stdout.on('data', (c: Buffer | string) => chunks.push(c.toString()));
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const inst = render(React.createElement(InteractiveMenu, { wasmModule: wasm, initialPath: dir, initialDepth: 1 }), {
        stdout,
        stdin,
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
      });
      await wait(100);
      expect(chunks[chunks.length - 1]).toMatch(/Page 1\//);
      stdin.write(' ');
      await wait(30);
      stdin.write('\x1b[C');
      await wait(60);
      expect(chunks[chunks.length - 1]).toMatch(/Page 2\//);
      inst.unmount();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
