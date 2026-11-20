import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import path from 'path';
import { realWasmModule } from './realWasmModule.js';
import { isPlayableFile, useFileScanner, type FileItem } from './hooks/useFileScanner.js';
import { useMcpSearch } from './hooks/useMcpSearch.js';
import { useTerminalSize } from './hooks/useTerminalEffects.js';
import { useFileWatcher } from './hooks/useFileWatcher.js';
import { AuthOverlay } from './components/AuthOverlay.js';
import { LeftPanel } from './components/LeftPanel.js';
import { PreviewPanel } from './components/PreviewPanel.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import {
  GRID_SMALL_TERMINAL_NOTICE,
  GridPreviewPanel,
  isTerminalLargeEnoughForGrid,
} from './components/GridPreviewPanel.js';
import { resolveEffectiveRenderMode, type RenderMode } from './renderers/headlessPipeline.js';
import { detectTerminalProtocol, type TerminalProtocol } from './renderers/protocolDetector.js';
import { KITTY_CLEAR_SEQ } from './renderers/kittyRenderer.js';
import type { BackgroundPreset } from './utils/ansiPostProcessor.js';
import { clampViewport, panViewport, stepZoom, type ViewportState } from './utils/vectorPreprocessor.js';
import {
  findActiveMarker,
  getNextMarker,
  parseLottieMarkers,
  stepPlaybackSpeed,
  type LottieMarker,
  type PlaybackSpeed,
} from './utils/lottieMarkers.js';

export interface InteractiveMenuProps {
  wasmModule?: any;
  initialPath?: string;
  initialFile?: string;
  initialDepth?: number;
  initialError?: string | null;
}

const BACKGROUND_ORDER: readonly BackgroundPreset[] = ['transparent', 'dark', 'light', 'checkerboard'];
const PAN_DELTAS: Record<string, readonly [-1 | 0 | 1, -1 | 0 | 1]> = {
  h: [-1, 0],
  j: [0, 1],
  k: [0, -1],
  l: [1, 0],
};

const cycleNext = <T,>(items: readonly T[], current: T): T =>
  items[(items.indexOf(current) + 1) % items.length] ?? items[0];

export function getRenderModeOrder(protocol: TerminalProtocol): readonly RenderMode[] {
  switch (protocol) {
    case 'kitty':
      return ['kitty', 'sextant', 'quadrant', 'braille', 'half-block'];
    case 'iterm2':
      return ['iterm2', 'sextant', 'quadrant', 'braille', 'half-block'];
    case 'unicode':
    default:
      return ['quadrant', 'sextant', 'braille', 'half-block'];
  }
}

