import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import path from 'path';
import { realWasmModule } from './realWasmModule.js';
import { useFileScanner, type FileItem } from './hooks/useFileScanner.js';
import { useMcpSearch } from './hooks/useMcpSearch.js';
import { LeftPanel } from './components/LeftPanel.js';
import { PreviewPanel } from './components/PreviewPanel.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import type { RenderMode } from './LottiePlayer.js';
import type { BackgroundPreset } from './utils/ansiPostProcessor.js';

export interface InteractiveMenuProps {
  wasmModule?: any;
  initialPath?: string;
  initialFile?: string;
  initialDepth?: number;
  initialError?: string | null;
}

const BACKGROUND_ORDER: readonly BackgroundPreset[] = [
  'transparent',
  'dark',
  'light',
  'checkerboard',
];

const RENDER_MODE_ORDER: readonly RenderMode[] = [
  'quadrant',
  'sextant',
  'braille',
  'half-block',
];

const isPlayableItem = (item: FileItem): boolean =>
  item.value !== '' && !item.value.startsWith('__folder__');

export const InteractiveMenu: React.FC<InteractiveMenuProps> = ({
  wasmModule = realWasmModule,
  initialPath = process.cwd(),
  initialFile,
  initialDepth = 1,
  initialError = null,
}) => {
  const { exit } = useApp();

  // ─── 터미널 크기 (80ms 디바운스 + 언마운트 가드) ───
  const [termSize, setTermSize] = useState({
    columns: process.stdout.columns || 100,
    rows: process.stdout.rows || 40,
  });
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
          columns: process.stdout.columns || 100,
          rows: process.stdout.rows || 40,
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
  }, []);

  // ─── 파일 스캐너 ───
  const scanner = useFileScanner(initialPath, initialDepth, initialError);

  // ─── UI 상태 ───
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [settingsMode, setSettingsMode] = useState<RenderMode>('quadrant');
  const [invertDark, setInvertDark] = useState(false);
  const [backgroundPreset, setBackgroundPreset] = useState<BackgroundPreset>('transparent');
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [isInputMode, setIsInputMode] = useState(false);
  const [inputPath, setInputPath] = useState('');
  const [isLocalSearchMode, setIsLocalSearchMode] = useState(false);
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [authCodeInput, setAuthCodeInput] = useState('');

  const initialFileAppliedRef = useRef(false);

  // ─── 재생 제어 ───
  const [isPaused, setIsPaused] = useState(false);
  const [seekDelta, setSeekDelta] = useState(0);
  const [frameProgress, setFrameProgress] = useState<{
    current: number;
    total: number;
    fps: number;
    isStatic: boolean;
  }>({ current: 0, total: 1, fps: 0, isStatic: false });

  // ─── MCP 검색 ───
  const mcp = useMcpSearch((newFile) => {
    scanner.prependFile(newFile);
    setSelectedFile(newFile);
  }, scanner.basePath);

  // ─── 레이아웃 및 필터링 ───
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
  const leftPanelCols = Math.floor(termSize.columns * 0.30) - 4;
  const previewWidth = Math.max(16, Math.floor((termSize.columns - 2) * 0.68) - 4);
  const previewHeight = Math.max(8, termSize.rows - 6);

  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;

  // 스캔 완료 또는 검색 필터 변경 시 첫 번째 재생 가능 에셋(또는 CLI 지정 initialFile) 자동 선택
  useEffect(() => {
    if (scanner.isScanning) return;

    const playable = displayFileList.filter(isPlayableItem);
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
        if (displayIdx >= 0) {
          setCurrentPage(Math.floor(displayIdx / pageSize));
        }
        setSelectedFile(matched);
        return;
      }
    }

    const current = selectedFileRef.current;
    if (!current || !playable.some((f) => f.value === current.value)) {
      setSelectedFile(playable[0]);
    }
  }, [scanner.isScanning, scanner.fileList, localSearchQuery, initialFile, pageSize]);

  // ─── 3단계 키보드 입력 가드 (텍스트 입력 격리 → 도움말 모달 → 탐색 모드) ───
  useInput((input, key) => {
    // 1순위: 텍스트 입력 활성 상태에서는 오직 ESC만 처리하고 전역 단축키 발동 차단
    if (isInputMode || mcp.searchMode || isLocalSearchMode || mcp.authState.status !== 'idle') {
      if (key.escape) {
        setIsInputMode(false);
        setIsLocalSearchMode(false);
        if (isLocalSearchMode) setLocalSearchQuery('');
        setAuthCodeInput('');
        mcp.closeSearch();
      }
      return;
    }

    // 2순위: 단축키 도움말 오버레이 활성 상태
    if (isHelpOpen) {
      if (input === '?' || key.escape) {
        setIsHelpOpen(false);
        return;
      }
      if (input.toLowerCase() === 'q') {
        wasmModule?.destroy?.();
        exit();
        return;
      }
      return;
    }

    // 3순위: 일반 탐색 모드
    // 일시정지 + 애니메이션 파일 선택 시에만 시크, 그 외(정적 SVG/폴더)는 페이지 이동으로 폴백
    const canSeek = isPaused && selectedFile !== null && !frameProgress.isStatic;
    if (key.leftArrow) {
      canSeek ? setSeekDelta((d) => d - 1) : setCurrentPage((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.rightArrow) {
      canSeek ? setSeekDelta((d) => d + 1) : setCurrentPage((prev) => Math.min(totalPages - 1, prev + 1));
      return;
    }
    if (input === ' ') {
      setIsPaused((prev) => !prev);
      return;
    }

    const lower = input.toLowerCase();
    if (lower === 'm') {
      setSettingsMode((prev) => {
        const nextIdx = (RENDER_MODE_ORDER.indexOf(prev) + 1) % RENDER_MODE_ORDER.length;
        return RENDER_MODE_ORDER[nextIdx];
      });
      return;
    }
    if (lower === 'd') {
      setInvertDark((prev) => !prev);
      return;
    }
    if (lower === 'b') {
      setBackgroundPreset((prev) => {
        const nextIdx = (BACKGROUND_ORDER.indexOf(prev) + 1) % BACKGROUND_ORDER.length;
        return BACKGROUND_ORDER[nextIdx];
      });
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
      setInputPath(scanner.basePath);
      setIsInputMode(true);
      return;
    }
    if (lower === 'l' && scanner.basePath) {
      mcp.openSearch();
      return;
    }
    if (input === '?') {
      setIsHelpOpen(true);
      return;
    }
    if (lower === 'q') {
      wasmModule?.destroy?.();
      exit();
      return;
    }
  });

  // ─── 이벤트 핸들러 ───
  const handleHighlight = (item: any) => {
    if (!item) return;
    const file = scanner.fileList.find((f) => f.value === item.value);
    setSelectedFile(file && isPlayableItem(file) ? file : null);
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

  const handleSeekConsumed = useCallback(() => {
    setSeekDelta(0);
  }, []);

  const handleFrameUpdate = useCallback(
    (frame: number, totalFrames: number, fps: number, isStatic?: boolean) => {
      setFrameProgress({
        current: Math.floor(frame),
        total: totalFrames,
        fps,
        isStatic: Boolean(isStatic),
      });
    },
    [],
  );

  // ─── 렌더링 ───

  // 인증 모드: 전체 화면 QR 코드 + 수동 입력
  const prevAuthStatus = useRef(mcp.authState.status);
  useEffect(() => {
    if (mcp.authState.status !== 'idle' && prevAuthStatus.current === 'idle') {
      process.stdout.write('\x1b[2J\x1b[H');
    }
    prevAuthStatus.current = mcp.authState.status;
  }, [mcp.authState.status]);

  if (mcp.authState.status !== 'idle') {
    return (
      <Box flexDirection="column" paddingX={2} width={termSize.columns} height={termSize.rows - 1}>
        <Box marginBottom={1}>
          <Text bold color="green">🔐 LottieFiles 인증</Text>
        </Box>
        {mcp.authState.status === 'initializing' && (
          <Text color="yellow">⏳ 인증 준비 중... (Client 등록 + PKCE 생성)</Text>
        )}
        {mcp.authState.status === 'waiting' && (
          <>
            <Text color="white">📱 QR 코드를 스캔하여 로그인하세요:</Text>
            <Box marginY={1}>
              <Text>{mcp.authState.qrText}</Text>
            </Box>
            <Text color="gray" wrap="truncate-end">🔗 {mcp.authState.authUrl}</Text>
            <Box marginTop={1} flexDirection="column">
              <Text color="white">─────────────────────────────────────</Text>
              <Text color="cyan">📋 또는 리다이렉트 URL/코드를 붙여넣으세요:</Text>
              <TextInput
                value={authCodeInput}
                onChange={setAuthCodeInput}
                onSubmit={(val) => {
                  if (val.trim()) {
                    mcp.submitAuthCode(val.trim());
                    setAuthCodeInput('');
                  }
                }}
              />
            </Box>
            <Box marginTop={1}>
              <Text color="gray">(ESC:취소)</Text>
            </Box>
          </>
        )}
        {mcp.authState.status === 'exchanging' && (
          <Text color="yellow">🔄 토큰 교환 중...</Text>
        )}
        {mcp.authState.status === 'error' && (
          <Text color="red">❌ {mcp.authState.error}</Text>
        )}
      </Box>
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
            currentPage={currentPage}
            pageSize={pageSize}
            totalPages={totalPages}
            basePath={scanner.basePath}
            settingsMode={settingsMode}
            invertDark={invertDark}
            backgroundPreset={backgroundPreset}
            scanDepth={scanner.scanDepth}
            scanError={scanner.scanError}
            isHelpOpen={isHelpOpen}
            isInputMode={isInputMode}
            inputPath={inputPath}
            onInputPathChange={setInputPath}
            onInputSubmit={async (val) => {
              const ok = await scanner.submitPath(val);
              if (!isMountedRef.current) return;
              setIsInputMode(false);
              if (ok) {
                setLocalSearchQuery('');
                setCurrentPage(0);
              }
            }}
            isLocalSearchMode={isLocalSearchMode}
            localSearchQuery={localSearchQuery}
            onLocalSearchQueryChange={(val) => {
              setLocalSearchQuery(val);
              setCurrentPage(0);
            }}
            onLocalSearchSubmit={() => setIsLocalSearchMode(false)}
            searchMode={mcp.searchMode}
            searchQuery={mcp.searchQuery}
            onSearchQueryChange={mcp.setSearchQuery}
            onSearchSubmit={(val) => mcp.doSearch(val)}
            searchStatus={mcp.searchStatus}
            searchResults={mcp.searchResults}
            onSearchSelect={(item) => mcp.doDownload(item)}
            onHighlight={handleHighlight}
            onSelect={handleHighlight}
            leftPanelCols={leftPanelCols}
          />

          <PreviewPanel
            selectedFile={selectedFile}
            wasmModule={wasmModule}
            settingsMode={settingsMode}
            invertDark={invertDark}
            backgroundPreset={backgroundPreset}
            previewWidth={previewWidth}
            previewHeight={previewHeight}
            isPaused={isPaused}
            seekDelta={seekDelta}
            frameProgress={frameProgress}
            onDurationLoad={handleDurationLoad}
            onSeekConsumed={handleSeekConsumed}
            onFrameUpdate={handleFrameUpdate}
          />
        </Box>
      )}
    </Box>
  );
};
