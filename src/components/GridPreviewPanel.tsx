import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import path from 'node:path';
import type { FileItem } from '../hooks/useFileScanner.js';
import { loadVectorAsset } from '../loaders/assetLoader.js';
import { LottiePlayer } from '../LottiePlayer.js';
import {
  calcPixelSize,
  clampEvenPixelSize,
} from '../renderers/headlessPipeline.js';
import { WasmPixelExtractor } from '../renderers/pixelExtractor.js';
import { detectTerminalProtocol } from '../renderers/protocolDetector.js';
import { renderPixelsToSextant } from '../renderers/sextantRenderer.js';
import {
  postProcessAnsiFrame,
  type BackgroundPreset,
} from '../utils/ansiPostProcessor.js';
import {
  getModePixelAspect,
  preprocessVectorData,
  remapPureBlackForeground,
} from '../utils/vectorPreprocessor.js';
import { globalWasmMutex } from '../utils/wasmMutex.js';

export const GRID_MIN_COLS = 60;
export const GRID_MIN_ROWS = 20;
export const GRID_SMALL_TERMINAL_NOTICE =
  '창 크기가 작아 그리드 뷰를 표시할 수 없습니다';

export type GridUnicodeMode = 'half-block' | 'quadrant' | 'sextant' | 'braille';

export interface TileSnapshot {
  filePath: string;
  status: 'ready' | 'error';
  ansi: string;
  totalFrames: number;
  duration: number;
  errorMessage?: string;
}

export interface SnapshotGeneratorOptions {
  wasmModule: any;
  tileCols: number;
  tileRows: number;
  mode: GridUnicodeMode;
  invertDark: boolean;
  backgroundPreset: BackgroundPreset;
}

export interface GridPreviewPanelProps {
  files: FileItem[];
  focusedIndex: number;
  wasmModule: any;
  settingsMode: string;
  invertDark: boolean;
  backgroundPreset?: BackgroundPreset;
  previewWidth: number;
  previewHeight: number;
  isPaused: boolean;
  onFocusChange: (index: number, file: FileItem) => void;
  onEnterDetail: (file: FileItem) => void;
}

const MODE_INT: Record<GridUnicodeMode, number> = {
  'half-block': 0,
  quadrant: 1,
  sextant: 0,
  braille: 2,
};

export function isTerminalLargeEnoughForGrid(columns: number, rows: number): boolean {
  return columns >= GRID_MIN_COLS && rows >= GRID_MIN_ROWS;
}

export function resolveGridUnicodeMode(
  settingsMode: string,
  env: NodeJS.ProcessEnv = process.env,
): GridUnicodeMode {
  if (
    settingsMode === 'half-block' ||
    settingsMode === 'quadrant' ||
    settingsMode === 'sextant' ||
    settingsMode === 'braille'
  ) {
    return settingsMode;
  }
  if (settingsMode === 'kitty' || settingsMode === 'iterm2') {
    return 'sextant';
  }
  const proto = detectTerminalProtocol(env);
  return proto === 'kitty' || proto === 'iterm2' ? 'sextant' : 'quadrant';
}

export function computeGridTileDimensions(
  previewWidth: number,
  previewHeight: number,
): { tileCols: number; tileRows: number } {
  const tileCols = Math.max(14, Math.floor((previewWidth - 6) / 2));
  const tileRows = Math.max(5, Math.floor((previewHeight - 4) / 2) - 2);
  return { tileCols, tileRows };
}

function truncCellName(name: string, maxLen: number): string {
  if (maxLen <= 3) return name.slice(0, Math.max(0, maxLen));
  if (name.length <= maxLen) return name;
  return name.slice(0, maxLen - 2) + '..';
}

/**
 * 최대 4개 타일의 대표 프레임(35% 지점 또는 0프레임)을 단일 WASM 뮤텍스 큐에서 직렬 렌더링한다.
 * 개별 불량 파일은 Invalid Asset 상태로 격리하여 나머지 타일 표시를 보호한다.
 */
export async function generateGridSnapshots(
  files: FileItem[],
  options: SnapshotGeneratorOptions,
  signal?: AbortSignal,
): Promise<Map<string, TileSnapshot>> {
  const tileFiles = files.slice(0, 4);
  const snapshots = new Map<string, TileSnapshot>();
  const rawPixel = calcPixelSize(options.tileCols, options.tileRows, options.mode);
  const pixel = clampEvenPixelSize(rawPixel.w, rawPixel.h);
  const aspect = getModePixelAspect(options.mode);
  const extractor = new WasmPixelExtractor();

  for (const file of tileFiles) {
    if (signal?.aborted) break;

    await globalWasmMutex.runExclusive(async () => {
      if (signal?.aborted) return;

      try {
        const asset = await loadVectorAsset(file.value);
        if (signal?.aborted) return;

        const raw = remapPureBlackForeground(asset.content, asset.format);
        const processed = preprocessVectorData(raw, asset.format, aspect);

        await options.wasmModule.init();
        if (signal?.aborted) return;

        options.wasmModule.setSize(pixel.width, pixel.height);
        const loaded = Boolean(options.wasmModule.loadContent(processed));
        if (!loaded) {
          throw new Error('Invalid Asset');
        }

        const rawTotal = options.wasmModule.getTotalFrames();
        const rawDuration = options.wasmModule.getDuration();
        const isStatic =
          asset.format === 'svg' ||
          !Number.isFinite(rawTotal) ||
          !Number.isFinite(rawDuration) ||
          rawTotal <= 1 ||
          rawDuration <= 0;
        const totalFrames = isStatic ? 1 : Math.max(1, Math.floor(rawTotal));
        const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
        const repFrame = totalFrames > 1 ? Math.floor(totalFrames * 0.35) : 0;

        let ansi: string;
        if (options.mode === 'sextant') {
          const pf = extractor.renderAndExtract(
            options.wasmModule,
            repFrame,
            pixel.width,
            pixel.height,
            options.invertDark,
          );
          ansi = renderPixelsToSextant(pf, {
            background: options.backgroundPreset,
            optimizeRle: true,
          });
        } else {
          const rawAnsi = options.wasmModule.renderToString(
            repFrame,
            MODE_INT[options.mode],
            options.invertDark,
          );
          ansi = postProcessAnsiFrame(rawAnsi, {
            background: options.backgroundPreset,
            optimizeRle: true,
          });
        }

        snapshots.set(file.value, {
          filePath: file.value,
          status: 'ready',
          ansi,
          totalFrames,
          duration,
        });
      } catch {
        snapshots.set(file.value, {
          filePath: file.value,
          status: 'error',
          ansi: '',
          totalFrames: 0,
          duration: 0,
          errorMessage: 'Invalid Asset',
        });
      }
    });
  }

  return snapshots;
}