export const InteractiveMenu: React.FC<InteractiveMenuProps> = ({
  wasmModule = realWasmModule,
  initialPath = process.cwd(),
  initialFile,
  initialDepth = 1,
  initialError = null,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const detectedProtocol = useMemo(() => detectTerminalProtocol(), []);
  const renderModeOrder = useMemo(() => getRenderModeOrder(detectedProtocol), [detectedProtocol]);
  const termSize = useTerminalSize(100, 40);
  const isMountedRef = useRef(true);
  useEffect(() => () => {
    isMountedRef.current = false;
  }, []);

  const scanner = useFileScanner(initialPath, initialDepth, initialError);

  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [settingsMode, setSettingsMode] = useState<RenderMode>(() => renderModeOrder[0]);
  const [invertDark, setInvertDark] = useState(false);
  const [backgroundPreset, setBackgroundPreset] = useState<BackgroundPreset>('transparent');
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isGridMode, setIsGridMode] = useState(false);
  const [gridFocusIdx, setGridFocusIdx] = useState(0);
  const [gridNotice, setGridNotice] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [isInputMode, setIsInputMode] = useState(false);
  const [isLocalSearchMode, setIsLocalSearchMode] = useState(false);
  const [localSearchQuery, setLocalSearchQuery] = useState('');

  const initialFileAppliedRef = useRef(false);

  const [isPaused, setIsPaused] = useState(false);
  const [seekDelta, setSeekDelta] = useState(0);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1.0);
  const [reverse, setReverse] = useState(false);
  const [markers, setMarkers] = useState<LottieMarker[]>([]);
  const [segmentRange, setSegmentRange] = useState<[number, number] | null>(null);
  const [seekTargetFrame, setSeekTargetFrame] = useState<number | null>(null);
  const [hotReloadContent, setHotReloadContent] = useState<string | undefined>(undefined);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [viewport, setViewport] = useState<ViewportState>({ zoom: 1.0, panX: 0, panY: 0 });
  const [frameProgress, setFrameProgress] = useState({
    current: 0,
    total: 1,
    fps: 0,
    isStatic: false,
  });

  const mcp = useMcpSearch((newFile) => {
    scanner.prependFile(newFile);
    setSelectedFile(newFile);
  }, scanner.basePath);

  const displayFileList = scanner.fileList.filter((f) => {
    if (isLocalSearchMode || localSearchQuery) {
      if (f.value.startsWith('__folder__')) return false;
      return path.basename(f.value).toLowerCase().includes(localSearchQuery.toLowerCase());
    }
    return true;
  });
  const extraHeight = isLocalSearchMode ? 4 : 0;
  const pageSize = Math.min(15, Math.max(5, termSize.rows - 18 - extraHeight));
  const totalPages = Math.ceil(displayFileList.length / pageSize) || 1;
  const currentPageItems = displayFileList.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  const playablePageFiles = currentPageItems.filter(isPlayableFile).slice(0, 4);
  const leftPanelCols = Math.floor(termSize.columns * 0.30) - 4;
  const previewWidth = Math.max(16, Math.floor((termSize.columns - 2) * 0.68) - 4);
  const previewHeight = Math.max(8, termSize.rows - 6);

  useEffect(() => {
    if (isGridMode && !isTerminalLargeEnoughForGrid(termSize.columns, termSize.rows)) {
      setIsGridMode(false);
      setGridNotice(GRID_SMALL_TERMINAL_NOTICE);
    }
  }, [isGridMode, termSize.columns, termSize.rows]);

  useEffect(() => {
    if (playablePageFiles.length > 0 && gridFocusIdx >= playablePageFiles.length) {
      setGridFocusIdx(0);
    }
  }, [playablePageFiles.length, gridFocusIdx]);

  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;
  const selectedFileValue = selectedFile?.value ?? null;

  useEffect(() => {
    setViewport({ zoom: 1.0, panX: 0, panY: 0 });
    setSegmentRange(null);
    setSeekTargetFrame(null);
    setHotReloadContent(undefined);
    setReloadVersion(0);
    setMarkers([]);
  }, [selectedFileValue]);

  const handleAssetDecoded = useCallback((content: string, format: 'svg' | 'lottie') => {
    setMarkers(format === 'lottie' ? parseLottieMarkers(content) : []);
  }, []);

  const handleHotReload = useCallback((newContent: string) => {
    setHotReloadContent(newContent);
    setReloadVersion((v) => v + 1);
    return true;
  }, []);

  const handleWatchDelete = useCallback(() => {
    setSelectedFile(null);
    setMarkers([]);
    setSegmentRange(null);
    setHotReloadContent(undefined);
  }, []);

  const watcherState = useFileWatcher(selectedFileValue, {
    onReload: handleHotReload,
    onDelete: handleWatchDelete,
  });

  useEffect(() => {
    if (scanner.isScanning) return;

    const playable = displayFileList.filter(isPlayableFile);
    if (playable.length === 0) {
      if (
        selectedFileRef.current &&
        !displayFileList.some((f) => f.value === selectedFileRef.current?.value)
      ) {
        setSelectedFile(null);
      }
      return;
    }

    if (initialFile && !initialFileAppliedRef.current) {
      initialFileAppliedRef.current = true;
      const targetResolved = path.resolve(initialFile);
      const matched = playable.find((f) => path.resolve(f.value) === targetResolved);
      if (matched) {
        const displayIdx = displayFileList.findIndex((f) => f.value === matched.value);
        if (displayIdx >= 0) setCurrentPage(Math.floor(displayIdx / pageSize));
        setSelectedFile(matched);
        return;
      }
    }

    const current = selectedFileRef.current;
    if (!current || !playable.some((f) => f.value === current.value)) {
      setSelectedFile(playable[0]);
    }
  }, [scanner.isScanning, scanner.fileList, localSearchQuery, initialFile, pageSize]);

  const clearKittyIfNeeded = () => {
    if (resolveEffectiveRenderMode(settingsMode) === 'kitty') {
      stdout?.write(KITTY_CLEAR_SEQ);
    }
  };

  const quitApp = () => {
    clearKittyIfNeeded();
    wasmModule?.destroy?.();
    exit();
  };

  const jumpToMarker = (marker: LottieMarker | undefined) => {
    if (!marker) return;
    setSeekTargetFrame(marker.time);
    if (segmentRange !== null) {
      setSegmentRange(marker.duration > 0 ? [marker.time, marker.endFrame] : null);
    }
  };

  // ─── 3단계 키보드 입력 가드 (텍스트 입력 격리 → 도움말 모달 → 탐색 모드) ───
  useInput((input, key) => {
    if (isInputMode || mcp.searchMode || isLocalSearchMode || mcp.authState.status !== 'idle') {
      if (key.escape) {
        setIsInputMode(false);
        setIsLocalSearchMode(false);
        if (isLocalSearchMode) setLocalSearchQuery('');
        mcp.closeSearch();
      }
      return;
    }

    if (isHelpOpen) {
      if (input === '?' || key.escape) setIsHelpOpen(false);
      else if (input.toLowerCase() === 'q') quitApp();
      return;
    }

    const lower = input.toLowerCase();

    if (lower === 'g') {
      if (isGridMode) {
        setGridNotice(null);
        setIsGridMode(false);
        return;
      }
      if (!isTerminalLargeEnoughForGrid(termSize.columns, termSize.rows)) {
        setGridNotice(GRID_SMALL_TERMINAL_NOTICE);
        return;
      }
      clearKittyIfNeeded();
      setGridNotice(null);
      const matchIdx = selectedFile
        ? playablePageFiles.findIndex((f) => f.value === selectedFile.value)
        : -1;
      setGridFocusIdx(matchIdx >= 0 ? matchIdx : 0);
      setIsGridMode(true);
      return;
    }

    if (isGridMode) {
      if (key.escape) {
        setIsGridMode(false);
        return;
      }
      if (key.return) {
        if (playablePageFiles[gridFocusIdx]) setSelectedFile(playablePageFiles[gridFocusIdx]);
        setIsGridMode(false);
        return;
      }
      const gridStep = key.leftArrow ? -1 : key.rightArrow ? 1 : key.upArrow ? -2 : key.downArrow ? 2 : 0;
      if (gridStep !== 0) {
        const candidate = gridFocusIdx + gridStep;
        if (candidate >= 0 && candidate < playablePageFiles.length) {
          setGridFocusIdx(candidate);
          setSelectedFile(playablePageFiles[candidate]);
        }
        return;
      }
    }

    // 일시정지 + 애니메이션 파일 선택 시에만 시크, 그 외(정적 SVG/폴더)는 페이지 이동으로 폴백
    const canSeek = isPaused && selectedFile !== null && !frameProgress.isStatic;
    if (key.leftArrow) {
      canSeek ? setSeekDelta((d) => d - 1) : setCurrentPage((p) => Math.max(0, p - 1));
      return;
    }
    if (key.rightArrow) {
      canSeek ? setSeekDelta((d) => d + 1) : setCurrentPage((p) => Math.min(totalPages - 1, p + 1));
      return;
    }
    if (input === ' ') {
      setIsPaused((p) => !p);
      return;
    }
    if (lower === 'm') {
      setSettingsMode((p) => cycleNext(renderModeOrder, p));
      return;
    }
    if (lower === 'd') {
      setInvertDark((p) => !p);
      return;
    }
    if (lower === 'b') {
      setBackgroundPreset((p) => cycleNext(BACKGROUND_ORDER, p));
      return;
    }
    if (lower === 'r') {
      scanner.cycleScanDepth();
      setCurrentPage(0);
      return;
    }
    if (input === '/' || lower === 'f') {
      setIsLocalSearchMode(true);
      return;
    }
    if (lower === 'o') {
      scanner.setScanError(null);
      setIsInputMode(true);
      return;
    }
    if (input === '+' || input === '=' || input === '-') {
      const dir = input === '-' ? -1 : 1;
      setViewport((v) => clampViewport(stepZoom(v.zoom, dir), v.panX, v.panY));
      return;
    }
    if (input === '0') {
      setViewport({ zoom: 1.0, panX: 0, panY: 0 });
      return;
    }
    if (input === '[' || input === ']') {
      setSpeed((s) => stepPlaybackSpeed(s, input === '[' ? -1 : 1));
      return;
    }
    if (lower === 'v') {
      setReverse((r) => !r);
      return;
    }
    if (lower === 'n') {
      if (markers.length > 0) jumpToMarker(getNextMarker(markers, frameProgress.current)?.marker);
      return;
    }
    if (input >= '1' && input <= '9') {
      jumpToMarker(markers[Number(input) - 1]);
      return;
    }
    if (lower === 't') {
      const active = findActiveMarker(markers, frameProgress.current);
      if (active && active.duration > 0) {
        setSegmentRange((prev) =>
          prev && prev[0] === active.time && prev[1] === active.endFrame
            ? null
            : [active.time, active.endFrame],
        );
      } else if (segmentRange !== null) {
        setSegmentRange(null);
      }
      return;
    }
    if (viewport.zoom > 1.0 && PAN_DELTAS[lower]) {
      const [dx, dy] = PAN_DELTAS[lower];
      setViewport((v) => panViewport(v, dx, dy));
      return;
    }
    if (lower === 'l' && scanner.basePath) {
      mcp.openSearch();
      return;
    }
    if (input === '?') {
      clearKittyIfNeeded();
      setIsHelpOpen(true);
      return;
    }
    if (lower === 'q') {
      quitApp();
    }
  });

  const handleHighlight = (item: FileItem) => {
    const file = scanner.fileList.find((f) => f.value === item?.value);
    setSelectedFile(isPlayableFile(file) ? file : null);
  };

  const updateFileDurationRef = useRef(scanner.updateFileDuration);
  updateFileDurationRef.current = scanner.updateFileDuration;

  const handleDurationLoad = useCallback(
    (duration: number, totalFrames: number, isStatic?: boolean) => {
      const current = selectedFileRef.current;
      if (current) {
        const rounded = Math.round(duration * 100) / 100;
        setSelectedFile((prev) =>
          prev && prev.value === current.value
            ? { ...prev, meta: { ...prev.meta, duration: rounded } }
            : prev,
        );
        updateFileDurationRef.current(current.value, duration);
      }
      setFrameProgress((prev) => ({
        ...prev,
        current: 0,
        total: totalFrames,
        fps: isStatic ? 0 : prev.fps,
        isStatic: Boolean(isStatic),
      }));
    },
    [],
  );

  const handleSeekConsumed = useCallback(() => setSeekDelta(0), []);
  const handleSeekTargetConsumed = useCallback(() => setSeekTargetFrame(null), []);
  const handleFrameUpdate = useCallback(
    (frame: number, totalFrames: number, fps: number, isStatic?: boolean) => {
      setFrameProgress({ current: Math.floor(frame), total: totalFrames, fps, isStatic: Boolean(isStatic) });
    },
    [],
  );

  const handleInputSubmit = async (val: string) => {
    const ok = await scanner.submitPath(val);
    if (!isMountedRef.current) return;
    setIsInputMode(false);
    if (ok) {
      setLocalSearchQuery('');
      setCurrentPage(0);
    }
  };

  if (mcp.authState.status !== 'idle') {
    return (
      <AuthOverlay
        authState={mcp.authState}
        columns={termSize.columns}
        rows={termSize.rows}
        clearKitty={resolveEffectiveRenderMode(settingsMode) === 'kitty'}
        onSubmitCode={mcp.submitAuthCode}
      />
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} width={termSize.columns} height={termSize.rows - 1}>
      <Box>
        <Text bold color="cyan">🚀 termvg - ThorVG Terminal Player</Text>
      </Box>

      {isHelpOpen ? (
        <HelpOverlay
          settingsMode={settingsMode}
          backgroundPreset={backgroundPreset}
          scanDepth={scanner.scanDepth}
          invertDark={invertDark}
        />
      ) : (
        <Box flexDirection="row">
          <LeftPanel
            selectedFile={selectedFile}
            fileList={displayFileList}
            page={{ current: currentPage, size: pageSize, total: totalPages }}
            scanner={{ basePath: scanner.basePath, depth: scanner.scanDepth, error: scanner.scanError }}
            render={{ mode: settingsMode, invertDark, backgroundPreset }}
            uiState={{ isHelpOpen, isGridMode, isInputMode, isLocalSearchMode, localSearchQuery }}
            mcp={{
              searchMode: mcp.searchMode,
              searchQuery: mcp.searchQuery,
              searchStatus: mcp.searchStatus,
              searchResults: mcp.searchResults,
              onQueryChange: mcp.setSearchQuery,
              onSubmit: mcp.doSearch,
              onSelect: mcp.doDownload,
            }}
            onInputSubmit={handleInputSubmit}
            onLocalSearchQueryChange={(val) => {
              setLocalSearchQuery(val);
              setCurrentPage(0);
            }}
            onLocalSearchSubmit={() => setIsLocalSearchMode(false)}
            onSelectFile={handleHighlight}
            leftPanelCols={leftPanelCols}
          />

          {isGridMode ? (
            <GridPreviewPanel
              files={playablePageFiles}
              focusedIndex={gridFocusIdx}
              wasmModule={wasmModule}
              settingsMode={settingsMode}
              invertDark={invertDark}
              backgroundPreset={backgroundPreset}
              previewWidth={previewWidth}
              previewHeight={previewHeight}
              isPaused={isPaused}
            />
          ) : (
            <PreviewPanel
              selectedFile={selectedFile}
              wasmModule={wasmModule}
              settingsMode={settingsMode}
              invertDark={invertDark}
              backgroundPreset={backgroundPreset}
              previewWidth={previewWidth}
              previewHeight={previewHeight}
              zoom={viewport.zoom}
              panX={viewport.panX}
              panY={viewport.panY}
              speed={speed}
              reverse={reverse}
              activeMarker={findActiveMarker(markers, frameProgress.current)}
              isSegmentLoop={segmentRange !== null}
              segmentRange={segmentRange}
              seekTargetFrame={seekTargetFrame}
              onSeekTargetConsumed={handleSeekTargetConsumed}
              reloadVersion={reloadVersion}
              rawContentOverride={hotReloadContent}
              hotReloadStatus={watcherState.status}
              hotReloadError={watcherState.errorMessage}
              notice={gridNotice}
              isPaused={isPaused}
              seekDelta={seekDelta}
              frameProgress={frameProgress}
              onDurationLoad={handleDurationLoad}
              onAssetDecoded={handleAssetDecoded}
              onSeekConsumed={handleSeekConsumed}
              onFrameUpdate={handleFrameUpdate}
            />
          )}
        </Box>
      )}
    </Box>
  );
};
