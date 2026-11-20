import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Text, Box, useStdout, type DOMElement } from 'ink';
import { useAnimationLoop } from './hooks/useAnimationLoop.js';
import {
  postProcessAnsiFrame,
  type BackgroundPreset,
} from './utils/ansiPostProcessor.js';
import {
  clampViewport,
  getModePixelAspect,
  type VectorTransformOptions,
} from './utils/vectorPreprocessor.js';
import {
  applyBackgroundPresetToPixels,
  WasmPixelExtractor,
  type PixelFrame,
} from './renderers/pixelExtractor.js';
import {
  calcPixelSize,
  clampEvenPixelSize,
  RENDER_MODE_INT,
  resolveEffectiveRenderMode,
  type EffectiveRenderMode,
  type RenderMode,
} from './renderers/headlessPipeline.js';
import { renderPixelsToSextant } from './renderers/sextantRenderer.js';
import {
  encodeKittyGraphics,
  KITTY_CLEAR_SEQ,
} from './renderers/kittyRenderer.js';
import { encodeIterm2Graphics } from './renderers/iterm2Renderer.js';
import type { LoadedVectorAsset } from './loaders/assetLoader.js';

export interface LottiePlayerProps {
  wasmModule: any;
  filePath: string;
  width?: number;
  height?: number;
  renderMode?: RenderMode;
  invertDark?: boolean;
  backgroundPreset?: BackgroundPreset;
  optimizeRle?: boolean;
  zoom?: number;
  panX?: number;
  panY?: number;
  speed?: number;
  reverse?: boolean;
  seekTargetFrame?: number | null;
  onSeekTargetConsumed?: () => void;
  segmentRange?: [number, number] | null;
  reloadVersion?: number;
  rawContentOverride?: string;
  loadedAsset?: LoadedVectorAsset;
  onLoad?: (duration: number, totalFrames: number, isStatic?: boolean) => void;
  loop?: boolean;
  onComplete?: () => void;
  paused?: boolean;
  seekDelta?: number;
  onSeekConsumed?: () => void;
  onFrameUpdate?: (frame: number, totalFrames: number, fps: number, isStatic?: boolean) => void;
}

