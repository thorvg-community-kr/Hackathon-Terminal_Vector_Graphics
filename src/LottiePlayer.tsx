import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Text, Box } from 'ink';
import { useAnimationLoop } from './hooks/useAnimationLoop.js';
import { useGraphicsOverlay } from './hooks/useGraphicsOverlay.js';
import type { BackgroundPreset } from './utils/ansiPostProcessor.js';
import {
  clampViewport,
  getModePixelAspect,
  type VectorTransformOptions,
} from './utils/vectorPreprocessor.js';
import { WasmPixelExtractor } from './renderers/pixelExtractor.js';
import {
  calcPixelSize,
  clampEvenPixelSize,
  RENDER_MODE_INT,
  renderVectorFrame,
  resolveEffectiveRenderMode,
  type RenderMode,
} from './renderers/headlessPipeline.js';
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
  onAssetDecoded?: (content: string, format: 'svg' | 'lottie') => void;
  loop?: boolean;
  onComplete?: () => void;
  paused?: boolean;
  seekDelta?: number;
  onSeekConsumed?: () => void;
  onFrameUpdate?: (frame: number, totalFrames: number, fps: number, isStatic?: boolean) => void;
}

const LottiePlayerInner: React.FC<LottiePlayerProps> = ({
  wasmModule, filePath, width = 80, height = 40, renderMode = 'quadrant',
  invertDark = false, backgroundPreset = 'transparent', optimizeRle = true,
  zoom = 1.0, panX = 0, panY = 0, speed = 1.0, reverse = false,
  seekTargetFrame = null, onSeekTargetConsumed, segmentRange = null,
  reloadVersion = 0, rawContentOverride, loadedAsset, onLoad, onAssetDecoded,
  loop = true, onComplete, paused = false, seekDelta = 0, onSeekConsumed, onFrameUpdate,
}) => {
  const defaultStatic = loadedAsset
    ? loadedAsset.format === 'svg'
    : filePath.toLowerCase().endsWith('.svg');
  const [ansiFrame, setAnsiFrame] = useState<string>('Loading...');
  const [staticInfo, setStaticInfo] = useState<{ filePath: string; isStatic: boolean }>(() => ({
    filePath,
    isStatic: defaultStatic,
  }));
  const isStaticAsset = staticInfo.filePath === filePath ? staticInfo.isStatic : defaultStatic;

  const pixelExtractorRef = useRef<WasmPixelExtractor | null>(null);
  if (!pixelExtractorRef.current) pixelExtractorRef.current = new WasmPixelExtractor();
  const bgScratchRef = useRef<Uint8Array>(new Uint8Array(0));

  const effectiveMode = useMemo(() => resolveEffectiveRenderMode(renderMode), [renderMode]);
  const isPixelMode = effectiveMode === 'kitty' || effectiveMode === 'iterm2';
  const { placeholderRef, statusMessage, handleGraphicsFrame, clearGraphicsState } =
    useGraphicsOverlay(isPixelMode, effectiveMode);

  const pixel = useMemo(() => {
    const raw = calcPixelSize(width, height, effectiveMode, { paused, isStatic: isStaticAsset });
    return clampEvenPixelSize(raw.w, raw.h);
  }, [width, height, effectiveMode, paused, isStaticAsset]);

  const modeInt = RENDER_MODE_INT[effectiveMode];
  const clampedViewport = useMemo(() => clampViewport(zoom, panX, panY), [zoom, panX, panY]);
  const transformOptions = useMemo<VectorTransformOptions>(() => {
    const aspect = getModePixelAspect(effectiveMode);
    return { ...aspect, zoom: clampedViewport.zoom, panX: clampedViewport.panX, panY: clampedViewport.panY };
  }, [effectiveMode, clampedViewport.zoom, clampedViewport.panX, clampedViewport.panY]);

  const renderFrame = useCallback(
    (frameIdx: number) =>
      renderVectorFrame(wasmModule, frameIdx, {
        mode: effectiveMode,
        cols: width,
        rows: height,
        pixelWidth: pixel.width,
        pixelHeight: pixel.height,
        invertDark,
        background: backgroundPreset,
        optimizeRle,
        extractor: pixelExtractorRef.current!,
        bgScratch: bgScratchRef,
      }),
    [wasmModule, effectiveMode, width, height, pixel.width, pixel.height, invertDark, backgroundPreset, optimizeRle],
  );

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
        handleGraphicsFrame(output);
        return;
      }
      clearGraphicsState();
      setAnsiFrame(output);
    },
    [isPixelMode, handleGraphicsFrame, clearGraphicsState],
  );

  const controls = useAnimationLoop({
    wasmModule, filePath, pixelWidth: pixel.width, pixelHeight: pixel.height,
    modeInt, invertDark, transformOptions, renderFrame,
    renderOptionKey: `${effectiveMode}:${backgroundPreset}:${optimizeRle}`,
    speed, reverse, segmentRange, reloadVersion, rawContentOverride, loadedAsset,
    loop, paused, onLoad: handleLoopLoad, onAssetDecoded, onComplete, onFrame,
    onMetaUpdate: onFrameUpdate,
  });

  useEffect(() => {
    if (seekDelta !== 0) {
      controls.seek(seekDelta);
      onSeekConsumed?.();
    }
  }, [seekDelta, controls, onSeekConsumed]);

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
