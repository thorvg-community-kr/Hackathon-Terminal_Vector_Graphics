import zlib from 'node:zlib';
import path from 'node:path';

export const MAX_DOTLOTTIE_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50MB
export const MAX_DOTLOTTIE_ENTRIES = 200;

const ZIP_LOCAL_FILE_HEADER_SIG = 0x04034b50;
const ZIP_CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_EOCD_MIN_SIZE = 22;
const ZIP_MAX_COMMENT_LEN = 65535;

export interface DotLottieExtractionResult {
  content: string;
  selectedAnimationId: string;
  animationIds: string[];
  uncompressedBytes: number;
}

/**
 * 버퍼 선두 4바이트가 PKWARE ZIP 로컬 헤더 매직 바이트(PK\x03\x04)인지 판별한다.
 */
export function isZipMagicBytes(buf: Buffer): boolean {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === ZIP_LOCAL_FILE_HEADER_SIG;
}

/**
 * Zip-Slip 경로 순회 및 비정상 경로(\0, 선행 /, 역슬래시 \, 드라이브 문자, ..)를 차단한다.
 */
export function isSafeZipEntryPath(entryName: string): boolean {
  if (!entryName || entryName.includes('\0')) return false;
  if (entryName.startsWith('/') || entryName.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(entryName)) return false;
  const segments = entryName.split('/');
  return !segments.some((seg) => seg === '..');
}

function detectImageMimeType(buf: Buffer, filename: string): string {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'GIF8') {
    return 'image/gif';
  }
  const head = buf.toString('utf8', 0, Math.min(256, buf.length)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'image/svg+xml';
  }

  const ext = path.posix.extname(filename).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function findEocdOffset(buf: Buffer): number {
  const minPos = Math.max(0, buf.length - ZIP_EOCD_MIN_SIZE - ZIP_MAX_COMMENT_LEN);
  for (let pos = buf.length - ZIP_EOCD_MIN_SIZE; pos >= minPos; pos--) {
    if (buf.readUInt32LE(pos) !== ZIP_EOCD_SIG) continue;
    const commentLen = buf.readUInt16LE(pos + 20);
    if (pos + ZIP_EOCD_MIN_SIZE + commentLen === buf.length) {
      return pos;
    }
  }
  return -1;
}

function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function inlineLottieAssets(
  parsed: Record<string, any>,
  entriesMap: Map<string, Buffer>,
): boolean {
  if (!Array.isArray(parsed.assets)) return false;

  let modified = false;
  for (const asset of parsed.assets) {
    if (!asset || typeof asset !== 'object') continue;
    if (typeof asset.p !== 'string' || asset.p.length === 0 || asset.p.startsWith('data:')) {
      continue;
    }

    const rawP = asset.p.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
    const uPrefix =
      typeof asset.u === 'string'
        ? asset.u.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+|\/+$/g, '')
        : '';
    const joined = uPrefix ? path.posix.normalize(`${uPrefix}/${rawP}`) : rawP;
    const baseP = path.posix.basename(rawP);

    const candidates = new Set<string>();
    if (isSafeZipEntryPath(joined)) {
      candidates.add(joined);
    }
    if (baseP && isSafeZipEntryPath(baseP)) {
      candidates.add(`images/${baseP}`);
      candidates.add(`i/${baseP}`);
    }
    if (isSafeZipEntryPath(rawP)) {
      candidates.add(rawP);
      candidates.add(`images/${rawP}`);
      candidates.add(`i/${rawP}`);
    }

    let matchedBuf: Buffer | undefined;
    let matchedName = rawP;
    for (const candidate of candidates) {
      const found = entriesMap.get(candidate);
      if (found) {
        matchedBuf = found;
        matchedName = candidate;
        break;
      }
    }

    if (matchedBuf) {
      const mime = detectImageMimeType(matchedBuf, matchedName);
      asset.p = `data:${mime};base64,${matchedBuf.toString('base64')}`;
      asset.u = '';
      asset.e = 1;
      modified = true;
    }
  }

  return modified;
}

/**
 * 외부 의존성 없이 Node 내장 zlib + ZIP EOCD/Central Directory 파서로
 * `.lottie`(dotLottie v1/v2) 컨테이너를 메모리에서 안전하게 추출한다.
 */