export const GridPreviewPanel: React.FC<GridPreviewPanelProps> = ({
  files,
  focusedIndex,
  wasmModule,
  settingsMode,
  invertDark,
  backgroundPreset = 'transparent',
  previewWidth,
  previewHeight,
  isPaused,
}) => {
  const tileFiles = useMemo(() => files.slice(0, 4), [files]);
  const filesKey = tileFiles.map((f) => f.value).join('\0');
  const tileMode = useMemo(() => resolveGridUnicodeMode(settingsMode), [settingsMode]);
  const { tileCols, tileRows } = useMemo(
    () => computeGridTileDimensions(previewWidth, previewHeight),
    [previewWidth, previewHeight],
  );

  const [snapshots, setSnapshots] = useState<Map<string, TileSnapshot>>(() => new Map());
  const [isGenerating, setIsGenerating] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setIsGenerating(true);

    if (tileFiles.length === 0) {
      setSnapshots(new Map());
      setIsGenerating(false);
      return () => controller.abort();
    }

    generateGridSnapshots(
      tileFiles,
      {
        wasmModule,
        tileCols,
        tileRows,
        mode: tileMode,
        invertDark,
        backgroundPreset,
      },
      controller.signal,
    )
      .then((nextMap) => {
        if (!controller.signal.aborted) {
          setSnapshots(nextMap);
          setIsGenerating(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setIsGenerating(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [filesKey, wasmModule, tileCols, tileRows, tileMode, invertDark, backgroundPreset]);

  const rows: FileItem[][] = [];
  for (let i = 0; i < tileFiles.length; i += 2) {
    rows.push(tileFiles.slice(i, i + 2));
  }

  return (
    <Box width="68%" flexDirection="column" marginLeft={1} borderStyle="single" paddingX={1}>
      <Box justifyContent="space-between" marginBottom={0}>
        <Text bold color="cyan">
          🧩 2×2 Grid Gallery ({tileMode})
        </Text>
        <Text color="gray">
          ←→↑↓:Focus | Enter:Detail | G/Esc:Exit
        </Text>
      </Box>

      {tileFiles.length === 0 ? (
        <Text color="gray">No playable assets on current page.</Text>
      ) : (
        <Box flexDirection="column">
          {rows.map((rowItems, rIdx) => (
            <Box key={rIdx} flexDirection="row">
              {rowItems.map((file, cIdx) => {
                const idx = rIdx * 2 + cIdx;
                const isFocused = idx === focusedIndex;
                const snap = snapshots.get(file.value);
                const baseName = truncCellName(path.basename(file.value), Math.max(8, tileCols - 10));

                return (
                  <Box
                    key={file.value}
                    borderStyle="single"
                    borderColor={isFocused ? 'cyan' : 'gray'}
                    width={tileCols + 4}
                    height={tileRows + 4}
                    flexDirection="column"
                    paddingX={1}
                    marginRight={cIdx === 0 ? 1 : 0}
                  >
                    <Text bold={isFocused} color={isFocused ? 'cyan' : 'white'} wrap="truncate-end">
                      {isFocused ? '▶ ' : '  '}
                      {baseName} <Text color="gray">({file.meta.size})</Text>
                    </Text>

                    {isGenerating && !snap ? (
                      <Text color="gray">Loading snapshot...</Text>
                    ) : snap?.status === 'error' ? (
                      <Text color="red">⚠ {snap.errorMessage ?? 'Invalid Asset'}</Text>
                    ) : !isGenerating &&
                      isFocused &&
                      snap?.status === 'ready' &&
                      snap.totalFrames > 1 ? (
                      <LottiePlayer
                        key={file.value}
                        wasmModule={wasmModule}
                        filePath={file.value}
                        width={tileCols}
                        height={tileRows}
                        renderMode={tileMode}
                        invertDark={invertDark}
                        backgroundPreset={backgroundPreset}
                        paused={isPaused}
                      />
                    ) : (
                      <Text wrap="truncate">{snap?.ansi ?? ''}</Text>
                    )}
                  </Box>
                );
              })}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};
