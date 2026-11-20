import React from 'react';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { clampEvenPixelSize } from '../src/renderers/headlessPipeline.js';
import {
  computeWallClockDeltaSec,
  useAnimationLoop,
  type AnimationConfig,
  type AnimationControls,
} from '../src/hooks/useAnimationLoop.js';
import { LottiePlayer } from '../src/LottiePlayer.js';
import { PreviewPanel } from '../src/components/PreviewPanel.js';
import { InteractiveMenu } from '../src/InteractiveMenu.js';
import { realWasmModule } from '../src/realWasmModule.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function enableFakeTimersWithPerf() {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'Date',
      'performance',
    ],
  });
}

function createMockTerminalStreams() {
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
  stdout.on('data', (chunk: Buffer | string) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });

  return {
    stdout,
    stdin,
    getOutput: () => chunks.join(''),
  };
}

async function flushMicrotasks(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

async function flushEffects() {
  // React 18 passive useEffect 및 cleanup은 scheduler(setImmediate/setTimeout 0)를 통해 실행되므로
  // fake timers 환경에서 0ms 틱과 마이크로태스크를 함께 비워 준다.
  await vi.advanceTimersByTimeAsync(0);
  await flushMicrotasks();
}

interface HookHarnessProps {
  config: AnimationConfig;
  controlsRef?: { current: AnimationControls | null };
}

const HookHarness: React.FC<HookHarnessProps> = ({ config, controlsRef }) => {
  const controls = useAnimationLoop(config);
  if (controlsRef) {
    controlsRef.current = controls;
  }
  return null;
};

describe('Task 04: Playback Engine, Static Idle, Wall-Clock & Soft Resize', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    realWasmModule.destroy();
  });

  it('clamps odd, zero, negative, and non-finite pixel sizes to even >= 16x8 and clamps wall-clock spikes', () => {
    expect(clampEvenPixelSize(-10, 0)).toEqual({ width: 16, height: 8 });
    expect(clampEvenPixelSize(1, 3)).toEqual({ width: 16, height: 8 });
    expect(clampEvenPixelSize(31, 19)).toEqual({ width: 32, height: 20 });
    expect(clampEvenPixelSize(100, 80)).toEqual({ width: 100, height: 80 });
    expect(clampEvenPixelSize(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({
      width: 16,
      height: 8,
    });

    expect(computeWallClockDeltaSec(null, 500)).toBeCloseTo(1 / 30, 6);
    expect(computeWallClockDeltaSec(500, 500)).toBe(0);
    expect(computeWallClockDeltaSec(500, 400)).toBe(0);
    expect(computeWallClockDeltaSec(0, 65)).toBeCloseTo(0.065, 6);
    expect(computeWallClockDeltaSec(0, 500)).toBeCloseTo(0.5, 6);
    expect(computeWallClockDeltaSec(0, 501)).toBe(0.1);
    expect(computeWallClockDeltaSec(0, 3000)).toBe(0.1);
  });

  it('idles static SVG assets (assets/2961.svg) with 1 render, 0 intervals over 500ms, and renders STATIC badge in PreviewPanel', async () => {
    await realWasmModule.init();
    const renderSpy = vi.spyOn(realWasmModule, 'renderToString');

    enableFakeTimersWithPerf();

    const onLoad = vi.fn();
    const onFrame = vi.fn();
    const onMetaUpdate = vi.fn();
    const { stdout, stdin } = createMockTerminalStreams();

    const svgPath = path.join(REPO_ROOT, 'assets/2961.svg');
    const inst = render(
      React.createElement(HookHarness, {
        config: {
          wasmModule: realWasmModule,
          filePath: svgPath,
          pixelWidth: 80,
          pixelHeight: 40,
          modeInt: 1,
          invertDark: false,
          loop: true,
          paused: false,
          onLoad,
          onFrame,
          onMetaUpdate,
        },
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await flushEffects();

    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onLoad).toHaveBeenCalledWith(0, 1, true);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onMetaUpdate).toHaveBeenCalledWith(0, 1, 0, true);
    expect(vi.getTimerCount()).toBe(0);

    // 500ms 대기 동안 정적 SVG 재렌더 0회 및 타이머 0개 검증
    await vi.advanceTimersByTimeAsync(500);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // 배경/다크모드 옵션 변경 시에는 즉시 1회 재렌더 후 다시 유휴 상태 유지
    inst.rerender(
      React.createElement(HookHarness, {
        config: {
          wasmModule: realWasmModule,
          filePath: svgPath,
          pixelWidth: 80,
          pixelHeight: 40,
          modeInt: 1,
          invertDark: true,
          renderOptionKey: 'quadrant:dark:true',
          loop: true,
          paused: false,
          onLoad,
          onFrame,
          onMetaUpdate,
        },
      }),
    );
    await flushEffects();
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    inst.unmount();
    await flushEffects();
    expect(vi.getTimerCount()).toBe(0);

    // PreviewPanel STATIC 배지 및 0fps 제거 검증
    const previewStreams = createMockTerminalStreams();
    const previewInst = render(
      React.createElement(PreviewPanel, {
        selectedFile: { label: '2961.svg', value: svgPath, meta: { duration: 0, size: '15.2kb' } },
        wasmModule: realWasmModule,
        settingsMode: 'quadrant',
        invertDark: false,
        previewWidth: 40,
        previewHeight: 20,
        isPaused: false,
        seekDelta: 0,
        frameProgress: { current: 0, total: 1, fps: 0, isStatic: true },
        onDurationLoad: vi.fn(),
        onSeekConsumed: vi.fn(),
        onFrameUpdate: vi.fn(),
      }),
      {
        stdout: previewStreams.stdout,
        stdin: previewStreams.stdin,
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );
    await flushEffects();
    const previewText = previewStreams.getOutput();
    expect(previewText).toContain('STATIC');
    expect(previewText).toContain('1/1');
    expect(previewText).not.toContain('0fps');

    previewInst.unmount();
    await flushEffects();
    vi.clearAllTimers();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders static SVG once and invokes onComplete cleanly without hanging when loop=false', async () => {
    await realWasmModule.init();
    const renderSpy = vi.spyOn(realWasmModule, 'renderToString');

    enableFakeTimersWithPerf();

    const onComplete = vi.fn();
    const { stdout, stdin, getOutput } = createMockTerminalStreams();
    const svgPath = path.join(REPO_ROOT, 'assets/2961.svg');

    const inst = render(
      React.createElement(LottiePlayer, {
        wasmModule: realWasmModule,
        filePath: svgPath,
        width: 60,
        height: 24,
        renderMode: 'braille',
        loop: false,
        onComplete,
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await flushEffects();
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();

    // 16ms 완료 콜백 실행
    await vi.advanceTimersByTimeAsync(20);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(getOutput().length).toBeGreaterThan(100);
    expect(vi.getTimerCount()).toBe(0);

    inst.unmount();
    await flushEffects();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('compensates 65ms per-frame render lag via wall-clock timing to reach ~30 frames in 1000ms', async () => {
    enableFakeTimersWithPerf();
    let virtualNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => virtualNow);

    const renderedFrames: number[] = [];
    const mockWasm = {
      init: vi.fn(async () => {}),
      setSize: vi.fn(),
      load: vi.fn(() => true),
      getTotalFrames: vi.fn(() => 90),
      getDuration: vi.fn(() => 3.0),
      renderToString: vi.fn((frame: number) => {
        renderedFrames.push(frame);
        // 65ms ~ 66.7ms CPU 블록 지연 시뮬레이션 (15틱 == 약 1000ms 경과)
        virtualNow += 66.67;
        return `\x1b[38;2;255;0;0mF${frame}\x1b[0m`;
      }),
    };

    const { stdout, stdin } = createMockTerminalStreams();
    const inst = render(
      React.createElement(HookHarness, {
        config: {
          wasmModule: mockWasm,
          filePath: '/virtual/slow-anim.json',
          pixelWidth: 80,
          pixelHeight: 40,
          modeInt: 1,
          invertDark: false,
          loop: true,
          paused: false,
          onFrame: vi.fn(),
        },
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await flushEffects();
    // 500ms 타이머 진행 => setInterval(33.33ms) 15틱 발동 => 가상 Wall-Clock 약 1000ms 경과
    await vi.advanceTimersByTimeAsync(500);

    const lastRendered = renderedFrames[renderedFrames.length - 1];
    expect(renderedFrames.length).toBe(16); // 초기 1회 + 15틱
    // 고정 틱이었다면 ~15프레임에 머물렀겠지만 Wall-Clock 보정으로 약 30프레임 도달
    expect(lastRendered).toBeGreaterThanOrEqual(28);
    expect(lastRendered).toBeLessThanOrEqual(32);

    inst.unmount();
    await flushEffects();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips duplicate onFrame callbacks when consecutive frames produce identical ANSI output', async () => {
    enableFakeTimersWithPerf();

    const mockWasm = {
      init: vi.fn(async () => {}),
      setSize: vi.fn(),
      load: vi.fn(() => true),
      getTotalFrames: vi.fn(() => 60),
      getDuration: vi.fn(() => 2.0),
      renderToString: vi.fn((frame: number) => (frame < 10 ? 'IDENTICAL_ANSI' : `CHANGED_${frame}`)),
    };

    const onFrame = vi.fn();
    const onMetaUpdate = vi.fn();
    const { stdout, stdin } = createMockTerminalStreams();

    const inst = render(
      React.createElement(HookHarness, {
        config: {
          wasmModule: mockWasm,
          filePath: '/virtual/dup.json',
          pixelWidth: 40,
          pixelHeight: 20,
          modeInt: 0,
          invertDark: false,
          loop: true,
          paused: false,
          onFrame,
          onMetaUpdate,
        },
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await flushEffects();
    expect(onFrame).toHaveBeenCalledTimes(1);

    // 250ms 경과 -> 프레임 0..7 구간(모두 'IDENTICAL_ANSI') 동안 onFrame은 추가 호출되지 않음
    await vi.advanceTimersByTimeAsync(250);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onMetaUpdate.mock.calls.length).toBeGreaterThanOrEqual(7);

    // 10프레임 이상 경과(총 400ms) -> 'CHANGED_*' 진입 후 onFrame 재개
    await vi.advanceTimersByTimeAsync(150);
    expect(onFrame.mock.calls.length).toBeGreaterThan(1);
    expect(onFrame.mock.calls[1][0]).toMatch(/^CHANGED_/);

    inst.unmount();
    await flushEffects();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves playback frame index (~75) across soft resize without resetting to 0', async () => {
    enableFakeTimersWithPerf();

    const renderedAtNewSize: number[] = [];
    let currentW = 0;
    const mockWasm = {
      init: vi.fn(async () => {}),
      setSize: vi.fn((w: number) => {
        currentW = w;
      }),
      load: vi.fn(() => true),
      getTotalFrames: vi.fn(() => 120),
      getDuration: vi.fn(() => 4.0), // 30 fps
      renderToString: vi.fn((frame: number) => {
        if (currentW === 120) {
          renderedAtNewSize.push(frame);
        }
        return `SIZE_${currentW}_F_${frame}`;
      }),
    };

    const onFrameUpdate = vi.fn();
    const { stdout, stdin } = createMockTerminalStreams();
    const selectedFile = {
      label: 'anim.json',
      value: '/virtual/resize-anim.json',
      meta: { duration: 4.0, size: '10kb' },
    };

    const inst = render(
      React.createElement(PreviewPanel, {
        selectedFile,
        wasmModule: mockWasm,
        settingsMode: 'quadrant',
        invertDark: false,
        previewWidth: 40, // pixelWidth = 80
        previewHeight: 20,
        isPaused: false,
        seekDelta: 0,
        frameProgress: { current: 0, total: 120, fps: 30, isStatic: false },
        onDurationLoad: vi.fn(),
        onSeekConsumed: vi.fn(),
        onFrameUpdate,
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await flushEffects();
    // 2500ms 진행 -> 30fps * 2.5s = 75 프레임 도달
    await vi.advanceTimersByTimeAsync(2500);

    // 터미널 리사이즈: previewWidth 40 -> 60 (pixelWidth 80 -> 120), single key={selectedFile.value} 유지
    inst.rerender(
      React.createElement(PreviewPanel, {
        selectedFile,
        wasmModule: mockWasm,
        settingsMode: 'quadrant',
        invertDark: false,
        previewWidth: 60, // pixelWidth = 120
        previewHeight: 25,
        isPaused: false,
        seekDelta: 0,
        frameProgress: { current: 75, total: 120, fps: 30, isStatic: false },
        onDurationLoad: vi.fn(),
        onSeekConsumed: vi.fn(),
        onFrameUpdate,
      }),
    );

    await flushEffects();
    expect(mockWasm.setSize).toHaveBeenLastCalledWith(120, 50);
    expect(renderedAtNewSize.length).toBeGreaterThanOrEqual(1);
    expect(renderedAtNewSize[0]).toBeGreaterThanOrEqual(74);
    expect(renderedAtNewSize[0]).toBeLessThanOrEqual(76);

    inst.unmount();
    await flushEffects();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('prevents async init race conditions on rapid file switching and leaks zero timers on unmount', async () => {
    enableFakeTimersWithPerf();

    const resolvers: Array<() => void> = [];
    const mockWasm = {
      init: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
      setSize: vi.fn(),
      load: vi.fn(() => true),
      getTotalFrames: vi.fn(() => 60),
      getDuration: vi.fn(() => 2.0),
      renderToString: vi.fn((frame: number) => `F_${frame}`),
    };

    const { stdout, stdin } = createMockTerminalStreams();
    const inst = render(
      React.createElement(HookHarness, {
        config: {
          wasmModule: mockWasm,
          filePath: '/virtual/file-a.json',
          pixelWidth: 40,
          pixelHeight: 20,
          modeInt: 0,
          invertDark: false,
          loop: true,
          paused: false,
          onFrame: vi.fn(),
        },
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await flushEffects();
    expect(resolvers).toHaveLength(1);

    // init() 완료 전에 file-b로 빠르게 전환
    inst.rerender(
      React.createElement(HookHarness, {
        config: {
          wasmModule: mockWasm,
          filePath: '/virtual/file-b.json',
          pixelWidth: 40,
          pixelHeight: 20,
          modeInt: 0,
          invertDark: false,
          loop: true,
          paused: false,
          onFrame: vi.fn(),
        },
      }),
    );
    await flushEffects();
    expect(resolvers).toHaveLength(2);

    // 역순 완료: file-b 먼저 완료, 뒤늦게 file-a 완료
    resolvers[1]();
    await flushMicrotasks();
    expect(mockWasm.load).toHaveBeenCalledTimes(1);
    expect(mockWasm.load).toHaveBeenLastCalledWith('/virtual/file-b.json', undefined);

    resolvers[0]();
    await flushMicrotasks();
    // 구 작업(file-a)은 cancelled & seq 불일치로 폐기되어 load가 추가 호출되지 않음
    expect(mockWasm.load).toHaveBeenCalledTimes(1);

    // 언마운트 시 모든 타이머 완벽 정리 + 대기 중이던 새 작업도 차단
    inst.rerender(
      React.createElement(HookHarness, {
        config: {
          wasmModule: mockWasm,
          filePath: '/virtual/file-c.json',
          pixelWidth: 40,
          pixelHeight: 20,
          modeInt: 0,
          invertDark: false,
          loop: true,
          paused: false,
          onFrame: vi.fn(),
        },
      }),
    );
    await flushEffects();
    expect(resolvers).toHaveLength(3);

    inst.unmount();
    await flushEffects();
    resolvers[2]();
    await flushMicrotasks();

    expect(mockWasm.load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('debounces InteractiveMenu stdout resize events by 80ms and cleans up timers/listeners on unmount', async () => {
    enableFakeTimersWithPerf();

    const beforeResizeListeners = process.stdout.listenerCount('resize');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mockWasm = {
      init: vi.fn(async () => {}),
      setSize: vi.fn(),
      load: vi.fn(() => true),
      getTotalFrames: vi.fn(() => 0),
      getDuration: vi.fn(() => 0),
      renderToString: vi.fn(() => ''),
      destroy: vi.fn(),
    };

    const { stdout, stdin } = createMockTerminalStreams();
    const writes: string[] = [];
    stdout.on('data', (chunk: Buffer | string) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });

    const inst = render(
      React.createElement(InteractiveMenu, { wasmModule: mockWasm }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await flushEffects();
    expect(process.stdout.listenerCount('resize')).toBeGreaterThan(beforeResizeListeners);

    const origCols = process.stdout.columns;
    const origRows = process.stdout.rows;

    try {
      const writesAtIdle = writes.length;

      // 연속 resize 이벤트 발생 (40ms 간격) -> 80ms 디바운스 중에는 상태 갱신/리렌더 없음
      Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 120 });
      Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 45 });
      process.stdout.emit('resize');
      await vi.advanceTimersByTimeAsync(40);
      expect(writes.length).toBe(writesAtIdle);

      Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 140 });
      Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 50 });
      process.stdout.emit('resize');
      await vi.advanceTimersByTimeAsync(40);
      expect(writes.length).toBe(writesAtIdle);

      // 80ms 디바운스 만료 후 1회만 리렌더 반영 (최종 50행 -> height=49)
      await vi.advanceTimersByTimeAsync(45);
      expect(writes.length).toBeGreaterThan(writesAtIdle);
      const latestRender = writes[writes.length - 1];
      expect(latestRender.split('\n').length).toBeGreaterThanOrEqual(48);

      // 다시 resize 예약 직후 언마운트하면 타이머와 리스너가 즉시 정리되어 누수나 경고 0건
      Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 160 });
      process.stdout.emit('resize');
      inst.unmount();
      await flushEffects();
      const writesAfterUnmount = writes.length;

      await vi.advanceTimersByTimeAsync(200);
      expect(writes.length).toBe(writesAfterUnmount);
      expect(process.stdout.listenerCount('resize')).toBe(beforeResizeListeners);
      expect(vi.getTimerCount()).toBe(0);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdout, 'columns', { configurable: true, value: origCols });
      Object.defineProperty(process.stdout, 'rows', { configurable: true, value: origRows });
    }
  });
});