export function extractDotLottie(
  zipBuffer: Buffer,
  subAnimationId?: string,
): DotLottieExtractionResult {
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length < ZIP_EOCD_MIN_SIZE) {
    throw new Error('Error: Invalid .lottie archive (truncated ZIP)');
  }

  const eocdOffset = findEocdOffset(zipBuffer);
  if (eocdOffset < 0) {
    throw new Error('Error: Invalid .lottie archive (missing ZIP EOCD)');
  }

  const diskNum = zipBuffer.readUInt16LE(eocdOffset + 4);
  const cdStartDisk = zipBuffer.readUInt16LE(eocdOffset + 6);
  if (diskNum !== 0 || cdStartDisk !== 0) {
    throw new Error('Error: Multi-disk .lottie archives are not supported');
  }

  const entriesOnDisk = zipBuffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdSize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  if (
    totalEntries === 0xffff ||
    entriesOnDisk === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    throw new Error('Error: .lottie archive exceeds maximum safe size (50MB)');
  }

  if (totalEntries > MAX_DOTLOTTIE_ENTRIES) {
    throw new Error(
      `Error: .lottie archive exceeds maximum safe entry count (${MAX_DOTLOTTIE_ENTRIES})`,
    );
  }

  const cdEnd = cdOffset + cdSize;
  if (cdOffset > eocdOffset || cdEnd > eocdOffset) {
    throw new Error('Error: Invalid .lottie archive (corrupt central directory bounds)');
  }

  const entriesMap = new Map<string, Buffer>();
  let offset = cdOffset;
  let parsedEntries = 0;
  let cumulativeBytes = 0;

  while (parsedEntries < totalEntries && offset < cdEnd) {
    if (parsedEntries >= MAX_DOTLOTTIE_ENTRIES) {
      throw new Error(
        `Error: .lottie archive exceeds maximum safe entry count (${MAX_DOTLOTTIE_ENTRIES})`,
      );
    }
    if (offset + 46 > cdEnd) {
      throw new Error('Error: Invalid .lottie archive (truncated central directory entry)');
    }
    if (zipBuffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIR_HEADER_SIG) {
      throw new Error('Error: Invalid .lottie archive (bad central directory signature)');
    }

    const bitFlag = zipBuffer.readUInt16LE(offset + 8);
    const compressionMethod = zipBuffer.readUInt16LE(offset + 10);
    const compressedSize = zipBuffer.readUInt32LE(offset + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 24);
    const fileNameLen = zipBuffer.readUInt16LE(offset + 28);
    const extraLen = zipBuffer.readUInt16LE(offset + 30);
    const commentLen = zipBuffer.readUInt16LE(offset + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);

    const nextOffset = offset + 46 + fileNameLen + extraLen + commentLen;
    if (nextOffset > cdEnd) {
      throw new Error('Error: Invalid .lottie archive (truncated central directory record)');
    }

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new Error('Error: .lottie archive exceeds maximum safe size (50MB)');
    }

    const rawEntryName = zipBuffer.toString('utf8', offset + 46, offset + 46 + fileNameLen);
    offset = nextOffset;
    parsedEntries++;

    // 디렉터리 및 경로 순회/역슬래시 악성 엔트리는 압축 해제 전 즉시 건너뜀
    if (rawEntryName.endsWith('/') || !isSafeZipEntryPath(rawEntryName)) {
      continue;
    }

    if (bitFlag & 0x0001) {
      throw new Error('Error: Encrypted .lottie archives are not supported');
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error(
        `Error: Unsupported .lottie ZIP compression method (${compressionMethod})`,
      );
    }

    const remainingBudget = MAX_DOTLOTTIE_UNCOMPRESSED_BYTES - cumulativeBytes;
    if (uncompressedSize > remainingBudget) {
      throw new Error('Error: .lottie archive exceeds maximum safe size (50MB)');
    }

    if (localHeaderOffset + 30 > zipBuffer.length) {
      throw new Error('Error: Invalid .lottie archive (local file header out of bounds)');
    }
    if (zipBuffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER_SIG) {
      throw new Error('Error: Invalid .lottie archive (bad local file header signature)');
    }

    const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataStart < 0 || dataEnd < dataStart || dataEnd > zipBuffer.length) {
      throw new Error('Error: Invalid .lottie archive (entry payload out of bounds)');
    }

    const compressedSlice = zipBuffer.subarray(dataStart, dataEnd);
    let entryData: Buffer;

    if (compressionMethod === 0) {
      if (compressedSlice.length > remainingBudget) {
        throw new Error('Error: .lottie archive exceeds maximum safe size (50MB)');
      }
      if (compressedSlice.length !== uncompressedSize) {
        throw new Error('Error: Invalid .lottie archive (stored entry size mismatch)');
      }
      entryData = Buffer.from(compressedSlice);
    } else {
      // C++ 레벨 maxOutputLength 가드로 헤더 위조 Deflate Zip-Bomb 차단 (0 전달 시 ERR_OUT_OF_RANGE 방지 위해 최소 1)
      const maxOutputLength = Math.max(1, remainingBudget);
      try {
        entryData = zlib.inflateRawSync(compressedSlice, { maxOutputLength });
      } catch (err: any) {
        if (
          err?.code === 'ERR_BUFFER_TOO_LARGE' ||
          err instanceof RangeError ||
          /maxOutputLength|too large/i.test(String(err?.message))
        ) {
          throw new Error('Error: .lottie archive exceeds maximum safe size (50MB)');
        }
        throw new Error(
          `Error: Failed to decompress .lottie entry "${rawEntryName}": ${err?.message || String(err)}`,
        );
      }
      if (entryData.length > remainingBudget) {
        throw new Error('Error: .lottie archive exceeds maximum safe size (50MB)');
      }
    }

    cumulativeBytes += entryData.length;
    const normalizedName = rawEntryName.replace(/^(?:\.\/)+/, '');
    entriesMap.set(normalizedName, entryData);
  }

  const findAnimBuffer = (id: string): Buffer | undefined =>
    entriesMap.get(`animations/${id}.json`) ?? entriesMap.get(`a/${id}.json`);

  const animationIdSet = new Set<string>();
  const manifestBuf = entriesMap.get('manifest.json');
  if (manifestBuf) {
    let manifest: any;
    try {
      manifest = JSON.parse(stripUtf8Bom(manifestBuf.toString('utf8')));
    } catch {
      throw new Error('Error: Invalid manifest.json in .lottie archive');
    }
    if (manifest && Array.isArray(manifest.animations)) {
      for (const item of manifest.animations) {
        const id =
          typeof item === 'string'
            ? item
            : item && typeof item.id === 'string'
              ? item.id
              : null;
        if (id && findAnimBuffer(id)) {
          animationIdSet.add(id);
        }
      }
    }
  }

  // manifest.json이 없거나 비어 있는 비표준 아카이브 폴백 탐색
  for (const key of entriesMap.keys()) {
    const match = key.match(/^(?:animations|a)\/([^/]+)\.json$/);
    if (match && match[1]) {
      animationIdSet.add(match[1]);
    }
  }

  const animationIds = Array.from(animationIdSet);
  if (animationIds.length === 0) {
    throw new Error('Error: No animations found in .lottie archive');
  }

  const selectedAnimationId = subAnimationId && subAnimationId.length > 0
    ? subAnimationId
    : animationIds[0];

  const animBuf = findAnimBuffer(selectedAnimationId);
  if (!animBuf) {
    throw new Error(
      `Error: Animation "${selectedAnimationId}" not found in .lottie archive (available: ${animationIds.join(', ')})`,
    );
  }

  const rawAnimText = stripUtf8Bom(animBuf.toString('utf8'));
  let parsedAnim: any;
  try {
    parsedAnim = JSON.parse(rawAnimText);
  } catch {
    throw new Error(`Error: Invalid Lottie JSON in .lottie entry "${selectedAnimationId}"`);
  }

  if (!parsedAnim || typeof parsedAnim !== 'object' || Array.isArray(parsedAnim) || !Array.isArray(parsedAnim.layers)) {
    throw new Error(`Error: Invalid Lottie structure in .lottie entry "${selectedAnimationId}"`);
  }

  const modified = inlineLottieAssets(parsedAnim, entriesMap);
  return {
    content: modified ? JSON.stringify(parsedAnim) : rawAnimText,
    selectedAnimationId,
    animationIds,
    uncompressedBytes: cumulativeBytes,
  };
}
