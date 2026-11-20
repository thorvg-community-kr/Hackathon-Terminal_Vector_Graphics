import React, { useState, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import type { AuthState } from '../hooks/useMcpSearch.js';
import { KITTY_CLEAR_SEQ } from '../renderers/kittyRenderer.js';

export interface AuthOverlayProps {
  authState: AuthState;
  columns: number;
  rows: number;
  clearKitty?: boolean;
  onSubmitCode: (code: string) => void;
}

/**
 * LottieFiles OAuth 2.0 PKCE 인증 오버레이 (QR 코드 스캔 + 수동 코드 붙여넣기).
 */
export const AuthOverlay: React.FC<AuthOverlayProps> = ({
  authState,
  columns,
  rows,
  clearKitty = false,
  onSubmitCode,
}) => {
  const { stdout } = useStdout();
  const [authCodeInput, setAuthCodeInput] = useState('');

  useEffect(() => {
    if (clearKitty) {
      stdout?.write(KITTY_CLEAR_SEQ);
    }
    process.stdout.write('\x1b[2J\x1b[H');
  }, [clearKitty, stdout]);

  return (
    <Box flexDirection="column" paddingX={2} width={columns} height={rows - 1}>
      <Box marginBottom={1}>
        <Text bold color="green">🔐 LottieFiles 인증</Text>
      </Box>
      {authState.status === 'initializing' && (
        <Text color="yellow">⏳ 인증 준비 중... (Client 등록 + PKCE 생성)</Text>
      )}
      {authState.status === 'waiting' && (
        <>
          <Text color="white">📱 QR 코드를 스캔하여 로그인하세요:</Text>
          <Box marginY={1}>
            <Text>{authState.qrText}</Text>
          </Box>
          <Text color="gray" wrap="truncate-end">🔗 {authState.authUrl}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text color="white">─────────────────────────────────────</Text>
            <Text color="cyan">📋 또는 리다이렉트 URL/코드를 붙여넣으세요:</Text>
            <TextInput
              value={authCodeInput}
              onChange={setAuthCodeInput}
              onSubmit={(val) => {
                if (val.trim()) {
                  onSubmitCode(val.trim());
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
      {authState.status === 'exchanging' && (
        <Text color="yellow">🔄 토큰 교환 중...</Text>
      )}
    </Box>
  );
};
