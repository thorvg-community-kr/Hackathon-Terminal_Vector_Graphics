import type { PixelFrame } from './pixelExtractor.js';

export interface GifEncodeOptions {
  /** 초당 프레임 수 (기본값: 20, 범위: 1..50) */
  fps?: number;
  /** 무한 반복 여부 (기본값: true) */
  loop?: boolean;
}

const TRANSPARENT_INDEX = 255;
const MAX_OPAQUE_COLORS = 255;
const LZW_MIN_CODE_SIZE = 8;
const LZW_CLEAR_CODE = 256;
const LZW_EOI_CODE = 257;
const LZW_MAX_TABLE_SIZE = 4096;
const GIF_TRAILER = Buffer.from([0x3b]);
const NETSCAPE_LOOP_EXT = Buffer.concat([
  Buffer.from([0x21, 0xff, 0x0b]),
  Buffer.from('NETSCAPE2.0', 'ascii'),
  Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
]);

interface ColorBox {
  buckets: number[];
  count: number;
  minR: number;
  maxR: number;
  minG: number;
  maxG: number;
  minB: number;
  maxB: number;
}

function buildBox(buckets: number[], bucketCounts: Int32Array): ColorBox {
  let count = 0;
  let minR = 31;
  let maxR = 0;
  let minG = 31;
  let maxG = 0;
  let minB = 31;
  let maxB = 0;

  for (let i = 0; i < buckets.length; i++) {
    const b15 = buckets[i];
    count += bucketCounts[b15];
    const r5 = (b15 >>> 10) & 0x1f;
    const g5 = (b15 >>> 5) & 0x1f;
    const b5 = b15 & 0x1f;
    if (r5 < minR) minR = r5;
    if (r5 > maxR) maxR = r5;
    if (g5 < minG) minG = g5;
    if (g5 > maxG) maxG = g5;
    if (b5 < minB) minB = b5;
    if (b5 > maxB) maxB = b5;
  }

  return { buckets, count, minR, maxR, minG, maxG, minB, maxB };
}

