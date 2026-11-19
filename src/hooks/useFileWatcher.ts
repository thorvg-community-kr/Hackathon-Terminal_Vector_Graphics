import { useState, useEffect, useRef } from 'react';
import fs from 'node:fs';
import path from 'node:path';

export type HotReloadStatus = 'idle' | 'reloaded' | 'error' | 'deleted';

export interface FileWatcherOptions {
  debounceMs?: number;
  retryDelayMs?: number;
  badgeHoldMs?: number;
  enabled?: boolean;
  onReload: (newContent: string, byteSize: number) => boolean | void;
  onDelete?: (deletedPath: string) => void;
  onError?: (message: string) => void;
}

export interface FileWatcherState {
  status: HotReloadStatus;
  errorMessage: string | null;
  reloadCount: number;
}

const INVALID_SYNTAX_MSG = '⚠ Reload failed: invalid syntax';

function isWatchableLocalFile(filePath: string | null | undefined): filePath is string {
  if (!filePath) return false;
  if (filePath === '-' || filePath.startsWith('__folder__')) return false;
  if (/^https?:\/\//i.test(filePath)) return false;
  return true;
}

/**
 * 에디터 저장 중 비원자적 부분 쓰기(0B truncate / 깨진 JSON / 미완결 SVG)로 인해
 * 정상 화면이 깨지지 않도록 파일 콘텐츠 구문을 사전 검증한다.
 */
export function validateVectorContent(rawContent: string, filePath: string): boolean {
  if (!rawContent) return false;
  const trimmed = rawContent.trim();
  if (trimmed.length === 0) return false;

  const ext = path.extname(filePath).toLowerCase();
  const isSvg = ext === '.svg' || (!ext && trimmed.startsWith('<'));

  if (isSvg) {
    const masked = trimmed.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
    const openMatch = masked.match(/<svg\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/i);
    if (!openMatch) return false;

    const isSelfClosing = openMatch[1].trimEnd().endsWith('/');
    if (isSelfClosing) {
      return /\/>\s*$/i.test(masked.trimEnd());
    }
    return /<\/svg\s*>\s*$/i.test(masked);
  }

  try {
    const parsed = JSON.parse(trimmed);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as Record<string, unknown>).layers)
    );
  } catch {
    return false;
  }
}

/**
 * 부모 디렉터리 감시(`fs.watch`) + 대상 basename 필터링으로 `vim`/`VS Code` 등의
 * 원자적 `rename` 저장을 포착하고, `120ms` 디바운스 + `150ms` 1회 부분 쓰기 재시도 및
 * 언마운트·파일 변경 시 `watcher.close()`로 디스크립터 누수(`EMFILE`)를 차단한다.
 */
export function useFileWatcher(
  filePath: string | null | undefined,
  options: FileWatcherOptions,
): FileWatcherState {
  const [state, setState] = useState<FileWatcherState>({
    status: 'idle',
    errorMessage: null,
    reloadCount: 0,
  });

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const enabled = options.enabled ?? true;
  const debounceMs = options.debounceMs ?? 120;
  const retryDelayMs = options.retryDelayMs ?? 150;
  const badgeHoldMs = options.badgeHoldMs ?? 1500;

  useEffect(() => {
    setState({ status: 'idle', errorMessage: null, reloadCount: 0 });

    if (!enabled || !isWatchableLocalFile(filePath)) {
      return;
    }

    const absPath = path.resolve(filePath);
    const parentDir = path.dirname(absPath);
    const targetBase = path.basename(absPath);

    let disposed = false;
    let attemptSeq = 0;
    let watcher: fs.FSWatcher | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let badgeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastLoadedMeta: { mtimeMs: number; size: number; ino: number } | null = null;
    try {
      const initStat = fs.statSync(absPath);
      lastLoadedMeta = {
        mtimeMs: initStat.mtimeMs,
        size: initStat.size,
        ino: initStat.ino,
      };
    } catch {
      lastLoadedMeta = null;
    }

    const closeWatcher = () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (watcher) {
        try {
          watcher.removeAllListeners();
          watcher.close();
        } catch {
          // ignore already-closed handles
        }
        watcher = null;
      }
    };

    const scheduleRetryOrFail = (attempt: 1 | 2, seq: number, isEnoent = false) => {
      if (disposed || seq !== attemptSeq) return;
      if (attempt === 1) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void runReloadAttempt(2, seq);
        }, retryDelayMs);
        return;
      }

      if (isEnoent) {
        closeWatcher();
        setState((prev) => ({
          ...prev,
          status: 'deleted',
          errorMessage: null,
        }));
        optionsRef.current.onDelete?.(absPath);
        return;
      }

      setState((prev) => ({
        ...prev,
        status: 'error',
        errorMessage: INVALID_SYNTAX_MSG,
      }));
      optionsRef.current.onError?.(INVALID_SYNTAX_MSG);
    };

    const runReloadAttempt = async (attempt: 1 | 2, seq: number) => {
      if (disposed || seq !== attemptSeq) return;

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(absPath);
      } catch (err: any) {
        lastLoadedMeta = null;
        scheduleRetryOrFail(attempt, seq, err?.code === 'ENOENT');
        return;
      }

      if (
        lastLoadedMeta &&
        stat.mtimeMs === lastLoadedMeta.mtimeMs &&
        stat.size === lastLoadedMeta.size &&
        stat.ino === lastLoadedMeta.ino
      ) {
        return;
      }

      let rawContent: string;
      try {
        rawContent = await fs.promises.readFile(absPath, 'utf8');
      } catch (err: any) {
        lastLoadedMeta = null;
        scheduleRetryOrFail(attempt, seq, err?.code === 'ENOENT');
        return;
      }

      if (disposed || seq !== attemptSeq) return;

      const validSyntax = validateVectorContent(rawContent, absPath);
      const accepted = validSyntax
        ? optionsRef.current.onReload(rawContent, stat.size) !== false
        : false;

      if (!validSyntax || !accepted) {
        lastLoadedMeta = null;
        scheduleRetryOrFail(attempt, seq, false);
        return;
      }

      lastLoadedMeta = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };

      if (badgeTimer !== null) {
        clearTimeout(badgeTimer);
        badgeTimer = null;
      }
      setState((prev) => ({
        status: 'reloaded',
        errorMessage: null,
        reloadCount: prev.reloadCount + 1,
      }));
      badgeTimer = setTimeout(() => {
        badgeTimer = null;
        if (!disposed) {
          setState((prev) =>
            prev.status === 'reloaded' ? { ...prev, status: 'idle' } : prev,
          );
        }
      }, badgeHoldMs);
    };

    try {
      watcher = fs.watch(parentDir, { persistent: false }, (_eventType, changedFile) => {
        if (disposed) return;

        const changedName =
          changedFile === null || changedFile === undefined
            ? null
            : Buffer.isBuffer(changedFile)
              ? changedFile.toString('utf8')
              : String(changedFile);

        if (changedName !== null && changedName !== targetBase) {
          return;
        }

        if (debounceTimer !== null) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        if (retryTimer !== null) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }

        const seq = ++attemptSeq;
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          void runReloadAttempt(1, seq);
        }, debounceMs);
      });

      watcher.on('error', () => {
        if (disposed) return;
        closeWatcher();
      });
    } catch {
      closeWatcher();
    }

    return () => {
      disposed = true;
      attemptSeq++;
      if (badgeTimer !== null) {
        clearTimeout(badgeTimer);
        badgeTimer = null;
      }
      closeWatcher();
    };
  }, [filePath, enabled, debounceMs, retryDelayMs, badgeHoldMs]);

  return state;
}
