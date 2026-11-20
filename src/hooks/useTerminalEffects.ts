import { useState, useEffect, useRef, useCallback } from 'react';
import { useApp, useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

/**
 * process.stdout resize 이벤트를 80ms 디바운스하고 언마운트 가드를 제공하는 공용 터미널 크기 훅.
 */
export function useTerminalSize(defaultCols = 100, defaultRows = 40): TerminalSize {
  const { stdout } = useStdout();
  const [termSize, setTermSize] = useState<TerminalSize>(() => ({
    columns: stdout?.columns || process.stdout.columns || defaultCols,
    rows: stdout?.rows || process.stdout.rows || defaultRows,
  }));
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    const onResize = () => {
      if (resizeTimerRef.current !== null) {
        clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null;
        if (!isMountedRef.current) return;
        setTermSize({
          columns: process.stdout.columns || stdout?.columns || defaultCols,
          rows: process.stdout.rows || stdout?.rows || defaultRows,
        });
      }, 80);
    };
    process.stdout.on('resize', onResize);
    return () => {
      isMountedRef.current = false;
      if (resizeTimerRef.current !== null) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      process.stdout.off('resize', onResize);
    };
  }, [defaultCols, defaultRows, stdout]);

  return termSize;
}

/**
 * SIGINT/SIGTERM/SIGHUP 시그널 수신 시 정리 콜백 실행 후 Ink 앱을 정상 종료한다.
 */
export function useGracefulExit(onCleanup?: () => void): () => void {
  const { exit } = useApp();
  const cleanupRef = useRef(onCleanup);
  cleanupRef.current = onCleanup;

  const quit = useCallback(() => {
    cleanupRef.current?.();
    exit();
  }, [exit]);

  useEffect(() => {
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
    process.on('SIGHUP', quit);
    return () => {
      process.off('SIGINT', quit);
      process.off('SIGTERM', quit);
      process.off('SIGHUP', quit);
    };
  }, [quit]);

  return quit;
}
