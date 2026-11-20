import React from 'react';
import { PassThrough } from 'node:stream';
import { render, type Instance } from 'ink';
import { vi } from 'vitest';
import { InteractiveMenu, type InteractiveMenuProps } from '../../src/InteractiveMenu.js';

export interface MockTerminalStreams {
  stdout: NodeJS.WriteStream & PassThrough;
  stdin: NodeJS.ReadStream & PassThrough;
  chunks: string[];
  getOutput: () => string;
  getLatestChunk: () => string;
}

export interface RenderedInkHarness extends MockTerminalStreams {
  inst: Instance;
}

/**
 * Ink CLI 테스트용 가상 TTY stdout/stdin 스트림과 출력 버퍼 수집기를 생성한다.
 */
export function createMockTerminalStreams(cols = 100, rows = 40): MockTerminalStreams {
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

/**
 * 가상 TTY 스트림에 임의의 React Ink 엘리먼트를 마운트한다.
 */
export function renderInk(
  element: React.ReactElement,
  cols = 100,
  rows = 40,
): RenderedInkHarness {
  const streams = createMockTerminalStreams(cols, rows);
  const inst = render(element, {
    stdout: streams.stdout,
    stdin: streams.stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return { inst, ...streams };
}

/**
 * InteractiveMenu 컴포넌트를 가상 TTY 스트림에 마운트한다.
 */
export function mountInteractiveMenu(
  props: InteractiveMenuProps,
  cols = 100,
  rows = 40,
): RenderedInkHarness {
  return renderInk(React.createElement(InteractiveMenu, props), cols, rows);
}
