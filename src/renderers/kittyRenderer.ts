import zlib from 'node:zlib';
import type { PixelFrame } from './pixelExtractor.js';

export const KITTY_MAX_CHUNK_SIZE = 4096;
export const KITTY_DEFAULT_IMAGE_ID = 1;
export const KITTY_CLEAR_SEQ = '\x1b_Ga=d\x1b\\';

export interface KittyRenderOptions {
  cols: number;
  rows: number;
  imageId?: number;
  compress?: boolean;
}

/**
 * RGBA PixelFrame을 Kitty Graphics Protocol(APC G) 청크 시퀀스로 인코딩한다.
 * - i=1, p=1 고정 배치로 GPU 텍스처 누적 방지
 * - C=1 커서 비이동, q=2 터미널 OK 응답 억제(stdin 오염 차단)
 * - 4096B 단위 Base64 청크 분할(m=1 / m=0)
 */
export function encodeKittyGraphics(
  frame: PixelFrame,
  options: KittyRenderOptions,
): string {
  if (
    !frame ||
    !Number.isInteger(frame.width) ||
    !Number.isInteger(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0 ||
    !frame.data ||
    frame.data.byteLength < frame.width * frame.height * 4
  ) {
    throw new RangeError('Invalid PixelFrame dimensions or RGBA buffer length');
  }

  const cols = Math.max(1, Math.floor(options.cols));
  const rows = Math.max(1, Math.floor(options.rows));
  const imageId = options.imageId ?? KITTY_DEFAULT_IMAGE_ID;
  const compress = options.compress ?? true;

  const rawSlice = frame.data.subarray(0, frame.width * frame.height * 4);
  const payload = compress
    ? zlib.deflateSync(rawSlice, { level: 1 })
    : Buffer.from(rawSlice.buffer, rawSlice.byteOffset, rawSlice.byteLength);
  const b64 = payload.toString('base64');

  const headerPrefix = `a=T,f=32,i=${imageId},p=1,s=${frame.width},v=${frame.height},c=${cols},r=${rows},C=1,q=2${compress ? ',o=z' : ''}`;

  if (b64.length <= KITTY_MAX_CHUNK_SIZE) {
    return `\x1b_G${headerPrefix},m=0;${b64}\x1b\\`;
  }

  const parts: string[] = [];
  for (let offset = 0; offset < b64.length; offset += KITTY_MAX_CHUNK_SIZE) {
    const chunk = b64.slice(offset, offset + KITTY_MAX_CHUNK_SIZE);
    const isFirst = offset === 0;
    const isLast = offset + KITTY_MAX_CHUNK_SIZE >= b64.length;
    const moreFlag = isLast ? 0 : 1;

    if (isFirst) {
      parts.push(`\x1b_G${headerPrefix},m=${moreFlag};${chunk}\x1b\\`);
    } else {
      parts.push(`\x1b_Gm=${moreFlag};${chunk}\x1b\\`);
    }
  }

  return parts.join('');
}

/**
 * 활성 Kitty 그래픽 레이어 제거 시퀀스를 반환한다.
 */
export function clearKittyGraphics(): string {
  return KITTY_CLEAR_SEQ;
}