export interface PlaceholderLayout {
  offsetX: number;
  offsetY: number;
  rootHeight: number;
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

const LottiePlayerInner: React.FC<LottiePlayerProps> = ({
  wasmModule,
  filePath,
  width = 80,
  height = 40,
  renderMode = 'quadrant',
  invertDark = false,
  backgroundPreset = 'transparent',
  optimizeRle = true,
  zoom = 1.0,
  panX = 0,
  panY = 0,
  speed = 1.0,
  reverse = false,
  seekTargetFrame = null,
  onSeekTargetConsumed,
  segmentRange = null,
  reloadVersion = 0,
  rawContentOverride,
  loadedAsset,
  onLoad,
  loop = true,
  onComplete,
  paused = false,
  seekDelta = 0,
  onSeekConsumed,
  onFrameUpdate,
}) => {
  const { stdout } = useStdout();
  const [ansiFrame, setAnsiFrame] = useState<string>('Loading...');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [staticInfo, setStaticInfo] = useState<{ filePath: string; isStatic: boolean }>(() => ({
    filePath,
    isStatic: loadedAsset ? loadedAsset.format === 'svg' : filePath.toLowerCase().endsWith('.svg'),
  }));
  const isStaticAsset =
    staticInfo.filePath === filePath
      ? staticInfo.isStatic
      : loadedAsset
        ? loadedAsset.format === 'svg'
        : filePath.toLowerCase().endsWith('.svg');

  const pixelExtractorRef = useRef<WasmPixelExtractor | null>(null);
  if (!pixelExtractorRef.current) {
    pixelExtractorRef.current = new WasmPixelExtractor();
  }
  const bgScratchRef = useRef<Uint8Array>(new Uint8Array(0));
  const placeholderRef = useRef<DOMElement | null>(null);
  const latestPayloadRef = useRef<string | null>(null);
  const overlayFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rawStdoutWriteRef = useRef<((chunk: any, encoding?: any, cb?: any) => boolean) | null>(null);

  const effectiveMode = useMemo(() => resolveEffectiveRenderMode(renderMode), [renderMode]);
  const isPixelMode = effectiveMode === 'kitty' || effectiveMode === 'iterm2';

  const pixel = useMemo(() => {
    const raw = calcPixelSize(width, height, effectiveMode, {
      paused,
      isStatic: isStaticAsset,
    });
    return clampEvenPixelSize(raw.w, raw.h);
  }, [width, height, effectiveMode, paused, isStaticAsset]);

  const modeInt = RENDER_MODE_INT[effectiveMode];
  const clampedViewport = useMemo(
    () => clampViewport(zoom, panX, panY),
    [zoom, panX, panY],
  );
  const transformOptions = useMemo<VectorTransformOptions>(() => {
    const aspect = getModePixelAspect(effectiveMode);
    return {
      pixelAspectX: aspect.pixelAspectX,
      pixelAspectY: aspect.pixelAspectY,
      zoom: clampedViewport.zoom,
      panX: clampedViewport.panX,
      panY: clampedViewport.panY,
    };
  }, [effectiveMode, clampedViewport.zoom, clampedViewport.panX, clampedViewport.panY]);
  const renderOptionKey = `${effectiveMode}:${backgroundPreset}:${optimizeRle}`;

  const flushOverlayNow = useCallback(() => {
    if (overlayFlushTimerRef.current !== null) {
      clearTimeout(overlayFlushTimerRef.current);
      overlayFlushTimerRef.current = null;
    }
    const payload = latestPayloadRef.current;
    if (!payload || !stdout) return;
    const layout = computePlaceholderLayout(placeholderRef.current);
    const overlay = buildGraphicsOverlay(payload, layout, stdout.rows);
    const writeFn = rawStdoutWriteRef.current ?? stdout.write;
    writeFn.call(stdout, overlay);
  }, [stdout]);

  const scheduleOverlayFlush = useCallback(() => {
    if (overlayFlushTimerRef.current !== null) {
      clearTimeout(overlayFlushTimerRef.current);
    }
    overlayFlushTimerRef.current = setTimeout(() => {
      overlayFlushTimerRef.current = null;
      flushOverlayNow();
    }, 0);
  }, [flushOverlayNow]);

  // 픽셀 프로토콜 활성 시 Ink 프레임 출력 직후 그래픽 페이로드를 원자적으로 재오버레이하고,
  // Kitty 모드 이탈 또는 언마운트 시 GPU 레이어를 즉시 정리한다.
  useEffect(() => {
    if (!isPixelMode || !stdout) {
      latestPayloadRef.current = null;
      return;
    }

    const hasOwnWrite = Object.prototype.hasOwnProperty.call(stdout, 'write');
    const origDescriptor = hasOwnWrite
      ? Object.getOwnPropertyDescriptor(stdout, 'write')
      : undefined;
    const origWrite = stdout.write;
    rawStdoutWriteRef.current = origWrite;
    let isInjectingOverlay = false;

    const wrappedWrite = function (
      this: any,
      chunk: any,
      encoding?: any,
      cb?: any,
    ): boolean {
      if (typeof encoding === 'function') {
        cb = encoding;
        encoding = undefined;
      }
      const res = origWrite.call(this, chunk, encoding, cb);
      if (!isInjectingOverlay && latestPayloadRef.current) {
        const str =
          typeof chunk === 'string'
            ? chunk
            : Buffer.isBuffer(chunk)
              ? chunk.toString('utf8')
              : '';
        if (str.includes('\n')) {
          if (overlayFlushTimerRef.current !== null) {
            clearTimeout(overlayFlushTimerRef.current);
            overlayFlushTimerRef.current = null;
          }
          isInjectingOverlay = true;
          try {
            const layout = computePlaceholderLayout(placeholderRef.current);
            const overlay = buildGraphicsOverlay(
              latestPayloadRef.current,
              layout,
              stdout.rows,
            );
            origWrite.call(this, overlay);
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
      if (overlayFlushTimerRef.current !== null) {
        clearTimeout(overlayFlushTimerRef.current);
        overlayFlushTimerRef.current = null;
      }
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
  }, [isPixelMode, effectiveMode, stdout]);

  // 후처리/Sextant/네이티브 프로토콜 변환을 renderFrame 내부로 통합하여
  // useAnimationLoop의 prevFrameRef가 최종 출력 문자열 기준으로 중복 프레임을 판별하도록 한다.
  const renderFrame = useCallback((frameIdx: number) => {
    if (effectiveMode === 'kitty' || effectiveMode === 'iterm2') {
      const rawMode0 = wasmModule.renderToString(frameIdx, 0, invertDark);
      const extracted = pixelExtractorRef.current!.extractFromHalfBlockAnsi(
        rawMode0,
        pixel.width,
        pixel.height,
      );
      const composited = applyBackgroundPresetToPixels(
        extracted,
        backgroundPreset,
        bgScratchRef,
      );
      if (effectiveMode === 'kitty') {
        return encodeKittyGraphics(composited, { cols: width, rows: height });
      }
      return encodeIterm2Graphics(composited, { cols: width, rows: height });
    }

    if (effectiveMode === 'sextant') {
      const rawMode0 = wasmModule.renderToString(frameIdx, 0, invertDark);
      const pixelFrame = pixelExtractorRef.current!.extractFromHalfBlockAnsi(
        rawMode0,
        pixel.width,
        pixel.height,
      );
      return renderPixelsToSextant(pixelFrame, {
        background: backgroundPreset,
        optimizeRle,
      });
    }

    const rawAnsi = wasmModule.renderToString(frameIdx, modeInt, invertDark);
    return postProcessAnsiFrame(rawAnsi, {
      background: backgroundPreset,
      optimizeRle,
    });
  }, [wasmModule, effectiveMode, modeInt, invertDark, pixel.width, pixel.height, width, height, backgroundPreset, optimizeRle]);

  const handleLoopLoad = useCallback(
    (duration: number, totalFrames: number, isStatic?: boolean) => {
      setStaticInfo({ filePath, isStatic: Boolean(isStatic) });
      onLoad?.(duration, totalFrames, isStatic);
    },
    [filePath, onLoad],
  );

  const onFrame = useCallback(
    (output: string) => {
      if (isPixelMode) {
        if (isGraphicsEscapePayload(output)) {
          latestPayloadRef.current = output;
          setStatusMessage(null);
          scheduleOverlayFlush();
        } else {
          if (overlayFlushTimerRef.current !== null) {
            clearTimeout(overlayFlushTimerRef.current);
            overlayFlushTimerRef.current = null;
          }
          const hadPayload = latestPayloadRef.current !== null;
          latestPayloadRef.current = null;
          if (hadPayload && effectiveMode === 'kitty' && stdout) {
            const writeFn = rawStdoutWriteRef.current ?? stdout.write;
            writeFn.call(stdout, KITTY_CLEAR_SEQ);
          }
          setStatusMessage(output);
        }
        return;
      }

      latestPayloadRef.current = null;
      setStatusMessage(null);
      setAnsiFrame(output);
    },
    [isPixelMode, effectiveMode, stdout, scheduleOverlayFlush],
  );

  const onMetaUpdate = useCallback((frame: number, total: number, fps: number, isStatic: boolean) => {
    onFrameUpdate?.(frame, total, fps, isStatic);
  }, [onFrameUpdate]);

  const controls = useAnimationLoop({
    wasmModule,
    filePath,
    pixelWidth: pixel.width,
    pixelHeight: pixel.height,
    modeInt,
    invertDark,
    transformOptions,
    renderFrame,
    renderOptionKey,
    speed,
    reverse,
    segmentRange,
    reloadVersion,
    rawContentOverride,
    loadedAsset,
    loop,
    paused,
    onLoad: handleLoopLoad,
    onComplete,
    onFrame,
    onMetaUpdate,
  });

  // 일시정지/재생 반응
  useEffect(() => {
    paused ? controls.pause() : controls.resume();
  }, [paused, controls]);

  // 상대 시크 반응
  useEffect(() => {
    if (seekDelta !== 0) {
      controls.seek(seekDelta);
      onSeekConsumed?.();
    }
  }, [seekDelta, controls, onSeekConsumed]);

  // 절대 프레임(마커 점프) 시크 반응
  useEffect(() => {
    if (seekTargetFrame !== null && seekTargetFrame !== undefined) {
      controls.seekToFrame(seekTargetFrame);
      onSeekTargetConsumed?.();
    }
  }, [seekTargetFrame, controls, onSeekTargetConsumed]);

  if (isPixelMode) {
    return (
      <Box ref={placeholderRef} width={width} height={height} flexDirection="column">
        {statusMessage ? <Text>{statusMessage}</Text> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text wrap="truncate">{ansiFrame}</Text>
    </Box>
  );
};

export const LottiePlayer = React.memo(LottiePlayerInner);
