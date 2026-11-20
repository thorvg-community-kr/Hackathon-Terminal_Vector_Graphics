import React from 'react';
import { vi } from 'vitest';
import {
  useAnimationLoop,
  type AnimationConfig,
  type AnimationControls,
} from '../../src/hooks/useAnimationLoop.js';
import { renderInk, type RenderedInkHarness } from './inkHarness.js';

export interface MockWasmOptions {
  totalFrames?: number;
  duration?: number;
  init?: () => Promise<void>;
  setSize?: (w: number, h: number) => void;
  load?: (filePath: string, opts?: unknown) => boolean;
  loadContent?: ((content: string) => boolean) | undefined;
  renderToString?: (frame: number, mode?: number, invert?: boolean) => string;
  destroy?: () => void;
}

/**
 * Vitest 가짜 타이머와 performance/Date 타이머를 함께 활성화한다.
 */
export function enableFakeTimersWithPerf(): void {
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

/**
 * 지정된 횟수만큼 마이크로태스크 큐를 비운다.
 */
export async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/**
 * Fake Timer 환경에서 React 18 passive effect 및 cleanup 스케줄러를 플러시한다.
 */
export async function flushEffects(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await flushMicrotasks();
}

/**
 * 실제 타이머 기반 비동기 테스트에서 지정 밀리초만큼 대기한다.
 */
export const waitMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 테스트용 Mock ThorVG WASM 모듈을 생성한다.
 * 가상 파일 경로 테스트에서는 `{ loadContent: undefined }`로 로컬 파일 읽기 분기를 우회할 수 있다.
 */
export function createMockWasm(options: MockWasmOptions = {}) {
  const hasLoadContent = Object.prototype.hasOwnProperty.call(options, 'loadContent');
  const resolvedLoadContent = hasLoadContent ? options.loadContent : vi.fn(() => true);
  const {
    totalFrames = 0,
    duration = 0,
    init = vi.fn(async () => {}),
    setSize = vi.fn(),
    load = vi.fn(() => true),
    renderToString = vi.fn((frame: number) => `frame-${frame}`),
    destroy = vi.fn(),
  } = options;

  return {
    init,
    setSize,
    load,
    ...(resolvedLoadContent !== undefined ? { loadContent: resolvedLoadContent } : {}),
    getTotalFrames: vi.fn(() => totalFrames),
    getDuration: vi.fn(() => duration),
    renderToString,
    destroy,
  };
}

export interface LoopHarnessProps {
  config: AnimationConfig;
  controlsRef?: { current: AnimationControls | null };
}

/**
 * useAnimationLoop 훅을 Ink 트리 안에서 마운트하기 위한 헤드리스 하네스 컴포넌트.
 */
export const LoopHarness: React.FC<LoopHarnessProps> = ({ config, controlsRef }) => {
  const controls = useAnimationLoop(config);
  if (controlsRef) controlsRef.current = controls;
  return null;
};

export interface MountedLoopHarness extends RenderedInkHarness {
  controlsRef: { current: AnimationControls | null };
  config: AnimationConfig;
}

/**
 * LoopHarness를 기본 mock WASM 설정과 함께 마운트한다.
 */
export function mountLoopHarness(
  overrides: Partial<AnimationConfig> = {},
  cols = 100,
  rows = 40,
): MountedLoopHarness {
  const controlsRef = { current: null as AnimationControls | null };
  const config: AnimationConfig = {
    wasmModule: createMockWasm({ totalFrames: 30, duration: 1, loadContent: undefined }),
    filePath: 'mock.json',
    pixelWidth: 32,
    pixelHeight: 16,
    modeInt: 1,
    invertDark: false,
    loop: true,
    paused: false,
    onFrame: vi.fn(),
    ...overrides,
  };
  const rendered = renderInk(
    React.createElement(LoopHarness, { config, controlsRef }),
    cols,
    rows,
  );
  return { ...rendered, controlsRef, config };
}
