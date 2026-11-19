import React from 'react';
import { Box, Text } from 'ink';

export interface HelpOverlayProps {
  settingsMode: string;
  backgroundPreset: string;
  scanDepth: number;
  invertDark: boolean;
}

const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ['↑ / ↓', '파일 목록 탐색 (하이라이트 시 즉시 프리뷰)'],
  ['← / →', '페이지 이동 (재생 중) / 프레임 시크 (일시정지 중)'],
  ['Enter', '파일 또는 검색 항목 선택'],
  ['Space', '재생 / 일시정지 토글'],
  ['[ / ]', '재생 배속 감소 / 증가 (0.25x ~ 2.0x)'],
  ['V', '정방향 / 역방향 재생 전환'],
  ['N / 1~9 / T', '다음 마커 · 번호 마커 점프 · 마커 구간 반복 토글'],
  ['M', '렌더링 모드 순환 (quadrant → sextant → braille → half-block)'],
  ['D', '다크 모드 색상 반전 토글'],
  ['B', '배경 프리셋 순환 (transparent → dark → light → checkerboard)'],
  ['R', '하위 폴더 스캔 깊이 순환 (Depth: 0 → 1 → 2 → 3 → 0)'],
  ['/ 또는 F', '현재 폴더 로컬 필터 검색'],
  ['O', '탐색 디렉터리 경로 직접 입력'],
  ['L', 'LottieFiles MCP 온라인 검색 (zoom = 1.0x 기본 뷰)'],
  ['G', '2×2 멀티 에셋 그리드 갤러리 뷰 토글 (최소 60×20)'],
  ['+ / = / - / 0', '무손실 벡터 줌 확대/축소 (1.0x~8.0x) 및 뷰 리셋'],
  ['H / J / K / L', '확대 중(zoom > 1.0x) 뷰포트 좌/하/상/우 패닝'],
  ['?', '키보드 단축키 도움말 오버레이 토글'],
  ['Q', '안전한 리소스 해제 후 종료'],
];

export const HelpOverlay: React.FC<HelpOverlayProps> = ({
  settingsMode,
  backgroundPreset,
  scanDepth,
  invertDark,
}) => {
  return (
    <Box
      borderStyle="double"
      borderColor="cyan"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color="cyan">
          ⌨️  TermVG 단축키 도움말 (Keyboard Shortcuts)
        </Text>
        <Text color="gray">
          Mode:<Text color="green">{settingsMode}</Text> | Bg:<Text color="cyan">{backgroundPreset}</Text> | Depth:<Text color="yellow">{scanDepth}</Text> | Dark:<Text color={invertDark ? 'green' : 'red'}>{invertDark ? 'ON' : 'OFF'}</Text>
        </Text>
      </Box>

      {SHORTCUTS.map(([keyLabel, desc]) => (
        <Box key={keyLabel}>
          <Box width={14}>
            <Text bold color="yellow">
              {keyLabel}
            </Text>
          </Box>
          <Text color="white">{desc}</Text>
        </Box>
      ))}

      <Box marginTop={1}>
        <Text color="gray">(? 또는 ESC 키를 눌러 닫기 | Q: 종료)</Text>
      </Box>
    </Box>
  );
};
