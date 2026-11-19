import type { PixelFrame } from './pixelExtractor.js';
import { encodeRgbaToPng } from './minimalPng.js';

export interface Iterm2RenderOptions {
  cols: number;
  rows: number;
  preserveAspectRatio?: boolean;
}

/**
 * RGBA PixelFrame을 iTerm2 Inline Images(OSC 1337) PNG 이스케이프 시퀀스로 인코딩한다.
 */
export function encodeIterm2Graphics(
  frame: PixelFrame,
  options: Iterm2RenderOptions,
): string {
  const cols = Math.max(1, Math.floor(options.cols));
  const rows = Math.max(1, Math.floor(options.rows));
  const pngBuf = encodeRgbaToPng(frame);
  const b64 = pngBuf.toString('base64');
  const preserve = (options.preserveAspectRatio ?? true) ? 1 : 0;

  return `\x1b]1337;File=inline=1;size=${pngBuf.length};width=${cols};height=${rows};preserveAspectRatio=${preserve}:${b64}\x07`;
}
