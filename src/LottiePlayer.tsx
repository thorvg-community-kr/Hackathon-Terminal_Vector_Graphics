import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Text, Box } from 'ink';
import { useAnimationLoop } from './hooks/useAnimationLoop.js';
import {
  postProcessAnsiFrame,
  type BackgroundPreset,
} from './utils/ansiPostProcessor.js';

export type RenderMode = 'half-block' | 'quadrant' | 'braille';

export interface LottiePlayerProps {
  wasmModule: any;
  filePath: string;
  width?: number;
  height?: number;
  renderMode?: RenderMode;
  invertDark?: boolean;
  backgroundPreset?: BackgroundPreset;
  optimizeRle?: boolean;
  onLoad?: (duration: number, totalFrames: number) => void;
  loop?: boolean;
  onComplete?: () => void;
  paused?: boolean;
  seekDelta?: number;
  onSeekConsumed?: () => void;
  onFrameUpdate?: (frame: number, totalFrames: number, fps: number) => void;
}

/** 렌더 모드 → C++ enum 매핑 */
const RENDER_MODE_INT: Record<RenderMode, number> = {
  'half-block': 0,
  'quadrant': 1,
  'braille': 2,
};

/** 렌더 모드 → 픽셀 해상도 계산 */
function calcPixelSize(width: number, height: number, mode: RenderMode) {
  switch (mode) {
    case 'braille':   return { w: width * 2, h: height * 4 };
    case 'quadrant':  return { w: width * 2, h: height * 2 };
    default:          return { w: width,     h: height * 2 };
  }
}

export const LottiePlayer: React.FC<LottiePlayerProps> = ({
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
  const rawAnsiRef = useRef<string>('');

  const pixel = useMemo(() => calcPixelSize(width, height, renderMode), [width, height, renderMode]);
  const modeInt = RENDER_MODE_INT[renderMode];

  const onFrame = useCallback((ansi: string, frame: number, total: number, fps: number) => {
    rawAnsiRef.current = ansi;
    setAnsiFrame(
      postProcessAnsiFrame(ansi, {
        background: backgroundPreset,
        optimizeRle,
      })
    );
    onFrameUpdate?.(frame, total, fps);
  }, [onFrameUpdate, backgroundPreset, optimizeRle]);

  // 일시정지 상태에서도 배경 프리셋 또는 RLE 옵션 변경 시 즉시 재후처리
  useEffect(() => {
    if (rawAnsiRef.current) {
      setAnsiFrame(
        postProcessAnsiFrame(rawAnsiRef.current, {
          background: backgroundPreset,
          optimizeRle,
        })
      );
    }
  }, [backgroundPreset, optimizeRle]);

  const controls = useAnimationLoop({
    wasmModule,
    filePath,
    pixelWidth: pixel.w,
    pixelHeight: pixel.h,
    modeInt,
    invertDark,
    loop,
    paused,
    onLoad,
    onComplete,
    onFrame,
  });

  // 일시정지/재생 반응
  useEffect(() => {
    paused ? controls.pause() : controls.resume();
  }, [paused]);

  // 시크 반응
  useEffect(() => {
    if (seekDelta !== 0) {
      controls.seek(seekDelta);
      onSeekConsumed?.();
    }
  }, [seekDelta]);

  return (
    <Box flexDirection="column">
      <Text wrap="truncate">{ansiFrame}</Text>
    </Box>
  );
};