function quantizeFrameToPalette(
  frame: PixelFrame,
  lct: Buffer,
  indices: Uint8Array,
): void {
  lct.fill(0);
  const { width, height, data } = frame;
  const pixelCount = width * height;

  // 1차 시도: 고유 불투명 색상이 255개 이하인 벡터 아트워크는 무손실 정확 매핑
  const exactMap = new Map<number, number>();
  let exceedsExact = false;

  for (let p = 0; p < pixelCount; p++) {
    const idx = p * 4;
    if (data[idx + 3] < 128) {
      indices[p] = TRANSPARENT_INDEX;
      continue;
    }

    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const key = (r << 16) | (g << 8) | b;
    let palIdx = exactMap.get(key);
    if (palIdx === undefined) {
      if (exactMap.size >= MAX_OPAQUE_COLORS) {
        exceedsExact = true;
        break;
      }
      palIdx = exactMap.size;
      exactMap.set(key, palIdx);
      const lctOff = palIdx * 3;
      lct[lctOff] = r;
      lct[lctOff + 1] = g;
      lct[lctOff + 2] = b;
    }
    indices[p] = palIdx;
  }

  if (!exceedsExact) {
    return;
  }

  // 2차 시도: 15-bit RGB(5-5-5) 히스토그램 + Median-Cut 양자화 (최대 255색)
  const bucketCounts = new Int32Array(32768);
  const bucketSumR = new Float64Array(32768);
  const bucketSumG = new Float64Array(32768);
  const bucketSumB = new Float64Array(32768);
  const activeBuckets: number[] = [];

  for (let p = 0; p < pixelCount; p++) {
    const idx = p * 4;
    if (data[idx + 3] < 128) continue;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const b15 = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    if (bucketCounts[b15] === 0) {
      activeBuckets.push(b15);
    }
    bucketCounts[b15]++;
    bucketSumR[b15] += r;
    bucketSumG[b15] += g;
    bucketSumB[b15] += b;
  }

  if (activeBuckets.length === 0) {
    indices.fill(TRANSPARENT_INDEX);
    return;
  }

  const boxes: ColorBox[] = [buildBox(activeBuckets, bucketCounts)];
  while (boxes.length < MAX_OPAQUE_COLORS) {
    let bestBoxIdx = -1;
    let bestScore = -1;

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.buckets.length <= 1) continue;
      const span = Math.max(
        box.maxR - box.minR,
        box.maxG - box.minG,
        box.maxB - box.minB,
      );
      const score = span * box.count;
      if (score > bestScore) {
        bestScore = score;
        bestBoxIdx = i;
      }
    }

    if (bestBoxIdx === -1) break;

    const target = boxes[bestBoxIdx];
    const rangeR = target.maxR - target.minR;
    const rangeG = target.maxG - target.minG;
    const rangeB = target.maxB - target.minB;
    const shift = rangeR >= rangeG && rangeR >= rangeB ? 10 : rangeG >= rangeR && rangeG >= rangeB ? 5 : 0;
    target.buckets.sort((a, b) => ((a >>> shift) & 0x1f) - ((b >>> shift) & 0x1f));

    const halfCount = target.count / 2;
    let running = 0;
    let splitIdx = 1;
    for (let i = 0; i < target.buckets.length - 1; i++) {
      running += bucketCounts[target.buckets[i]];
      if (running >= halfCount) {
        splitIdx = Math.max(1, i + 1);
        break;
      }
    }

    const leftBuckets = target.buckets.slice(0, splitIdx);
    const rightBuckets = target.buckets.slice(splitIdx);
    boxes.splice(
      bestBoxIdx,
      1,
      buildBox(leftBuckets, bucketCounts),
      buildBox(rightBuckets, bucketCounts),
    );
  }

  const lut15 = new Uint8Array(32768);
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    let totalR = 0;
    let totalG = 0;
    let totalB = 0;
    let totalCnt = 0;
    for (let j = 0; j < box.buckets.length; j++) {
      const b15 = box.buckets[j];
      totalR += bucketSumR[b15];
      totalG += bucketSumG[b15];
      totalB += bucketSumB[b15];
      totalCnt += bucketCounts[b15];
      lut15[b15] = i;
    }
    const lctOff = i * 3;
    if (totalCnt > 0) {
      lct[lctOff] = Math.round(totalR / totalCnt);
      lct[lctOff + 1] = Math.round(totalG / totalCnt);
      lct[lctOff + 2] = Math.round(totalB / totalCnt);
    }
  }

  for (let p = 0; p < pixelCount; p++) {
    const idx = p * 4;
    if (data[idx + 3] < 128) {
      indices[p] = TRANSPARENT_INDEX;
    } else {
      const b15 = ((data[idx] >> 3) << 10) | ((data[idx + 1] >> 3) << 5) | (data[idx + 2] >> 3);
      indices[p] = lut15[b15];
    }
  }
}

function encodeLzwSubBlocks(indices: Uint8Array, dict: Int32Array): Buffer {
  dict.fill(-1);
  let codeSize = LZW_MIN_CODE_SIZE + 1; // 9
  let nextCode = LZW_EOI_CODE + 1; // 258
  let bitBuf = 0;
  let bitCount = 0;
  const rawBytes: number[] = [];

  const emitCode = (code: number, size: number) => {
    bitBuf |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      rawBytes.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };

  emitCode(LZW_CLEAR_CODE, codeSize);

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const suffix = indices[i];
    const key = (prefix << 8) | suffix;
    const found = dict[key];
    if (found !== -1) {
      prefix = found;
    } else {
      emitCode(prefix, codeSize);
      if (nextCode < LZW_MAX_TABLE_SIZE) {
        dict[key] = nextCode;
        if (nextCode === 1 << codeSize && codeSize < 12) {
          codeSize++;
        }
        nextCode++;
      } else {
        emitCode(LZW_CLEAR_CODE, codeSize);
        dict.fill(-1);
        codeSize = LZW_MIN_CODE_SIZE + 1;
        nextCode = LZW_EOI_CODE + 1;
      }
      prefix = suffix;
    }
  }

  emitCode(prefix, codeSize);
  emitCode(LZW_EOI_CODE, codeSize);
  if (bitCount > 0) {
    rawBytes.push(bitBuf & 0xff);
  }

  // [minCodeSize] + [255바이트 이하 서브블록들] + [0x00 종단자]
  const subBlockCount = Math.ceil(rawBytes.length / 255);
  const out = Buffer.allocUnsafe(1 + rawBytes.length + subBlockCount + 1);
  let offset = 0;
  out[offset++] = LZW_MIN_CODE_SIZE;

  for (let pos = 0; pos < rawBytes.length; pos += 255) {
    const chunkLen = Math.min(255, rawBytes.length - pos);
    out[offset++] = chunkLen;
    for (let k = 0; k < chunkLen; k++) {
      out[offset++] = rawBytes[pos + k];
    }
  }
  out[offset++] = 0x00;

  return out;
}

