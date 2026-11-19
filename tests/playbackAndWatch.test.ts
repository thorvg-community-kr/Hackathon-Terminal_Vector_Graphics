import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findActiveMarker,
  getNextMarker,
  parseLottieMarkers,
  PLAYBACK_SPEEDS,
  stepPlaybackSpeed,
} from '../src/utils/lottieMarkers.js';
import {
  useFileWatcher,
  validateVectorContent,
  type FileWatcherOptions,
  type FileWatcherState,
} from '../src/hooks/useFileWatcher.js';
import {
  useAnimationLoop,
  type AnimationConfig,
  type AnimationControls,
} from '../src/hooks/useAnimationLoop.js';
import { InteractiveMenu } from '../src/InteractiveMenu.js';

function createMockTerminalStreams(cols = 120, rows = 36) {
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
    getOutput: () => chunks.join(''),
    getLatestChunk: () => chunks[chunks.length - 1] ?? '',
  };
}

const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const LoopHarness: React.FC<{
  config: AnimationConfig;
  controlsRef?: { current: AnimationControls | null };
}> = ({ config, controlsRef }) => {
  const controls = useAnimationLoop(config);
  if (controlsRef) controlsRef.current = controls;
  return null;
};

const WatcherHarness: React.FC<{
  filePath: string | null;
  options: FileWatcherOptions;
  stateRef: { current: FileWatcherState | null };
}> = ({ filePath, options, stateRef }) => {
  stateRef.current = useFileWatcher(filePath, options);
  return null;
};

