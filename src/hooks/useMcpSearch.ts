import { useState, useRef } from 'react';
import {
  authenticateLottieOAuth,
  MCP_ENDPOINT,
  tryGetCachedToken,
  type OAuthFlowSession,
} from '../lottieAuth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { FileItem } from './useFileScanner.js';
import { fetchRemoteAssetBuffer } from '../loaders/assetLoader.js';
import { isZipMagicBytes } from '../loaders/dotLottieReader.js';

export interface SearchResultItem {
  label: string;
  value: string;
  meta: {
    jsonUrl: string | null;
    lottieUrl?: string | null;
    name: string;
    author: string;
    id: string;
    likes: number;
    downloads: number;
  };
}

export interface AuthState {
  status: 'idle' | 'initializing' | 'waiting' | 'exchanging';
  qrText: string;
  authUrl: string;
}

const IDLE_AUTH_STATE: AuthState = { status: 'idle', qrText: '', authUrl: '' };

const SEARCH_QUERY = `
  query Search($q: String!) {
    searchPublicAnimations(query: $q, first: 10) {
      edges {
        node {
          id name url jsonUrl lottieUrl
          likesCount downloads description sourceName
          createdBy { username }
        }
      }
    }
  }
`;

export function useMcpSearch(onFileAdded: (file: FileItem) => void, downloadDir: string) {
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [searchStatus, setSearchStatus] = useState('');
  const [mcpClient, setMcpClient] = useState<Client | null>(null);
  const [authState, setAuthState] = useState<AuthState>(IDLE_AUTH_STATE);

  const authSessionRef = useRef<OAuthFlowSession | null>(null);

  const connectWithToken = async (accessToken: string): Promise<Client> => {
    const client = new Client(
      { name: 'termvg', version: '1.0.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(MCP_ENDPOINT),
      { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } },
    );
    await client.connect(transport);
    setMcpClient(client);
    return client;
  };

  const executeSearch = async (query: string, client: Client) => {
    setSearchStatus(`🔍 '${query}' 검색 중...`);
    const result = await client.callTool({
      name: 'graphql_execute',
      arguments: { query: SEARCH_QUERY, variables: { q: query } },
    });

    const structured = (result as any).structuredContent;
    const edges = structured?.data?.searchPublicAnimations?.edges || [];
    const items: SearchResultItem[] = edges.map((e: any, i: number) => ({
      label: `${e.node.name}`,
      value: `__mcp__${i}`,
      meta: {
        jsonUrl: e.node.jsonUrl || null,
        lottieUrl: e.node.lottieUrl || null,
        name: e.node.name,
        author: e.node.createdBy?.username || 'unknown',
        id: String(e.node.id),
        likes: e.node.likesCount || 0,
        downloads: Math.round(e.node.downloads || 0),
      },
    }));

    setSearchResults(items);
    setSearchStatus(items.length > 0 ? `✅ ${items.length}개 결과` : '❌ 결과 없음');
  };

  const doSearch = async (query: string) => {
    setSearchStatus('🔌 MCP 연결 중...');
    try {
      let client = mcpClient;
      if (!client) {
        const cachedToken = await tryGetCachedToken();
        if (cachedToken) {
          client = await connectWithToken(cachedToken);
        } else {
          setSearchStatus('🔐 인증이 필요합니다...');
          setAuthState({ status: 'initializing', qrText: '', authUrl: '' });
          const accessToken = await authenticateLottieOAuth({
            onSession: (session) => {
              authSessionRef.current = session;
            },
            onReady: ({ qrText, authUrl }) => {
              setAuthState({ status: 'waiting', qrText, authUrl });
            },
            onExchanging: () => {
              authSessionRef.current = null;
              setAuthState((prev) => ({ ...prev, status: 'exchanging' }));
            },
          });
          if (!accessToken) return;
          client = await connectWithToken(accessToken);
          setAuthState(IDLE_AUTH_STATE);
        }
      }
      await executeSearch(query, client);
    } catch (e: any) {
      setSearchStatus(`❌ 오류: ${(e?.message || String(e)).substring(0, 50)}`);
      setAuthState(IDLE_AUTH_STATE);
      authSessionRef.current?.cancel();
      authSessionRef.current = null;
    }
  };

  /** 수동 인증 코드 제출 (QR 스캔 후 리다이렉트 URL 또는 코드 붙여넣기) */
  const submitAuthCode = (rawInput: string) => {
    authSessionRef.current?.submitCode(rawInput);
  };

  const doDownload = async (item: SearchResultItem) => {
    const { jsonUrl, lottieUrl, name, author, id } = item.meta;
    const downloadUrl = jsonUrl || lottieUrl || null;
    if (!downloadUrl) {
      setSearchStatus('❌ 다운로드 URL 없음');
      return;
    }
    setSearchStatus('⬇️ 다운로드 중...');
    try {
      const dir = downloadDir || path.join(os.homedir(), '.termvg', 'downloads');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const safeName = `${name}_by_${author}_${id}`
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .substring(0, 60);

      const { buffer, finalUrl } = await fetchRemoteAssetBuffer(downloadUrl);
      const urlPathLower = new URL(finalUrl).pathname.toLowerCase();
      const isDotLottie = isZipMagicBytes(buffer) || urlPathLower.endsWith('.lottie');
      if (isDotLottie && !isZipMagicBytes(buffer)) {
        throw new Error('Invalid .lottie binary payload');
      }
      const ext = isDotLottie ? '.lottie' : '.json';
      const filePath = path.join(dir, `${safeName}${ext}`);

      fs.writeFileSync(filePath, buffer);

      const stats = fs.statSync(filePath);
      const newFile: FileItem = {
        label: `🌐 ${name} (${author})`,
        value: filePath,
        meta: { duration: 0, size: `${(stats.size / 1024).toFixed(1)}kb` },
      };

      onFileAdded(newFile);
      setSearchMode(false);
      setSearchResults([]);
      setSearchStatus('');
    } catch (e: any) {
      setSearchStatus(`❌ 다운로드 실패: ${e.message.substring(0, 40)}`);
    }
  };

  const openSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
    setSearchStatus('');
    setSearchMode(true);
  };

  const closeSearch = () => {
    setSearchMode(false);
    setSearchResults([]);
    setSearchStatus('');
    if (authSessionRef.current) {
      authSessionRef.current.cancel();
      authSessionRef.current = null;
      setAuthState(IDLE_AUTH_STATE);
    }
  };

  return {
    searchMode,
    searchQuery,
    setSearchQuery,
    searchResults,
    searchStatus,
    doSearch,
    doDownload,
    openSearch,
    closeSearch,
    authState,
    submitAuthCode,
  };
}
