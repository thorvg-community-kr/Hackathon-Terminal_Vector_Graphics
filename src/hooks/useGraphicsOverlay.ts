import { useState, useEffect, useCallback, useRef, type RefObject } from 'react';
import { useStdout, type DOMElement } from 'ink';
import type { EffectiveRenderMode } from '../renderers/headlessPipeline.js';
import { KITTY_CLEAR_SEQ } from '../renderers/kittyRenderer.js';

export interface PlaceholderLayout {
  offsetX: number;
  offsetY: number;
  rootHeight: number;
}

export interface GraphicsOverlayState {
  placeholderRef: RefObject<DOMElement>;
  statusMessage: string | null;
  handleGraphicsFrame: (output: string) => void;
  clearGraphicsState: () => void;
}

/**
 * Yoga DOMElement 부모 체인을 순회하여 터미널 화면 기준 (offsetX, offsetY, rootHeight)를 계산한다.
 */
export function computePlaceholderLayout(node: DOMElement | null): PlaceholderLayout {
  if (!node) return { offsetX: 0, offsetY: 0, rootHeight: 0 };
  let offsetX = 0;
  let offsetY = 0;
  let root: DOMElement = node;
  let cur: DOMElement | undefined = node;

  while (cur) {
    if (cur.yogaNode) {
      offsetX += cur.yogaNode.getComputedLeft() || 0;
      offsetY += cur.yogaNode.getComputedTop() || 0;
    }
    root = cur;
    cur = cur.parentNode;
  }

  const rootHeight = root.yogaNode?.getComputedHeight() || 0;
  return {
    offsetX: Number.isFinite(offsetX) ? Math.max(0, Math.round(offsetX)) : 0,
    offsetY: Number.isFinite(offsetY) ? Math.max(0, Math.round(offsetY)) : 0,
    rootHeight: Number.isFinite(rootHeight) ? Math.max(0, Math.round(rootHeight)) : 0,
  };
}

/**
 * Ink log-update 파킹 커서 위치에서 DECSC(\x1b7) → 상대 이동 → 그래픽 페이로드 → DECRC(\x1b8) 시퀀스를 조립한다.
 */
