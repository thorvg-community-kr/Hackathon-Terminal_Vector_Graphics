import { useState, useEffect, useCallback, useRef } from 'react';
import fs from 'fs';
import path from 'path';
import {
  isZipMagicBytes,
  MAX_DOTLOTTIE_UNCOMPRESSED_BYTES,
} from '../loaders/dotLottieReader.js';

export interface FileItem {
  label: string;
  value: string;
  meta: {
    duration: number;
    size: string;
  };
}

export interface ScanOptions {
  maxDepth?: number;
  maxFileBytes?: number;
  signal?: AbortSignal;
}

export const MAX_SCAN_FILE_BYTES = 25 * 1024 * 1024; // 25MB OOM 방어 상한

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  '.cache',
]);

const EXCLUDED_JSON_FILES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'composer.json',
  'devcontainer.json',
  'biome.json',
  'renovate.json',
  'vercel.json',
  'manifest.json',
]);

const CONFIG_JSON_PATTERN = /^(tsconfig|jsconfig|\.eslintrc|\.prettierrc)(\..+)?\.json$/i;

/**
 * 명백한 프로젝트 설정/락파일 JSON인지 파일명 기준으로 O(1) 판별한다.
 */
export function isExcludedJsonFilename(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return EXCLUDED_JSON_FILES.has(lower) || CONFIG_JSON_PATTERN.test(fileName);
}

/**
 * 1단계 고속 부분 문자열 필터 + 2단계 구조 검증으로 유효한 Lottie JSON 여부를 판별한다.
 * 대용량 비-Lottie 데이터 JSON에 대한 불필요한 JSON.parse 비용을 제거한다.
 */
export function isLikelyLottieJson(content: string): boolean {
  if (!content.includes('"layers"') || (!content.includes('"v"') && !content.includes('"fr"'))) {
    return false;
  }

  try {
    const data: unknown = JSON.parse(content);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return false;
    }
    const obj = data as Record<string, unknown>;
    if (!Array.isArray(obj.layers)) {
      return false;
    }
    return 'v' in obj || 'fr' in obj;
  } catch {
    return false;
  }
}

/** 스캔 시 JSON 판별에 읽는 최대 헤드 바이트 수 (전체 읽기/파싱은 재생 시 로더가 수행) */
export const JSON_HEAD_BYTES = 64 * 1024;

/**
 * 대용량 JSON의 헤드 청크만으로 Lottie 여부를 추정한다.
 * Lottie 루트 키(`v`/`fr`/`ip`/`op`)는 앞쪽에 오지만 `layers`는 큰 `assets` 뒤에 올 수 있다.
 */
export function isLikelyLottieHead(head: string): boolean {
  if (!head.trimStart().startsWith('{')) return false;
  if (head.includes('"layers"') && (head.includes('"v"') || head.includes('"fr"'))) return true;
  return head.includes('"fr"') && head.includes('"op"');
}

/** 파일 앞부분만 읽어 Lottie 여부를 판별한다. 헤드가 파일 전체면 정밀 판별을 사용한다. */
async function isLottieJsonFile(fullPath: string, size: number): Promise<boolean> {
  const handle = await fs.promises.open(fullPath, 'r');
  try {
    const len = Math.min(size, JSON_HEAD_BYTES);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await handle.read(buf, 0, len, 0);
    const head = buf.toString('utf8', 0, bytesRead);
    return size <= JSON_HEAD_BYTES ? isLikelyLottieJson(head) : isLikelyLottieHead(head);
  } finally {
    await handle.close();
  }
}

/** .lottie 파일 선두 4바이트가 PK\x03\x04 ZIP 매직 헤더인지 경량 검사한다. */
async function isDotLottieMagicFile(fullPath: string): Promise<boolean> {
  const handle = await fs.promises.open(fullPath, 'r');
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buf, 0, 4, 0);
    return bytesRead === 4 && isZipMagicBytes(buf);
  } finally {
    await handle.close();
  }
}

