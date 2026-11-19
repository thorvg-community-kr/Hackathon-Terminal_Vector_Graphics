import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Text, Box } from 'ink';
import { clampEvenPixelSize, useAnimationLoop } from './hooks/useAnimationLoop.js';
import {
  postProcessAnsiFrame,
  type BackgroundPreset,
} from './utils/ansiPostProcessor.js';
import { getModePixelAspect } from './utils/vectorPreprocessor.js';
import { normalizeEvenHeight, WasmPixelExtractor } from './renderers/pixelExtractor.js';
import { renderPixelsToSextant } from './renderers/sextantRenderer.js';

export type RenderMode = 'half-block' | 'quadrant' | 'sextant' | 'braille';

export interface LottiePlayerProps {
  wasmModule: any;
  filePath: string;
  width?: number;
  height?: number;
  renderMode?: RenderMode;
  invertDark?: boolean;
  backgroundPreset?: BackgroundPreset;
  optimizeRle?: boolean;
  onLoad?: (duration: number, totalFrames: number, isStatic?: boolean) => void;
  loop?: boolean;
  onComplete?: () => void;
  paused?: boolean;
  seekDelta?: number;
  onSeekConsumed?: () => void;
  onFrameUpdate?: (frame: number, totalFrames: number, fps: number, isStatic?: boolean) => void;
}

/** 렌더 모드 → C++ enum 매핑 (sextant는 Mode 0 무손실 RGB 브릿지 사용) */
const RENDER_MODE_INT: Record<RenderMode, number> = {
  'half-block': 0,
  'quadrant': 1,
  'sextant': 0,
  'braille': 2,
};

/** 렌더 모드 → 픽셀 해상도 계산 */
function calcPixelSize(width: number, height: number, mode: RenderMode) {
  switch (mode) {
    case 'braille':  return { w: width * 2, h: height * 4 };
    case 'sextant':  return { w: width * 2, h: normalizeEvenHeight(height * 3) };
    case 'quadrant': return { w: width * 2, h: height * 2 };
    default:         return { w: width,     h: height * 2 };
  }
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
  onLoad,
  loop = true,
  onComplete,
  paused = false,
  seekDelta = 0,
  onSeekConsumed,
  onFrameUpdate,
}) => {
  const [ansiFrame, setAnsiFrame] = useState<string>('Loading...');
  const pixelExtractorRef = useRef<WasmPixelExtractor | null>(null);
  if (!pixelExtractorRef.current) {
    pixelExtractorRef.current = new WasmPixelExtractor();
  }

  const pixel = useMemo(() => {
    const raw = calcPixelSize(width, height, renderMode);
    return clampEvenPixelSize(raw.w, raw.h);
  }, [width, height, renderMode]);

  const modeInt = RENDER_MODE_INT[renderMode];
  const transformOptions = useMemo(() => getModePixelAspect(renderMode), [renderMode]);
  const renderOptionKey = `${renderMode}:${backgroundPreset}:${optimizeRle}`;

  // 후처리/Sextant 변환을 renderFrame 내부로 통합하여 useAnimationLoop의 prevFrameRef가
  // 최종 ANSI 문자열 기준으로 중복 프레임을 정확히 판별하도록 한다.
  const renderFrame = useCallback((frameIdx: number) => {
    if (renderMode === 'sextant') {
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
  }, [wasmModule, renderMode, modeInt, invertDark, pixel.width, pixel.height, backgroundPreset, optimizeRle]);

  const onFrame = useCallback((ansi: string) => {
    setAnsiFrame(ansi);
  }, []);

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
    loop,
    paused,
    onLoad,
    onComplete,
    onFrame,
    onMetaUpdate,
  });

  // 일시정지/재생 반응
  useEffect(() => {
    paused ? controls.pause() : controls.resume();
  }, [paused, controls]);

  // 시크 반응
  useEffect(() => {
    if (seekDelta !== 0) {
      controls.seek(seekDelta);
      onSeekConsumed?.();
    }
  }, [seekDelta, controls, onSeekConsumed]);

  return (
    <Box flexDirection="column">
      <Text wrap="truncate">{ansiFrame}</Text>
    </Box>
  );
};

export const LottiePlayer = React.memo(LottiePlayerInner);