export function buildGraphicsOverlay(
  graphicsPayload: string,
  layout: PlaceholderLayout,
  stdoutRows?: number,
): string {
  const cursorRow =
    stdoutRows && stdoutRows > 0 && layout.rootHeight >= stdoutRows
      ? Math.max(0, layout.rootHeight - 1)
      : layout.rootHeight;
  const upRows = Math.max(0, cursorRow - layout.offsetY);
  const moveSeq = `\r${upRows > 0 ? `\x1b[${upRows}A` : ''}${layout.offsetX > 0 ? `\x1b[${layout.offsetX}C` : ''}`;
  return `\x1b7${moveSeq}${graphicsPayload}\x1b8`;
}

function isGraphicsEscapePayload(payload: string): boolean {
  return payload.startsWith('\x1b_G') || payload.startsWith('\x1b]1337;');
}

/**
 * Kitty / iTerm2 픽셀 프로토콜 활성 시 Ink 프레임 출력 직후 그래픽 페이로드를 원자적으로 재오버레이하고,
 * 모드 이탈 또는 언마운트 시 GPU 레이어와 stdout.write 래퍼를 안전하게 복구한다.
 */
export function useGraphicsOverlay(
  isPixelMode: boolean,
  effectiveMode: EffectiveRenderMode,
): GraphicsOverlayState {
  const { stdout } = useStdout();
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const placeholderRef = useRef<DOMElement | null>(null);
  const latestPayloadRef = useRef<string | null>(null);
  const overlayFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rawStdoutWriteRef = useRef<((chunk: any, encoding?: any, cb?: any) => boolean) | null>(null);

  const clearFlushTimer = useCallback(() => {
    if (overlayFlushTimerRef.current !== null) {
      clearTimeout(overlayFlushTimerRef.current);
      overlayFlushTimerRef.current = null;
    }
  }, []);

  const emitOverlay = useCallback(
    (
      stream: NodeJS.WriteStream,
      writeFn: (chunk: any, encoding?: any, cb?: any) => boolean,
      payload: string,
      thisArg: unknown = stream,
    ) => {
      const layout = computePlaceholderLayout(placeholderRef.current);
      const overlay = buildGraphicsOverlay(payload, layout, stream.rows);
      writeFn.call(thisArg, overlay);
    },
    [],
  );

  const scheduleOverlayFlush = useCallback(() => {
    clearFlushTimer();
    overlayFlushTimerRef.current = setTimeout(() => {
      overlayFlushTimerRef.current = null;
      const payload = latestPayloadRef.current;
      if (!payload || !stdout) return;
      emitOverlay(stdout, rawStdoutWriteRef.current ?? stdout.write, payload);
    }, 0);
  }, [clearFlushTimer, emitOverlay, stdout]);

  useEffect(() => {
    if (!isPixelMode || !stdout) {
      latestPayloadRef.current = null;
      return;
    }

    const hasOwnWrite = Object.prototype.hasOwnProperty.call(stdout, 'write');
    const origDescriptor = hasOwnWrite ? Object.getOwnPropertyDescriptor(stdout, 'write') : undefined;
    const origWrite = stdout.write;
    rawStdoutWriteRef.current = origWrite;
    let isInjectingOverlay = false;

    const wrappedWrite = function (this: any, chunk: any, encoding?: any, cb?: any): boolean {
      if (typeof encoding === 'function') {
        cb = encoding;
        encoding = undefined;
      }
      const res = origWrite.call(this, chunk, encoding, cb);
      if (!isInjectingOverlay && latestPayloadRef.current) {
        const str =
          typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
        if (str.includes('\n')) {
          clearFlushTimer();
          isInjectingOverlay = true;
          try {
            emitOverlay(stdout, origWrite, latestPayloadRef.current, this);
          } finally {
            isInjectingOverlay = false;
          }
        }
      }
      return res;
    };

    try {
      stdout.write = wrappedWrite as typeof stdout.write;
    } catch {
      // 비확장/읽기 전용 스트림 폴백
    }

    return () => {
      clearFlushTimer();
      rawStdoutWriteRef.current = null;
      latestPayloadRef.current = null;
      try {
        if (origDescriptor) {
          Object.defineProperty(stdout, 'write', origDescriptor);
        } else if (Object.prototype.hasOwnProperty.call(stdout, 'write')) {
          delete (stdout as any).write;
        }
      } catch {
        // 복원 불가 시 무시
      }
      if (effectiveMode === 'kitty') {
        stdout.write(KITTY_CLEAR_SEQ);
      }
    };
  }, [isPixelMode, effectiveMode, stdout, clearFlushTimer, emitOverlay]);

  const handleGraphicsFrame = useCallback(
    (output: string) => {
      if (isGraphicsEscapePayload(output)) {
        latestPayloadRef.current = output;
        setStatusMessage(null);
        scheduleOverlayFlush();
        return;
      }
      clearFlushTimer();
      const hadPayload = latestPayloadRef.current !== null;
      latestPayloadRef.current = null;
      if (hadPayload && effectiveMode === 'kitty' && stdout) {
        const writeFn = rawStdoutWriteRef.current ?? stdout.write;
        writeFn.call(stdout, KITTY_CLEAR_SEQ);
      }
      setStatusMessage(output);
    },
    [clearFlushTimer, effectiveMode, scheduleOverlayFlush, stdout],
  );

  const clearGraphicsState = useCallback(() => {
    latestPayloadRef.current = null;
    setStatusMessage(null);
  }, []);

  return { placeholderRef, statusMessage, handleGraphicsFrame, clearGraphicsState };
}
