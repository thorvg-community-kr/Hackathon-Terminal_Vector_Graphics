import React, { useState } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import path from 'path';
import type { FileItem } from '../hooks/useFileScanner.js';
import type { SearchResultItem } from '../hooks/useMcpSearch.js';
import type { BackgroundPreset } from '../utils/ansiPostProcessor.js';

export interface LeftPanelProps {
  selectedFile: FileItem | null;
  fileList: FileItem[];
  page: { current: number; size: number; total: number };
  scanner: { basePath: string; depth: number; error: string | null };
  render: { mode: string; invertDark: boolean; backgroundPreset: BackgroundPreset };
  uiState: {
    isHelpOpen: boolean;
    isGridMode: boolean;
    isInputMode: boolean;
    isLocalSearchMode: boolean;
    localSearchQuery: string;
  };
  mcp: {
    searchMode: boolean;
    searchQuery: string;
    searchStatus: string;
    searchResults: SearchResultItem[];
    onQueryChange: (val: string) => void;
    onSubmit: (val: string) => void;
    onSelect: (item: SearchResultItem) => void;
  };
  onInputSubmit: (val: string) => void;
  onLocalSearchQueryChange: (val: string) => void;
  onLocalSearchSubmit: () => void;
  onSelectFile: (item: FileItem) => void;
  leftPanelCols: number;
}

/** 라벨을 패널 폭에 맞게 잘라내는 공용 말줄임 헬퍼 */
export const truncLabel = (label: string, maxCols: number): string => {
  if (maxCols <= 2) return label.substring(0, Math.max(0, maxCols));
  if (label.length <= maxCols) return label;
  return label.substring(0, maxCols - 2) + '..';
};

const compactNum = (n: number): string => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
};

const PathInputPrompt: React.FC<{ initialValue: string; onSubmit: (val: string) => void }> = ({
  initialValue,
  onSubmit,
}) => {
  const [value, setValue] = useState(initialValue);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan">Enter directory path:</Text>
      <TextInput value={value} onChange={setValue} onSubmit={onSubmit} />
      <Text color="gray">(Enter to apply, ESC cancel)</Text>
    </Box>
  );
};

export const LeftPanel: React.FC<LeftPanelProps> = ({
  selectedFile,
  fileList,
  page,
  scanner,
  render,
  uiState,
  mcp,
  onInputSubmit,
  onLocalSearchQueryChange,
  onLocalSearchSubmit,
  onSelectFile,
  leftPanelCols,
}) => {
  const [highlightedSearch, setHighlightedSearch] = useState<SearchResultItem | null>(null);
  const { isHelpOpen, isGridMode, isInputMode, isLocalSearchMode, localSearchQuery } = uiState;

  return (
    <Box width="30%" flexDirection="column" borderStyle="single" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        {mcp.searchMode && highlightedSearch ? (
          <>
            <Text color="white" bold>{truncLabel(highlightedSearch.meta.name, leftPanelCols)}</Text>
            <Text color="gray">@{truncLabel(highlightedSearch.meta.author, leftPanelCols - 1)}</Text>
            <Text color="gray">
              <Text color="red">♥</Text>{compactNum(highlightedSearch.meta.likes)}{' '}
              <Text color="cyan">↓</Text>{compactNum(highlightedSearch.meta.downloads)}
            </Text>
          </>
        ) : (
          <>
            <Text color="gray">
              Name: <Text color="white">{selectedFile ? truncLabel(path.basename(selectedFile.value), leftPanelCols) : '-'}</Text>
            </Text>
            <Text color="gray">{selectedFile ? `${selectedFile.meta.duration}s | ${selectedFile.meta.size}` : ''}</Text>
            <Text color="gray">
              <Text color="green">{render.mode}</Text>(M) Dark:<Text color={render.invertDark ? 'green' : 'red'}>{render.invertDark ? 'ON' : 'OFF'}</Text>(D)
            </Text>
            <Text color="gray">
              Bg:<Text color="cyan">{render.backgroundPreset}</Text>(B) Depth:<Text color="yellow">{scanner.depth}</Text>(R)
            </Text>
          </>
        )}
        {scanner.error ? <Text color="red">{scanner.error}</Text> : null}
      </Box>

      {mcp.searchMode ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="magenta" bold>🌐 LottieFiles 검색</Text>
          <TextInput
            value={mcp.searchQuery}
            onChange={mcp.onQueryChange}
            onSubmit={(val) => {
              if (val.trim()) mcp.onSubmit(val.trim());
            }}
          />
          <Text color="gray">(Enter:검색 ESC:취소)</Text>
          {mcp.searchStatus ? <Text color="yellow">{truncLabel(mcp.searchStatus, leftPanelCols)}</Text> : null}
          {mcp.searchResults.length > 0 ? (
            <SelectInput
              items={mcp.searchResults.map((r, i) => ({
                ...r,
                label: truncLabel(`${i + 1}. ${r.meta.name}`, leftPanelCols - 2),
              }))}
              limit={page.size}
              onSelect={mcp.onSelect as (item: any) => void}
              onHighlight={(item: any) => {
                const found = mcp.searchResults.find((r) => r.value === item.value);
                if (found) setHighlightedSearch(found);
              }}
            />
          ) : null}
        </Box>
      ) : isInputMode ? (
        <PathInputPrompt initialValue={scanner.basePath} onSubmit={onInputSubmit} />
      ) : !scanner.basePath ? (
        <Box flexDirection="column">
          <Text color="gray">O 키를 눌러 경로를 지정하세요</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {isLocalSearchMode && (
            <Box flexDirection="column" marginBottom={1}>
              <Text color="green" bold>🔍 현재 폴더 검색:</Text>
              <TextInput
                value={localSearchQuery}
                onChange={onLocalSearchQueryChange}
                onSubmit={onLocalSearchSubmit}
              />
              <Text color="gray">(ESC:취소, Enter:리스트 진입)</Text>
            </Box>
          )}
          {fileList.length > 0 ? (
            <SelectInput
              isFocused={!isLocalSearchMode && !isHelpOpen && !isInputMode && !mcp.searchMode && !isGridMode}
              items={fileList
                .slice(page.current * page.size, (page.current + 1) * page.size)
                .map((f) => ({ ...f, label: truncLabel(f.label, leftPanelCols) }))}
              limit={page.size}
              onSelect={onSelectFile as (item: any) => void}
              onHighlight={onSelectFile as (item: any) => void}
            />
          ) : (
            <Text>No files found.</Text>
          )}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {scanner.basePath ? (
          <>
            <Text color="cyan">Page {page.current + 1}/{page.total} ({fileList.length})</Text>
            <Text color="gray">↑↓ browse ←→ pages</Text>
            <Text color="green">/:Search R:Depth B:Bg ?:Help</Text>
          </>
        ) : (
          <Text color="gray" dimColor>ThorVG Terminal Player</Text>
        )}
        <Text color="magenta">L:LottieFiles <Text color="cyan">O:Open G:Grid Q:Quit</Text></Text>
      </Box>
    </Box>
  );
};