/**
 * RGBA PixelFrame 배열을 외부 네이티브 애드온 없이 순수 TypeScript GIF89a(255색 양자화 + 투명 + LZW) 버퍼로 인코딩한다.
 */
export function encodeFramesToGif(
  frames: PixelFrame[],
  options?: GifEncodeOptions,
): Buffer {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new RangeError('encodeFramesToGif requires at least one frame');
  }

  const width = frames[0]?.width ?? 0;
  const height = frames[0]?.height ?? 0;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('Invalid PixelFrame dimensions for GIF encoding');
  }
  if (width > 0xffff || height > 0xffff) {
    throw new RangeError('GIF dimensions exceed 16-bit maximum (65535)');
  }

  const expectedByteLen = width * height * 4;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (
      !f ||
      f.width !== width ||
      f.height !== height ||
      !f.data ||
      f.data.byteLength < expectedByteLen
    ) {
      throw new RangeError(`Frame ${i} dimensions or RGBA buffer length mismatch`);
    }
  }

  const rawFps = Number.isFinite(options?.fps) ? options!.fps! : 20;
  const fps = Math.min(50, Math.max(1, Math.round(rawFps)));
  const delayCs = Math.max(2, Math.round(100 / fps));
  const shouldLoop = options?.loop !== false;

  const chunks: Buffer[] = [];

  // 1. GIF89a Header (6B) + Logical Screen Descriptor (7B)
  const headerAndLsd = Buffer.alloc(13);
  headerAndLsd.write('GIF89a', 0, 'ascii');
  headerAndLsd.writeUInt16LE(width, 6);
  headerAndLsd.writeUInt16LE(height, 8);
  headerAndLsd[10] = 0x70; // GCT=0, 8-bit color resolution
  headerAndLsd[11] = TRANSPARENT_INDEX;
  chunks.push(headerAndLsd);

  // 2. Netscape 2.0 Looping App Extension (19B)
  if (shouldLoop) {
    chunks.push(NETSCAPE_LOOP_EXT);
  }

  // 프레임 공통 Graphic Control Extension (8B) + Image Descriptor (10B)
  const frameHeader = Buffer.alloc(18);
  frameHeader[0] = 0x21;
  frameHeader[1] = 0xf9;
  frameHeader[2] = 0x04;
  frameHeader[3] = 0x09; // Disposal 2 (Restore to Background) + Transparent Flag
  frameHeader.writeUInt16LE(delayCs, 4);
  frameHeader[6] = TRANSPARENT_INDEX;
  frameHeader[8] = 0x2c;
  frameHeader.writeUInt16LE(width, 13);
  frameHeader.writeUInt16LE(height, 15);
  frameHeader[17] = 0x87; // Local Color Table enabled, size=2^(7+1)=256

  // 프레임 간 단일 재사용 버퍼 (GC 최소화)
  const dict = new Int32Array(LZW_MAX_TABLE_SIZE * 256);
  const indices = new Uint8Array(width * height);

  for (let i = 0; i < frames.length; i++) {
    const lct = Buffer.alloc(768);
    quantizeFrameToPalette(frames[i], lct, indices);
    chunks.push(frameHeader, lct, encodeLzwSubBlocks(indices, dict));
  }

  chunks.push(GIF_TRAILER);
  return Buffer.concat(chunks);
}
