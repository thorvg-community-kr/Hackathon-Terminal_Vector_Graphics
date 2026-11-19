import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  extractDotLottie,
  isZipMagicBytes,
  MAX_DOTLOTTIE_UNCOMPRESSED_BYTES,
} from './dotLottieReader.js';

export const MAX_REMOTE_ASSET_BYTES = 25 * 1024 * 1024; // 25MB
export const DEFAULT_REMOTE_TIMEOUT_MS = 10_000; // 10s
const MAX_HTTP_REDIRECTS = 5;

export interface LoadedVectorAsset {
  format: 'svg' | 'lottie';
  sourceKind: 'file' | 'dotlottie' | 'url' | 'stdin';
  content: string;
  sourceLabel: string;
  byteSize: number;
  animationIds?: string[];
  containerFormat?: 'dotlottie' | 'plain';
}

export interface LoadVectorOptions {
  stdinStream?: Readable & { isTTY?: boolean };
  timeoutMs?: number;
  maxRemoteBytes?: number;
}

export function isUrlInput(source: string): boolean {
  const trimmed = source.trim();
  return (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ||
    /^(?:file|ftp|data|javascript|mailto|blob):/i.test(trimmed)
  );
}

function assertAllowedHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Error: Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Error: Unsupported URL scheme. Only http:// and https:// are allowed.');
  }
  return parsed;
}

function normalizeRemoteFetchError(err: unknown, url: string, timeoutMs: number): Error {
  if (err instanceof Error && err.message.startsWith('Error:')) {
    return err;
  }
  const anyErr = err as { name?: string; message?: string; cause?: { message?: string; code?: string } };
  if (anyErr?.name === 'TimeoutError' || anyErr?.name === 'AbortError') {
    return new Error(`Error: Request timed out after ${timeoutMs}ms while fetching ${url}`);
  }
  const detail = anyErr?.cause?.message || anyErr?.message || String(err);
  return new Error(`Error: Failed to fetch ${url} (${detail})`);
}

/**
 * http(s):// 원격 에셋을 10초 타임아웃, 리다이렉트 스킴 재검증, 25MB 스트리밍 상한으로 안전하게 수신한다.
 */
export async function fetchRemoteAssetBuffer(
  url: string,
  options?: { timeoutMs?: number; maxRemoteBytes?: number },
): Promise<{ buffer: Buffer; finalUrl: string }> {
  assertAllowedHttpUrl(url);

  const timeoutMs = options?.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  const maxRemoteBytes = options?.maxRemoteBytes ?? MAX_REMOTE_ASSET_BYTES;
  const signal = AbortSignal.timeout(timeoutMs);

  let currentUrl = url;
  let redirects = 0;

  try {
    while (true) {
      const res = await fetch(currentUrl, { signal, redirect: 'manual' });

      if (res.url) {
        assertAllowedHttpUrl(res.url);
      }

      if (
        res.status === 301 ||
        res.status === 302 ||
        res.status === 303 ||
        res.status === 307 ||
        res.status === 308
      ) {
        const location = res.headers.get('location');
        await res.body?.cancel?.().catch(() => {});
        if (!location) {
          throw new Error(`Error: HTTP ${res.status} while fetching ${currentUrl}`);
        }
        if (redirects >= MAX_HTTP_REDIRECTS) {
          throw new Error(`Error: Too many HTTP redirects while fetching ${url}`);
        }
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw new Error(`Error: Invalid redirect URL while fetching ${url}`);
        }
        if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
          throw new Error(
            'Error: Unsupported URL scheme. Only http:// and https:// are allowed.',
          );
        }
        currentUrl = nextUrl.toString();
        redirects++;
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel?.().catch(() => {});
        throw new Error(`Error: HTTP ${res.status} while fetching ${currentUrl}`);
      }

      const contentLengthHeader = res.headers.get('content-length');
      if (contentLengthHeader !== null) {
        const declaredLen = Number(contentLengthHeader);
        if (Number.isFinite(declaredLen) && declaredLen > maxRemoteBytes) {
          await res.body?.cancel?.().catch(() => {});
          throw new Error('Error: Remote asset exceeds maximum download size (25MB)');
        }
      }

      let buffer: Buffer;
      if (res.body) {
        const reader = res.body.getReader();
        const chunks: Buffer[] = [];
        let received = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              received += value.byteLength;
              if (received > maxRemoteBytes) {
                await reader.cancel().catch(() => {});
                throw new Error('Error: Remote asset exceeds maximum download size (25MB)');
              }
              chunks.push(Buffer.from(value));
            }
          }
        } finally {
          reader.releaseLock();
        }
        buffer = Buffer.concat(chunks, received);
      } else {
        const arr = await res.arrayBuffer();
        if (arr.byteLength > maxRemoteBytes) {
          throw new Error('Error: Remote asset exceeds maximum download size (25MB)');
        }
        buffer = Buffer.from(arr);
      }

      return { buffer, finalUrl: res.url || currentUrl };
    }
  } catch (err) {
    throw normalizeRemoteFetchError(err, currentUrl, timeoutMs);
  }
}

