import { useState, useRef } from 'react';
import {
  tryGetCachedToken,
  initiateAuthFlow,
  startCallbackServer,
  exchangeCodeForToken,
  generateOAuthState,
  MCP_ENDPOINT,
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
  status: 'idle' | 'initializing' | 'waiting' | 'exchanging' | 'error';
  qrText: string;
  authUrl: string;
  error: string;
}

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
  const [isSearching, setIsSearching] = useState(false);
  const [searchStatus, setSearchStatus] = useState('');
  const [mcpClient, setMcpClient] = useState<Client | null>(null);
  const [authState, setAuthState] = useState<AuthState>({
    status: 'idle', qrText: '', authUrl: '', error: '',
  });

  const authFlowRef = useRef<{
    verifier: string;
    clientId: string;
    codeResolver: ((code: string) => void) | null;
    cleanup: () => void;
  } | null>(null);
  const pendingSearchRef = useRef<string | null>(null);

  // ─── 내부 헬퍼 ───

  const connectWithToken = async (accessToken: string): Promise<Client> => {
    const client = new Client(
      { name: 'termvg', version: '1.0.0' },
      { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(MCP_ENDPOINT),
      { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }
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

  // ─── 공개 API ───

  const doSearch = async (query: string) => {
    setIsSearching(true);
    setSearchStatus('🔌 MCP 연결 중...');
    let cancelled = false;
    try {
      // 이미 연결된 경우
      if (mcpClient) {
        await executeSearch(query, mcpClient);
        setIsSearching(false);
        return;
      }

      // 캐시된 토큰 시도
      const cachedToken = await tryGetCachedToken();
      if (cachedToken) {
        const client = await connectWithToken(cachedToken);
        await executeSearch(query, client);
        setIsSearching(false);
        return;
      }

      // ─── 인증 필요: OAuth 플로우 시작 ───
      pendingSearchRef.current = query;
      setSearchStatus('🔐 인증이 필요합니다...');
      setAuthState({ status: 'initializing', qrText: '', authUrl: '', error: '' });

      const oauthState = generateOAuthState();
      const server = startCallbackServer(oauthState);
      server.promise.catch(() => {});
      let cancelWait: (() => void) | null = null;
      const cleanupAuthServer = () => {
        cancelled = true;
        server.cleanup();
        cancelWait?.();
      };
      authFlowRef.current = {
        verifier: '',
        clientId: '',
        codeResolver: null,
        cleanup: cleanupAuthServer,
      };
      const boundPort = await server.ready;
      const flow = await initiateAuthFlow(boundPort, oauthState);
      if (cancelled) {
        server.cleanup();
        setIsSearching(false);
        return;
      }

      // HTTP 콜백 또는 수동 입력 중 먼저 완료되는 것으로 인증
      const code = await new Promise<string>((resolve, reject) => {
        let settled = false;
        const finishResolve = (c: string) => {
          if (settled) return;
          settled = true;
          resolve(c);
        };
        cancelWait = () => {
          if (settled) return;
          settled = true;
          reject(new Error('Auth cancelled'));
        };
        authFlowRef.current = {
          verifier: flow.verifier,
          clientId: flow.clientId,
          codeResolver: finishResolve,
          cleanup: cleanupAuthServer,
        };
        setAuthState({
          status: 'waiting',
          qrText: flow.qrText,
          authUrl: flow.authUrl,
          error: '',
        });

        // HTTP 콜백 경로
        server.promise.then((c) => finishResolve(c)).catch(() => {});
      });

      // 인증 코드 획득 완료: 콜백 서버만 종료 (cancelled 플래그는 유지)
      server.cleanup();
      authFlowRef.current = null;

      setAuthState((prev) => ({ ...prev, status: 'exchanging' }));
      const accessToken = await exchangeCodeForToken(
        code,
        flow.verifier,
        flow.clientId,
        boundPort
      );

      const client = await connectWithToken(accessToken);
      setAuthState({ status: 'idle', qrText: '', authUrl: '', error: '' });
      authFlowRef.current = null;

      // 보류 중인 검색 실행
      const pendingQuery = pendingSearchRef.current;
      pendingSearchRef.current = null;
      if (pendingQuery) {
        await executeSearch(pendingQuery, client);
      }
    } catch (e: any) {
      if (!cancelled) {
        setSearchStatus(`❌ 오류: ${e.message.substring(0, 50)}`);
      }
      setAuthState({ status: 'idle', qrText: '', authUrl: '', error: '' });
      if (authFlowRef.current?.cleanup) authFlowRef.current.cleanup();
      authFlowRef.current = null;
    }
    setIsSearching(false);
  };

  /** 수동 인증 코드 제출 (QR 스캔 후 리다이렉트 URL 또는 코드 붙여넣기) */
  const submitAuthCode = (rawInput: string) => {
    if (!authFlowRef.current?.codeResolver) return;
    let code = rawInput.trim();
    const codeMatch = code.match(/code=([^&\s]+)/);
    if (codeMatch) code = codeMatch[1];
    else code = code.split('&')[0].split('?')[0];
    authFlowRef.current.codeResolver(code);
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
    // 진행 중인 인증 취소
    if (authFlowRef.current) {
      authFlowRef.current.cleanup();
      authFlowRef.current = null;
      setAuthState({ status: 'idle', qrText: '', authUrl: '', error: '' });
    }
  };

  return {
    searchMode,
    searchQuery,
    setSearchQuery,
    searchResults,
    isSearching,
    searchStatus,
    doSearch,
    doDownload,
    openSearch,
    closeSearch,
    authState,
    submitAuthCode,
  };
}