/**
 * 비동기 경량 벡터 에셋 스캐너.
 * - `entry.isSymbolicLink()` + `visitedRealPaths`(realpath) 이중 가드로 심볼릭 링크 무한 루프 차단
 * - `25MB` 상한으로 V8 OOM 방지
 * - 25개 엔트리마다 `setImmediate` 양보로 UI/애니메이션 30fps 반응성 유지
 */
export async function scanDirectoryAsync(
  dir: string,
  options: ScanOptions = {},
): Promise<FileItem[]> {
  const maxDepth = options.maxDepth ?? 1;
  const maxFileBytes = options.maxFileBytes ?? MAX_SCAN_FILE_BYTES;
  const signal = options.signal;
  const visitedRealPaths = new Set<string>();

  async function scanRecursive(currentDir: string, currentDepth: number): Promise<FileItem[]> {
    if (signal?.aborted || currentDepth > maxDepth) {
      return [];
    }

    let realDir: string;
    try {
      realDir = await fs.promises.realpath(currentDir);
    } catch {
      return [];
    }

    if (visitedRealPaths.has(realDir)) {
      return [];
    }
    visitedRealPaths.add(realDir);

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return [];
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    const filesInThisDir: FileItem[] = [];
    let subDirResults: FileItem[] = [];
    let processedCount = 0;

    for (const entry of entries) {
      if (signal?.aborted) {
        return [];
      }

      if (++processedCount % 25 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (signal?.aborted) {
          return [];
        }
      }

      const fullPath = path.join(currentDir, entry.name);

      // 디렉터리 심볼릭 링크는 절대 재귀 탐색하지 않고, 깨진 심볼릭 링크도 안전 무시
      let isFileCandidate = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const linkStat = await fs.promises.stat(fullPath);
          if (linkStat.isDirectory() || !linkStat.isFile()) {
            continue;
          }
          isFileCandidate = true;
        } catch {
          continue;
        }
      }

      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name) && currentDepth < maxDepth) {
          const sub = await scanRecursive(fullPath, currentDepth + 1);
          subDirResults = subDirResults.concat(sub);
        }
        continue;
      }

      if (!isFileCandidate) {
        continue;
      }

      const lower = entry.name.toLowerCase();
      const isSvg = lower.endsWith('.svg');
      const isJson = lower.endsWith('.json');
      const isDotLottie = lower.endsWith('.lottie');
      if (!isSvg && !isJson && !isDotLottie) {
        continue;
      }

      if (isJson && isExcludedJsonFilename(entry.name)) {
        continue;
      }

      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(fullPath);
      } catch {
        continue;
      }

      const effectiveMaxBytes =
        options.maxFileBytes ??
        (isDotLottie ? MAX_DOTLOTTIE_UNCOMPRESSED_BYTES : maxFileBytes);
      if (!stats.isFile() || stats.size <= 0 || stats.size > effectiveMaxBytes) {
        continue;
      }

      if (isJson) {
        try {
          if (!(await isLottieJsonFile(fullPath, stats.size))) {
            continue;
          }
        } catch {
          if (signal?.aborted) {
            return [];
          }
          continue;
        }
      } else if (isDotLottie) {
        try {
          if (!(await isDotLottieMagicFile(fullPath))) {
            continue;
          }
        } catch {
          if (signal?.aborted) {
            return [];
          }
          continue;
        }
      }

      const sizeKb = (stats.size / 1024).toFixed(1) + 'kb';
      const indent = '  '.repeat(currentDepth);

      filesInThisDir.push({
        label: `${indent}📄 ${entry.name}`,
        value: fullPath,
        meta: { duration: 0, size: sizeKb },
      });
    }

    if (signal?.aborted) {
      return [];
    }

    const results: FileItem[] = [];
    const dirName = path.basename(currentDir) || currentDir;

    if (currentDepth > 0 && (filesInThisDir.length > 0 || subDirResults.length > 0)) {
      const indent = '  '.repeat(currentDepth - 1);
      results.push({
        label: `${indent}📂 ${dirName}`,
        value: `__folder__${currentDir}`,
        meta: { duration: 0, size: '-' },
      });
    }

    return results.concat(filesInThisDir, subDirResults);
  }

  return scanRecursive(dir, 0);
}