async function readStdinBuffer(
  stream: Readable & { isTTY?: boolean },
): Promise<Buffer> {
  if (stream.isTTY) {
    throw new Error('Error: "-" expects piped stdin input, but stdin is an interactive TTY.');
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > MAX_DOTLOTTIE_UNCOMPRESSED_BYTES) {
      if (typeof (stream as any).destroy === 'function') {
        (stream as any).destroy();
      }
      throw new Error('Error: stdin input exceeds maximum safe size (50MB).');
    }
    chunks.push(buf);
  }

  const combined = Buffer.concat(chunks, totalBytes);
  if (combined.length === 0) {
    throw new Error('Error: Empty input received from stdin.');
  }
  return combined;
}

/**
 * 로컬 파일(.svg / .json / .lottie), 원격 URL(http/https), stdin(-) 입력을
 * 단일 LoadedVectorAsset 계약으로 안전하게 적재·판별한다.
 */
export async function loadVectorAsset(
  source: string,
  subAnimationId?: string,
  options?: LoadVectorOptions,
): Promise<LoadedVectorAsset> {
  const trimmedSource = source.trim();
  if (!trimmedSource) {
    throw new Error('Error: Vector asset source is required.');
  }

  let buffer: Buffer;
  let sourceKindBase: 'file' | 'url' | 'stdin';
  let sourceLabel: string;
  let hintLower: string;

  if (trimmedSource === '-') {
    const stream = options?.stdinStream ?? process.stdin;
    buffer = await readStdinBuffer(stream);
    sourceKindBase = 'stdin';
    sourceLabel = 'stdin';
    hintLower = '';
  } else if (isUrlInput(trimmedSource)) {
    const remote = await fetchRemoteAssetBuffer(trimmedSource, {
      timeoutMs: options?.timeoutMs,
      maxRemoteBytes: options?.maxRemoteBytes,
    });
    buffer = remote.buffer;
    sourceKindBase = 'url';
    sourceLabel = trimmedSource;
    hintLower = new URL(remote.finalUrl).pathname.toLowerCase();
  } else {
    const resolvedPath = path.resolve(trimmedSource);
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(resolvedPath);
    } catch (err: any) {
      if (err?.code === 'EACCES' || err?.code === 'EPERM') {
        throw new Error(`Error: Permission denied reading "${trimmedSource}"`);
      }
      throw new Error(`Error: File not found: "${trimmedSource}"`);
    }
    if (!stats.isFile()) {
      throw new Error(`Error: Not a regular file: "${trimmedSource}"`);
    }
    if (stats.size <= 0) {
      throw new Error(`Error: Empty vector asset file: "${trimmedSource}"`);
    }
    if (stats.size > MAX_DOTLOTTIE_UNCOMPRESSED_BYTES) {
      throw new Error('Error: Vector asset file exceeds maximum safe size (50MB).');
    }

    buffer = await fs.promises.readFile(resolvedPath);
    sourceKindBase = 'file';
    sourceLabel = resolvedPath;
    hintLower = resolvedPath.toLowerCase();
  }

  if (isZipMagicBytes(buffer) || hintLower.endsWith('.lottie')) {
    const extracted = extractDotLottie(buffer, subAnimationId);
    return {
      format: 'lottie',
      sourceKind: sourceKindBase === 'file' ? 'dotlottie' : sourceKindBase,
      content: extracted.content,
      sourceLabel,
      byteSize: buffer.length,
      animationIds: extracted.animationIds,
      containerFormat: 'dotlottie',
    };
  }

  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  const trimmedText = text.trimStart();

  if (trimmedText.startsWith('<') && /<svg\b/i.test(trimmedText)) {
    return {
      format: 'svg',
      sourceKind: sourceKindBase,
      content: text,
      sourceLabel,
      byteSize: buffer.length,
      containerFormat: 'plain',
    };
  }

  if (trimmedText.startsWith('{')) {
    let parsed: any;
    try {
      parsed = JSON.parse(trimmedText);
    } catch {
      throw new Error(`Error: Invalid Lottie JSON in "${sourceLabel}"`);
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !Array.isArray(parsed.layers)
    ) {
      throw new Error(`Error: JSON is not a valid Lottie animation in "${sourceLabel}"`);
    }
    return {
      format: 'lottie',
      sourceKind: sourceKindBase,
      content: text,
      sourceLabel,
      byteSize: buffer.length,
      containerFormat: 'plain',
    };
  }

  throw new Error(
    `Error: Unsupported or invalid vector asset "${sourceLabel}" (expected SVG, Lottie JSON, or .lottie).`,
  );
}
