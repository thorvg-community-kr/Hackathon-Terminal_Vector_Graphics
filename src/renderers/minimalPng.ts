import zlib from 'node:zlib';
import type { PixelFrame } from './pixelExtractor.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TYPE_IHDR = Buffer.from('IHDR', 'ascii');
const TYPE_IDAT = Buffer.from('IDAT', 'ascii');
const TYPE_IEND = Buffer.from('IEND', 'ascii');
const IEND_CRC = 0xae426082;

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

/**
 * IEEE 802.3 CRC-32 체크섬을 계산한다.
 */
export function crc32(data: Uint8Array, seed = 0xffffffff): number {
  let crc = seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// 30fps 애니메이션 인코딩 중 스캔라인 조립 버퍼 재사용으로 GC 압력 차단
let scanlineScratch = new Uint8Array(0);

/**
 * RGBA PixelFrame을 외부 네이티브 의존성 없이 표준 PNG(IHDR + IDAT + IEND) 버퍼로 직렬화한다.
 */
export function encodeRgbaToPng(frame: PixelFrame): Buffer {
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

  const { width, height, data } = frame;
  const rowBytes = width * 4;
  const stride = 1 + rowBytes;
  const rawLen = height * stride;

  if (scanlineScratch.length < rawLen) {
    scanlineScratch = new Uint8Array(rawLen);
  }

  for (let y = 0; y < height; y++) {
    const dstOffset = y * stride;
    scanlineScratch[dstOffset] = 0; // Filter Type 0: None
    const srcStart = y * rowBytes;
    scanlineScratch.set(data.subarray(srcStart, srcStart + rowBytes), dstOffset + 1);
  }

  const compressed = zlib.deflateSync(scanlineScratch.subarray(0, rawLen), { level: 1 });

  const ihdrTotal = 12 + 13;
  const idatTotal = 12 + compressed.length;
  const iendTotal = 12;
  const totalBytes = PNG_SIGNATURE.length + ihdrTotal + idatTotal + iendTotal;
  const out = Buffer.allocUnsafe(totalBytes);

  let offset = 0;
  PNG_SIGNATURE.copy(out, offset);
  offset += PNG_SIGNATURE.length;

  // IHDR (13 bytes)
  out.writeUInt32BE(13, offset);
  TYPE_IHDR.copy(out, offset + 4);
  out.writeUInt32BE(width, offset + 8);
  out.writeUInt32BE(height, offset + 12);
  out[offset + 16] = 8; // bitDepth
  out[offset + 17] = 6; // colorType: RGBA
  out[offset + 18] = 0; // compression
  out[offset + 19] = 0; // filter
  out[offset + 20] = 0; // interlace
  const ihdrCrc = crc32(out.subarray(offset + 4, offset + 21));
  out.writeUInt32BE(ihdrCrc, offset + 21);
  offset += ihdrTotal;

  // IDAT
  out.writeUInt32BE(compressed.length, offset);
  TYPE_IDAT.copy(out, offset + 4);
  compressed.copy(out, offset + 8);
  const idatCrc = crc32(out.subarray(offset + 4, offset + 8 + compressed.length));
  out.writeUInt32BE(idatCrc, offset + 8 + compressed.length);
  offset += idatTotal;

  // IEND
  out.writeUInt32BE(0, offset);
  TYPE_IEND.copy(out, offset + 4);
  out.writeUInt32BE(IEND_CRC, offset + 8);

  return out;
}
