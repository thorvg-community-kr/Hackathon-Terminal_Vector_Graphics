import React from 'react';
import { Box, Text } from 'ink';
import { LottiePlayer } from '../LottiePlayer.js';
import type { FileItem } from '../hooks/useFileScanner.js';

export interface FrameProgress {
  current: number;
  total: number;
  fps: number;
  isStatic?: boolean;
}

export interface PreviewPanelProps {
  selectedFile: FileItem | null;
  wasmModule: any;
  settingsMode: 'half-block' | 'quadrant' | 'braille';
  invertDark: boolean;
  previewWidth: number;
  previewHeight: number;
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
  selectedFile, wasmModule, settingsMode, invertDark,
  previewWidth, previewHeight,
  isPaused, seekDelta, frameProgress,
  onDurationLoad, onSeekConsumed, onFrameUpdate,
}) => {
  return (
    <Box width="68%" flexDirection="column" marginLeft={1} borderStyle="single" paddingX={1}>
      {/* 헤더: 재생 상태 + FPS + 단축키 힌트 */}
      <Box justifyContent="space-between">
        <Text bold color="yellow">
          Live Preview {frameProgress.isStatic
            ? <Text color="cyan"> 🖼 STATIC</Text>
            : isPaused
              ? <Text color="red"> ⏸ PAUSED</Text>
              : <Text color="green"> ▶</Text>}
        </Text>
        <Text color="gray">
          {frameProgress.isStatic ? (
            <>1/1 <Text color="cyan">STATIC</Text></>
          ) : (
            <>
              {frameProgress.current}/{frameProgress.total}{' '}
              <Text color={fpsColor(frameProgress.fps)}>{frameProgress.fps}fps</Text>{' '}
              <Text color="cyan">Space:⏯ </Text>
              {isPaused ? <Text color="yellow">←→:Seek</Text> : null}
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
