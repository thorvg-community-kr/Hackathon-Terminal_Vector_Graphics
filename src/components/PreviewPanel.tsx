import React from 'react';
import { Box, Text } from 'ink';
import { LottiePlayer, type RenderMode } from '../LottiePlayer.js';
import type { FileItem } from '../hooks/useFileScanner.js';
import type { BackgroundPreset } from '../utils/ansiPostProcessor.js';
import type { LottieMarker } from '../utils/lottieMarkers.js';
import type { HotReloadStatus } from '../hooks/useFileWatcher.js';

export interface FrameProgress {
  current: number;
  total: number;
  fps: number;
  isStatic?: boolean;
}

export interface PreviewPanelProps {
  selectedFile: FileItem | null;
  wasmModule: any;
  settingsMode: RenderMode;
  invertDark: boolean;
  backgroundPreset?: BackgroundPreset;
  previewWidth: number;
  previewHeight: number;
  zoom?: number;
  panX?: number;
  panY?: number;
  speed?: number;
  reverse?: boolean;
  activeMarker?: LottieMarker | null;
  isSegmentLoop?: boolean;
  segmentRange?: [number, number] | null;
  seekTargetFrame?: number | null;
  onSeekTargetConsumed?: () => void;
  reloadVersion?: number;
  rawContentOverride?: string;
  hotReloadStatus?: HotReloadStatus;
  hotReloadError?: string | null;
  isPaused: boolean;
  seekDelta: number;
  frameProgress: FrameProgress;
  onDurationLoad: (duration: number, totalFrames: number, isStatic?: boolean) => void;
  onSeekConsumed: () => void;
  onFrameUpdate: (frame: number, totalFrames: number, fps: number, isStatic?: boolean) => void;
}

/** FPS 값에 따른 색상 인디케이터 */
const fpsColor = (fps: number): string => {
  if (fps >= 25) return 'green';
  if (fps >= 15) return 'yellow';
  return 'red';
};

const isPlayableFile = (file: FileItem | null): boolean => {
  if (!file) return false;
  return file.value !== '' && !file.value.startsWith('__folder__');
};

export const PreviewPanel: React.FC<PreviewPanelProps> = ({
  selectedFile, wasmModule, settingsMode, invertDark, backgroundPreset = 'transparent',
  previewWidth, previewHeight, zoom = 1.0, panX = 0, panY = 0,
  speed = 1.0, reverse = false, activeMarker = null, isSegmentLoop = false,
  segmentRange = null, seekTargetFrame = null, onSeekTargetConsumed,
  reloadVersion = 0, rawContentOverride, hotReloadStatus = 'idle', hotReloadError = null,
  isPaused, seekDelta, frameProgress,
  onDurationLoad, onSeekConsumed, onFrameUpdate,
}) => {
  const hasExtraBadges = Boolean(
    activeMarker || zoom > 1.0 || speed !== 1.0 || reverse || hotReloadStatus !== 'idle',
  );
  const showInlineHints = !hasExtraBadges || previewWidth >= 110;

  return (
    <Box width="68%" flexDirection="column" marginLeft={1} borderStyle="single" paddingX={1}>
      {/* 헤더: 재생 상태 + 배속/마커/줌/HotReload 배지 + FPS + 단축키 힌트 */}
      <Box justifyContent="space-between">
        <Text bold color="yellow" wrap="truncate-end">
          Live Preview {frameProgress.isStatic
            ? <Text color="cyan"> 🖼 STATIC</Text>
            : isPaused
              ? <Text color="red"> ⏸ PAUSED{reverse ? ' ◀' : ''}</Text>
              : reverse
                ? <Text color="magenta"> ◀ REV</Text>
                : <Text color="green"> ▶</Text>}
          {!frameProgress.isStatic && speed !== 1.0 ? (
            <Text color="cyan"> {speed}x</Text>
          ) : null}
          {activeMarker ? (
            <Text color="blue"> {isSegmentLoop ? '🔁' : ''}[Marker: {activeMarker.name}]</Text>
          ) : null}
          {zoom > 1.0 ? (
            <Text color="magenta"> 🔍 {zoom.toFixed(1)}x (HJKL:Pan 0:Reset)</Text>
          ) : null}
          {hotReloadStatus === 'reloaded' ? (
            <Text color="green"> ♻ Reloaded</Text>
          ) : hotReloadStatus === 'error' ? (
            <Text color="yellow"> {hotReloadError ?? '⚠ Reload failed: invalid syntax'}</Text>
          ) : null}
        </Text>
        <Text color="gray" wrap="truncate-end">
          {frameProgress.isStatic ? (
            <>1/1 <Text color="cyan">STATIC</Text></>
          ) : (
            <>
              {frameProgress.current}/{frameProgress.total}{' '}
              <Text color={fpsColor(frameProgress.fps)}>{frameProgress.fps}fps</Text>
              {showInlineHints ? (
                <>
                  {' '}
                  <Text color="cyan">Space:⏯ </Text>
                  {isPaused ? <Text color="yellow">←→:Seek</Text> : null}
                </>
              ) : null}
            </>
          )}
        </Text>
      </Box>

      {/* 프리뷰 영역 */}
      {isPlayableFile(selectedFile) ? (
        <LottiePlayer
          key={selectedFile!.value}
          wasmModule={wasmModule}
          filePath={selectedFile!.value}
          width={previewWidth}
          height={previewHeight}
          renderMode={settingsMode}
          invertDark={invertDark}
          backgroundPreset={backgroundPreset}
          zoom={zoom}
          panX={panX}
          panY={panY}
          speed={speed}
          reverse={reverse}
          segmentRange={segmentRange}
          seekTargetFrame={seekTargetFrame}
          onSeekTargetConsumed={onSeekTargetConsumed}
          reloadVersion={reloadVersion}
          rawContentOverride={rawContentOverride}
          onLoad={onDurationLoad}
          paused={isPaused}
          seekDelta={seekDelta}
          onSeekConsumed={onSeekConsumed}
          onFrameUpdate={onFrameUpdate}
        />
      ) : (
        <Text color="gray">No file selected to preview.</Text>
      )}
    </Box>
  );
};