describe('Task 09: Advanced Playback (Speed, Reverse, Markers) & Atomic Hot Reload', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('scales wall-clock frame advancement by speed (0.25x..2.0x) and wraps reverse playback cleanly', async () => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'performance',
      ],
    });

    const flushFake = async () => {
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 6; i++) await Promise.resolve();
    };

    const makeMockWasm = (totalFrames = 120, duration = 4.0) => ({
      init: vi.fn(async () => {}),
      setSize: vi.fn(),
      load: vi.fn(() => true),
      loadContent: vi.fn(() => true),
      getTotalFrames: vi.fn(() => totalFrames),
      getDuration: vi.fn(() => duration),
      renderToString: vi.fn((f: number) => `F:${f}`),
      destroy: vi.fn(),
    });

    let virtualNow = 0;
    const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => virtualNow);

    const runSpeedCheck = async (speed: number) => {
      virtualNow = 0;
      const frames: number[] = [];
      const { stdout, stdin } = createMockTerminalStreams();
      const inst = render(
        React.createElement(LoopHarness, {
          config: {
            wasmModule: makeMockWasm(120, 4.0),
            filePath: 'virtual.json',
            pixelWidth: 32,
            pixelHeight: 16,
            modeInt: 1,
            invertDark: false,
            speed,
            loop: true,
            paused: false,
            loadAsset: () => true,
            onFrame: (_ansi, frame) => {
              frames.push(frame);
            },
          },
        }),
        { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
      );

      await flushFake();
      // 정확히 0.5초(10 * 50ms = 500ms) Wall-Clock 경과 시뮬레이션
      for (let t = 0; t < 10; t++) {
        virtualNow += 50;
        await vi.advanceTimersByTimeAsync(34);
      }
      const last = frames[frames.length - 1];
      inst.unmount();
      await flushFake();
      return last;
    };

    const at1x = await runSpeedCheck(1.0);
    const at2x = await runSpeedCheck(2.0);
    const atQuarter = await runSpeedCheck(0.25);
    perfSpy.mockRestore();

    // 120 frames / 4.0s = 30 fps -> 0.5s에서 1x = 15, 2x = 30, 0.25x = 3
    expect(at1x).toBe(15);
    expect(at2x).toBe(30);
    expect(atQuarter).toBe(3);

    // 역재생 loop=true: 0프레임에서 역방향 틱 진행 시 119(totalFrames - 1)로 래핑
    const reverseFrames: number[] = [];
    const { stdout: sOut1, stdin: sIn1 } = createMockTerminalStreams();
    const revLoopInst = render(
      React.createElement(LoopHarness, {
        config: {
          wasmModule: makeMockWasm(120, 4.0),
          filePath: 'rev-loop.json',
          pixelWidth: 32,
          pixelHeight: 16,
          modeInt: 1,
          invertDark: false,
          reverse: true,
          loop: true,
          paused: false,
          loadAsset: () => true,
          onFrame: (_ansi, frame) => {
            reverseFrames.push(frame);
          },
        },
      }),
      { stdout: sOut1, stdin: sIn1, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await flushFake();
    expect(reverseFrames[0]).toBe(0);
    await vi.advanceTimersByTimeAsync(34);
    expect(reverseFrames[1]).toBe(119);
    revLoopInst.unmount();
    await flushFake();

    // 역재생 loop=false: 0프레임 도달 시 정지 및 onComplete 호출
    const onComplete = vi.fn();
    const revOnceFrames: number[] = [];
    const controlsRef = { current: null as AnimationControls | null };
    const { stdout: sOut2, stdin: sIn2 } = createMockTerminalStreams();
    const revOnceInst = render(
      React.createElement(LoopHarness, {
        controlsRef,
        config: {
          wasmModule: makeMockWasm(120, 4.0),
          filePath: 'rev-once.json',
          pixelWidth: 32,
          pixelHeight: 16,
          modeInt: 1,
          invertDark: false,
          reverse: true,
          loop: false,
          paused: false,
          loadAsset: () => true,
          onComplete,
          onFrame: (_ansi, frame) => {
            revOnceFrames.push(frame);
          },
        },
      }),
      { stdout: sOut2, stdin: sIn2, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await flushFake();
    controlsRef.current!.seekToFrame(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(revOnceFrames[revOnceFrames.length - 1]).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    revOnceInst.unmount();
  });

  it('parses Lottie named markers, steps speeds, cycles next markers, and loops segmentRange [30, 75]', async () => {
    expect([...PLAYBACK_SPEEDS]).toEqual([0.25, 0.5, 1.0, 1.5, 2.0]);
    expect(stepPlaybackSpeed(1.0, 1)).toBe(1.5);
    expect(stepPlaybackSpeed(2.0, 1)).toBe(2.0);
    expect(stepPlaybackSpeed(1.0, -1)).toBe(0.5);
    expect(stepPlaybackSpeed(0.25, -1)).toBe(0.25);

    const fixtureJson = JSON.stringify({
      v: '5.7.4',
      fr: 30,
      ip: 0,
      op: 100,
      w: 100,
      h: 100,
      layers: [],
      markers: [
        { cm: 'outro', tm: 75, dr: 25 },
        { cm: 'intro\r\n', tm: 0, dr: 30 },
        { cm: ' loop_idle ', tm: 30, dr: 45 },
      ],
    });

    const markers = parseLottieMarkers(fixtureJson, 100);
    expect(markers).toEqual([
      { name: 'intro', time: 0, duration: 30, endFrame: 30 },
      { name: 'loop_idle', time: 30, duration: 45, endFrame: 75 },
      { name: 'outro', time: 75, duration: 25, endFrame: 100 },
    ]);
    expect(parseLottieMarkers('<svg width="10" height="10"/>')).toEqual([]);
    expect(parseLottieMarkers('{broken')).toEqual([]);

    expect(findActiveMarker(markers, 10)?.name).toBe('intro');
    expect(findActiveMarker(markers, 45)?.name).toBe('loop_idle');
    expect(findActiveMarker(markers, 80)?.name).toBe('outro');

    expect(getNextMarker(markers, 10)).toEqual({ marker: markers[1], index: 1 });
    expect(getNextMarker(markers, 40)).toEqual({ marker: markers[2], index: 2 });
    expect(getNextMarker(markers, 80)).toEqual({ marker: markers[0], index: 0 });

    // segmentRange = [30, 75] 구간 루프 검증
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'performance',
      ],
    });

    const segFrames: number[] = [];
    const { stdout, stdin } = createMockTerminalStreams();
    const inst = render(
      React.createElement(LoopHarness, {
        config: {
          wasmModule: {
            init: vi.fn(async () => {}),
            setSize: vi.fn(),
            getTotalFrames: () => 100,
            getDuration: () => 2.0,
          },
          filePath: 'seg.json',
          pixelWidth: 32,
          pixelHeight: 16,
          modeInt: 1,
          invertDark: false,
          segmentRange: [30, 75],
          loop: true,
          paused: false,
          loadAsset: () => true,
          renderFrame: (f) => `seg-${f}`,
          onFrame: (_ansi, frame) => segFrames.push(frame),
        },
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1400);

    expect(segFrames.length).toBeGreaterThan(20);
    for (const f of segFrames) {
      expect(f).toBeGreaterThanOrEqual(30);
      expect(f).toBeLessThan(75);
    }

    inst.unmount();
  });

  it('preserves progressRatio across Hot Reload and validates partial SVG/JSON syntax safely', async () => {
    expect(validateVectorContent('', 'a.json')).toBe(false);
    expect(validateVectorContent('{"v":"5.0","layers":[', 'a.json')).toBe(false);
    expect(validateVectorContent('{"v":"5.0","layers":[]}', 'a.json')).toBe(true);
    expect(validateVectorContent('<svg><rect/></svg>', 'a.svg')).toBe(true);
    expect(validateVectorContent('<svg width="10" height="10"/>', 'a.svg')).toBe(true);
    expect(validateVectorContent('<svg><rect/>', 'a.svg')).toBe(false);

    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'performance',
      ],
    });
    const flushFake = async () => {
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 6; i++) await Promise.resolve();
    };

    let totalFrames = 120;
    const controlsRef = { current: null as AnimationControls | null };
    const frames: number[] = [];
    const makeCfg = (reloadVersion: number, rawContentOverride?: string): AnimationConfig => ({
      wasmModule: {
        init: vi.fn(async () => {}),
        setSize: vi.fn(),
        loadContent: vi.fn(() => true),
        getTotalFrames: () => totalFrames,
        getDuration: () => 4.0,
        renderToString: (f: number) => `hot-${reloadVersion}-${f}`,
      },
      filePath: 'hot.json',
      pixelWidth: 32,
      pixelHeight: 16,
      modeInt: 1,
      invertDark: false,
      reloadVersion,
      rawContentOverride,
      loop: true,
      paused: true,
      onFrame: (_ansi, f) => frames.push(f),
    });

    const { stdout, stdin } = createMockTerminalStreams();
    const inst = render(
      React.createElement(LoopHarness, {
        controlsRef,
        config: makeCfg(0, '{"v":"5.7","layers":[]}'),
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await flushFake();
    controlsRef.current!.seekToFrame(60); // 60 / 120 = 0.5
    expect(frames[frames.length - 1]).toBe(60);

    // Hot Reload 후 총 프레임 수가 240으로 증가해도 50% 진행률(120프레임) 유지
    totalFrames = 240;
    inst.rerender(
      React.createElement(LoopHarness, {
        controlsRef,
        config: makeCfg(1, '{"v":"5.7","layers":[]}'),
      }),
    );
    await flushFake();
    expect(frames[frames.length - 1]).toBe(120);

    inst.unmount();
  });

  it('handles atomic rename saves, partial-write recovery, persistent syntax errors, file deletion, and watcher.close() cleanup', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termvg-watch-'));
    tempDirs.push(tmpDir);
    const targetPath = path.join(tmpDir, 'anim.json');
    const validV1 = JSON.stringify({ v: '5.7.4', fr: 30, ip: 0, op: 30, w: 40, h: 40, layers: [] });
    const validV2 = JSON.stringify({ v: '5.7.4', fr: 30, ip: 0, op: 60, w: 40, h: 40, layers: [] });
    const validV3 = JSON.stringify({ v: '5.7.4', fr: 30, ip: 0, op: 90, w: 40, h: 40, layers: [] });
    fs.writeFileSync(targetPath, validV1, 'utf8');

    const closeSpies: Array<ReturnType<typeof vi.fn>> = [];
    const origWatch = fs.watch.bind(fs);
    vi.spyOn(fs, 'watch').mockImplementation(((...args: any[]) => {
      const w = (origWatch as any)(...args);
      const origClose = w.close.bind(w);
      const closeSpy = vi.fn(() => origClose());
      w.close = closeSpy;
      closeSpies.push(closeSpy);
      return w;
    }) as typeof fs.watch);

    const stateRef = { current: null as FileWatcherState | null };
    const onReload = vi.fn(() => true);
    const onDelete = vi.fn();
    const onError = vi.fn();

    const { stdout, stdin } = createMockTerminalStreams();
    const inst = render(
      React.createElement(WatcherHarness, {
        filePath: targetPath,
        stateRef,
        options: {
          debounceMs: 60,
          retryDelayMs: 90,
          badgeHoldMs: 500,
          onReload,
          onDelete,
          onError,
        },
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await waitMs(80);
    expect(closeSpies).toHaveLength(1);

    // 시나리오 A: Atomic Rename (tmp -> target)
    const tmpWrite = path.join(tmpDir, '.anim.json.tmp');
    fs.writeFileSync(tmpWrite, validV2, 'utf8');
    fs.renameSync(tmpWrite, targetPath);
    await waitMs(180);
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenLastCalledWith(validV2, Buffer.byteLength(validV2));
    expect(stateRef.current?.status).toBe('reloaded');

    // 시나리오 B: Partial Write -> 40ms 뒤 정상 JSON 복구 (에러 고착 없음)
    fs.writeFileSync(targetPath, '{"v":"5.0","layers":[', 'utf8');
    await waitMs(40);
    fs.writeFileSync(targetPath, validV3, 'utf8');
    await waitMs(220);
    expect(onReload).toHaveBeenCalledTimes(2);
    expect(onReload).toHaveBeenLastCalledWith(validV3, Buffer.byteLength(validV3));
    expect(onError).not.toHaveBeenCalled();
    expect(stateRef.current?.status).toBe('reloaded');

    // 시나리오 C: 지속적인 문법 오류 -> 재시도 후 error 배너 전환 + 직전 유효 프레임 보존(onReload 미호출)
    fs.writeFileSync(targetPath, '{"v":"5.0","layers":[', 'utf8');
    await waitMs(300);
    expect(onReload).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith('⚠ Reload failed: invalid syntax');
    expect(stateRef.current?.status).toBe('error');
    expect(stateRef.current?.errorMessage).toBe('⚠ Reload failed: invalid syntax');

    // 시나리오 D: 파일 삭제 시 크래시 없이 onDelete 호출 및 watcher.close() 해제
    fs.unlinkSync(targetPath);
    await waitMs(300);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(stateRef.current?.status).toBe('deleted');
    expect(closeSpies[0]).toHaveBeenCalled();

    inst.unmount();
    expect(closeSpies[0]).toHaveBeenCalled();
  });

  it('wires [, ], V, N, 1..9, T, and 0 zoom-reset cleanly in InteractiveMenu', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termvg-adv-tui-'));
    tempDirs.push(tmpDir);
    const markerLottie = JSON.stringify({
      v: '5.7.4',
      fr: 30,
      ip: 0,
      op: 120,
      w: 80,
      h: 80,
      layers: [
        {
          ddd: 0,
          ind: 1,
          ty: 4,
          nm: 'Dot',
          sr: 1,
          ks: {
            o: { a: 0, k: 100 },
            r: { a: 0, k: 0 },
            p: { a: 0, k: [40, 40, 0] },
            a: { a: 0, k: [0, 0, 0] },
            s: { a: 0, k: [100, 100, 100] },
          },
          ao: 0,
          shapes: [
            {
              ty: 'gr',
              it: [
                { ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [30, 30] } },
                { ty: 'fl', c: { a: 0, k: [0.2, 0.8, 1, 1] }, o: { a: 0, k: 100 } },
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
          op: 120,
          st: 0,
        },
      ],
      markers: [
        { cm: 'intro', tm: 0, dr: 30 },
        { cm: 'loop_idle', tm: 30, dr: 45 },
        { cm: 'outro', tm: 75, dr: 45 },
      ],
    });
    fs.writeFileSync(path.join(tmpDir, 'marked.json'), markerLottie, 'utf8');

    const { stdout, stdin, getLatestChunk } = createMockTerminalStreams(140, 36);
    const mockWasm = {
      init: vi.fn(async () => {}),
      setSize: vi.fn(),
      load: vi.fn(() => true),
      loadContent: vi.fn(() => true),
      getTotalFrames: vi.fn(() => 120),
      getDuration: vi.fn(() => 4.0),
      renderToString: vi.fn((f: number) => `\x1b[38;2;50;200;255mF${f}\x1b[0m`),
      destroy: vi.fn(),
    };

    const inst = render(
      React.createElement(InteractiveMenu, {
        wasmModule: mockWasm,
        initialPath: tmpDir,
        initialDepth: 0,
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await waitMs(120);
    // 일시정지 후 초기 마커 및 배속/역재생/마커 점프/구간 루프 조작
    stdin.write(' ');
    await waitMs(30);
    stdin.write(']');
    await waitMs(25);
    expect(getLatestChunk()).toContain('1.5x');

    stdin.write('v');
    await waitMs(25);
    expect(getLatestChunk()).toContain('PAUSED ◀');

    // 'N' -> 두 번째 마커('loop_idle', tm=30)로 점프
    stdin.write('n');
    await waitMs(40);
    expect(getLatestChunk()).toContain('[Marker: loop_idle]');

    // 'T' -> 구간 루프 활성화 (🔁[Marker: loop_idle])
    stdin.write('t');
    await waitMs(30);
    expect(getLatestChunk()).toContain('🔁[Marker: loop_idle]');

    // '3' -> 세 번째 마커('outro', tm=75) 점프
    stdin.write('3');
    await waitMs(40);
    expect(getLatestChunk()).toContain('[Marker: outro]');

    // '+' 확대 후 '0' 키가 마커가 아닌 줌 리셋으로 동작함 확인
    stdin.write('+');
    await waitMs(30);
    expect(getLatestChunk()).toContain('HJKL:Pan 0:Reset');
    stdin.write('0');
    await waitMs(30);
    expect(getLatestChunk()).not.toContain('HJKL:Pan');
    expect(getLatestChunk()).toContain('[Marker: outro]');

    stdin.write('q');
    await inst.waitUntilExit();
  });
});