export function useFileScanner(
  initialPath: string = process.cwd(),
  initialDepth = 1,
  initialError: string | null = null,
) {
  const [fileList, setFileList] = useState<FileItem[]>([]);
  const [isScanning, setIsScanning] = useState(Boolean(initialPath));
  const [scanDepth, setScanDepth] = useState(initialDepth);
  const [basePath, setBasePath] = useState(initialPath);
  const [scanError, setScanError] = useState<string | null>(initialError);
  const [scanSeq, setScanSeq] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!basePath) {
      setFileList([]);
      setIsScanning(false);
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsScanning(true);

    (async () => {
      try {
        const items = await scanDirectoryAsync(basePath, {
          maxDepth: scanDepth,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        if (items.length > 0) {
          setFileList((prevList) =>
            items.map((newItem) => {
              const existing = prevList.find((f) => f.value === newItem.value);
              if (existing && existing.meta.duration > 0) {
                newItem.meta.duration = existing.meta.duration;
              }
              return newItem;
            }),
          );
        } else {
          setFileList([{ label: 'No files found', value: '', meta: { duration: 0, size: '0kb' } }]);
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          const msg = e instanceof Error ? e.message : String(e);
          setScanError('❌ 스캔 실패: ' + msg);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsScanning(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [scanDepth, basePath, scanSeq]);

  /** 입력 경로를 비동기 검증한 뒤 유효한 디렉터리일 때만 전환하고, 실패 시 기존 목록을 보존한다 */
  const submitPath = useCallback(async (targetPath: string): Promise<boolean> => {
    const trimmed = targetPath.trim();
    if (!trimmed) {
      setScanError('❌ 존재하지 않는 경로입니다');
      return false;
    }

    const resolved = path.resolve(trimmed);
    try {
      const stats = await fs.promises.stat(resolved);
      if (!stats.isDirectory()) {
        setScanError('❌ 존재하지 않는 경로입니다');
        return false;
      }
    } catch (err: any) {
      if (err?.code === 'EACCES' || err?.code === 'EPERM') {
        setScanError('❌ 접근 권한이 없는 경로입니다');
      } else {
        setScanError('❌ 존재하지 않는 경로입니다');
      }
      return false;
    }

    setScanError(null);
    setBasePath(resolved);
    setScanDepth(1);
    setScanSeq((s) => s + 1);
    return true;
  }, []);

  /** 재귀 스캔 깊이를 0 -> 1 -> 2 -> 3 -> 0 순으로 순환 */
  const cycleScanDepth = useCallback(() => {
    setScanDepth((prev) => (prev + 1) % 4);
  }, []);

  /** 특정 파일의 duration 메타데이터를 갱신 */
  const updateFileDuration = useCallback((filePath: string, duration: number) => {
    const rounded = Math.round(duration * 100) / 100;
    setFileList((prev) =>
      prev.map((f) =>
        f.value === filePath ? { ...f, meta: { ...f.meta, duration: rounded } } : f,
      ),
    );
  }, []);

  /** 파일 리스트 선두에 새 파일을 추가 */
  const prependFile = useCallback((file: FileItem) => {
    setFileList((prev) => [file, ...prev]);
  }, []);

  return {
    fileList,
    isScanning,
    scanDepth,
    setScanDepth,
    basePath,
    setBasePath,
    scanError,
    setScanError,
    submitPath,
    cycleScanDepth,
    updateFileDuration,
    prependFile,
  };
}
