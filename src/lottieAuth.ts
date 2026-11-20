/**
 * lottieAuth.ts - LottieFiles OAuth 2.0 인증 모듈
 *
 * Ink TUI 환경에서 OAuth authorization_code + PKCE 플로우를 수행합니다.
 * - QR 코드 URL 생성 및 로컬 HTTP 콜백 서버(포트 충돌 시 동적 폴백)
 * - refresh_token을 ~/.termvg/token.json (0o600)에 캐싱하여 재인증 최소화
 */
import crypto from "crypto";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";

// @ts-ignore
import qrcode from "qrcode-terminal";

export const MCP_ENDPOINT = "https://mcp.lottiefiles.com/mcp";
export const DEFAULT_REDIRECT_PORT = 9876;

const REGISTER_URL = "https://mcp.lottiefiles.com/register";
const AUTH_URL = "https://mcp.lottiefiles.com/authorize";
const TOKEN_URL = "https://mcp.lottiefiles.com/token";

const TOKEN_DIR = path.join(os.homedir(), ".termvg");
const TOKEN_FILE = path.join(TOKEN_DIR, "token.json");

export interface TokenData {
  access_token: string;
  refresh_token: string;
  client_id: string;
  expires_at: number; // unix timestamp
}

export interface CallbackServerHandle {
  /** 실제 바인딩 완료된 로컬 포트 번호를 반환하는 Promise */
  ready: Promise<number>;
  /** /callback 수신 시 authorization code를 반환하는 Promise */
  promise: Promise<string>;
  /** 타임아웃 타이머 해제 및 HTTP 서버 즉시 종료 */
  cleanup: () => void;
}

export interface OAuthFlowSession {
  submitCode: (rawInput: string) => void;
  cancel: () => void;
}

export interface OAuthFlowCallbacks {
  onSession: (session: OAuthFlowSession) => void;
  onReady: (flow: { authUrl: string; qrText: string }) => void;
  onExchanging?: () => void;
}

// --- PKCE & Security helpers ---
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePKCE() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function chmodSafe(targetPath: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    // Ignore chmod failures on restricted filesystems
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function sendHttpResponse(
  res: http.ServerResponse,
  status: number,
  body: string,
  isHtml = true,
): void {
  res.writeHead(status, {
    "Content-Type": `${isHtml ? "text/html" : "text/plain"}; charset=utf-8`,
    Connection: "close",
  });
  res.end(body);
}

/** OAuth CSRF 방지를 위한 16바이트 base64url state 문자열을 생성합니다. */
export function generateOAuthState(): string {
  return base64url(crypto.randomBytes(16));
}

// --- Token persistence ---

/**
 * OAuth 토큰을 소유자 전용 권한(디렉터리 0o700, 파일 0o600)으로 저장합니다.
 */
export function saveToken(data: TokenData, customTokenFile: string = TOKEN_FILE): void {
  const dir = path.dirname(customTokenFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSafe(dir, 0o700);

  fs.writeFileSync(customTokenFile, JSON.stringify(data, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSafe(customTokenFile, 0o600);
}

/**
 * 캐시된 OAuth 토큰을 로드하고 필수 스키마를 검증합니다.
 * 손상되었거나 필수 필드가 누락된 경우 예외 없이 null을 반환합니다.
 */
export function loadToken(customTokenFile: string = TOKEN_FILE): TokenData | null {
  if (!fs.existsSync(customTokenFile)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(customTokenFile, "utf8")) as Partial<TokenData> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.access_token !== "string" ||
      parsed.access_token.length === 0 ||
      typeof parsed.client_id !== "string" ||
      typeof parsed.expires_at !== "number" ||
      !Number.isFinite(parsed.expires_at)
    ) {
      return null;
    }

    return {
      access_token: parsed.access_token,
      refresh_token: typeof parsed.refresh_token === "string" ? parsed.refresh_token : "",
      client_id: parsed.client_id,
      expires_at: parsed.expires_at,
    };
  } catch {
    return null;
  }
}

async function requestAndSaveToken(
  params: Record<string, string>,
  clientId: string,
  fallbackRefreshToken: string,
  customTokenFile: string,
): Promise<TokenData> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    throw new Error(`Token 교환 실패: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as any;
  if (typeof data?.access_token !== "string" || data.access_token.length === 0) {
    throw new Error("Token 응답에 access_token이 없습니다.");
  }

  const tokenData: TokenData = {
    access_token: data.access_token,
    refresh_token:
      typeof data.refresh_token === "string" && data.refresh_token
        ? data.refresh_token
        : fallbackRefreshToken,
    client_id: clientId,
    expires_at:
      Date.now() + (typeof data.expires_in === "number" ? data.expires_in : 3600) * 1000,
  };
  saveToken(tokenData, customTokenFile);
  return tokenData;
}

// --- Token refresh ---
async function refreshAccessToken(
  token: TokenData,
  customTokenFile: string = TOKEN_FILE
): Promise<TokenData | null> {
  if (!token.refresh_token) return null;
  try {
    return await requestAndSaveToken(
      {
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: token.client_id,
      },
      token.client_id,
      token.refresh_token,
      customTokenFile,
    );
  } catch {
    return null;
  }
}

// ─── Ink UI 연동을 위한 분해된 인증 빌딩 블록 ───

/**
 * 캐시된 토큰이 유효하면 반환, 만료 시 refresh 시도.
 * 로그인 플로우는 실행하지 않습니다.
 */
export async function tryGetCachedToken(
  customTokenFile: string = TOKEN_FILE
): Promise<string | null> {
  const cached = loadToken(customTokenFile);
  if (!cached) return null;
  if (Date.now() < cached.expires_at - 300000) return cached.access_token;
  const refreshed = await refreshAccessToken(cached, customTokenFile);
  return refreshed?.access_token || null;
}

/**
 * OAuth 인증 플로우를 시작합니다. (console/readline 사용 안 함)
 * Dynamic Client Registration + PKCE + QR 생성 후 결과를 반환합니다.
 */
export async function initiateAuthFlow(
  redirectPort: number = DEFAULT_REDIRECT_PORT,
  stateOverride?: string
): Promise<{
  authUrl: string;
  qrText: string;
  verifier: string;
  clientId: string;
  state: string;
  redirectPort: number;
}> {
  const redirectUri = `http://localhost:${redirectPort}/callback`;
  const regRes = await fetch(REGISTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "TermVG CLI",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp:full",
    }),
  });
  if (!regRes.ok) throw new Error(`Client Registration 실패: ${regRes.status}`);
  const regData = (await regRes.json()) as any;
  const clientId = regData.client_id;

  const { verifier, challenge } = generatePKCE();
  const state = stateOverride || generateOAuthState();

  const authUrl =
    `${AUTH_URL}?` +
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "mcp:full",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

  const qrText = await new Promise<string>((resolve) => {
    qrcode.generate(authUrl, { small: true }, (qr: string) => resolve(qr));
  });

  return { authUrl, qrText, verifier, clientId, state, redirectPort };
}

/**
 * 로컬 HTTP 콜백 서버를 시작합니다.
 * preferredPort가 EADDRINUSE로 충돌하면 OS 할당 가용 포트(0)로 자동 폴백합니다.
 */
export function startCallbackServer(
  expectedState: string,
  preferredPort: number = DEFAULT_REDIRECT_PORT,
  timeoutMs: number = 180000
): CallbackServerHandle {
  let server: http.Server | null = null;
  let timeoutId: NodeJS.Timeout | null = null;
  let retriedWithZero = false;
  let readySettled = false;
  let promiseSettled = false;
  let closed = false;

  const readyDef = createDeferred<number>();
  const codeDef = createDeferred<string>();

  const rejectReadyOnce = (err: Error) => {
    if (!readySettled) {
      readySettled = true;
      readyDef.reject(err);
    }
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (server) {
      try {
        server.closeIdleConnections?.();
      } catch {}
      try {
        server.close();
      } catch {}
    }
    rejectReadyOnce(new Error("Callback server closed before listening"));
  };

  const settleCode = (err: Error | null, code?: string) => {
    if (promiseSettled) return;
    promiseSettled = true;
    cleanup();
    err ? codeDef.reject(err) : codeDef.resolve(code!);
  };

  server = http.createServer((req, res) => {
    let url: URL;
    try {
      const host = req.headers.host || `localhost:${preferredPort}`;
      url = new URL(req.url || "/", `http://${host}`);
    } catch {
      sendHttpResponse(res, 400, "Bad Request", false);
      return;
    }

    if (url.pathname !== "/callback") {
      sendHttpResponse(res, 404, "Not Found", false);
      return;
    }

    if (promiseSettled) {
      sendHttpResponse(res, 409, "Callback already processed", false);
      return;
    }

    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      sendHttpResponse(res, 400, `<h1>❌ 인증 실패</h1><p>${escapeHtml(error)}</p>`);
      settleCode(new Error(`OAuth error: ${error}`));
      return;
    }

    if (returnedState !== expectedState) {
      sendHttpResponse(res, 400, "<h1>❌ State 불일치</h1>");
      settleCode(new Error("State mismatch"));
      return;
    }

    if (!code || code.trim() === "") {
      sendHttpResponse(res, 400, "<h1>❌ 인증 코드 누락</h1><p>Missing authorization code</p>");
      settleCode(new Error("Missing authorization code"));
      return;
    }

    sendHttpResponse(
      res,
      200,
      "<html><body style='text-align:center;padding:50px;font-family:sans-serif'>" +
        "<h1>✅ 인증 성공!</h1><p>터미널로 돌아가세요.</p></body></html>",
    );
    settleCode(null, code);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && !retriedWithZero && preferredPort !== 0 && !closed) {
      retriedWithZero = true;
      server?.listen(0);
      return;
    }
    rejectReadyOnce(err);
    settleCode(err);
  });

  server.on("listening", () => {
    if (readySettled || !server) return;
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : preferredPort;
    readySettled = true;
    readyDef.resolve(port);
  });

  timeoutId = setTimeout(() => {
    settleCode(new Error("인증 타임아웃 (3분)"));
  }, timeoutMs);

  try {
    server.listen(preferredPort);
  } catch (err) {
    const listenError = err instanceof Error ? err : new Error(String(err));
    rejectReadyOnce(listenError);
    settleCode(listenError);
  }

  return {
    ready: readyDef.promise,
    promise: codeDef.promise,
    cleanup,
  };
}

/**
 * 인증 코드를 access_token으로 교환하고 저장합니다.
 */
export async function exchangeCodeForToken(
  code: string,
  verifier: string,
  clientId: string,
  redirectPort: number = DEFAULT_REDIRECT_PORT,
  customTokenFile: string = TOKEN_FILE
): Promise<string> {
  const token = await requestAndSaveToken(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: `http://localhost:${redirectPort}/callback`,
      client_id: clientId,
      code_verifier: verifier,
    },
    clientId,
    "",
    customTokenFile,
  );
  return token.access_token;
}

/**
 * 로컬 콜백 서버 + PKCE QR 생성 + 수동 코드 입력 경합 + 토큰 교환을 단일 플로우로 실행한다.
 * 사용자가 cancel()로 취소한 경우 null을 반환한다.
 */
export async function authenticateLottieOAuth(
  callbacks: OAuthFlowCallbacks,
): Promise<string | null> {
  const oauthState = generateOAuthState();
  const server = startCallbackServer(oauthState);
  const manualDef = createDeferred<string>();
  let cancelled = false;
  let canSubmit = false;

  callbacks.onSession({
    submitCode: (rawInput: string) => {
      if (!canSubmit) return;
      const trimmed = rawInput.trim();
      const match = trimmed.match(/code=([^&\s]+)/);
      manualDef.resolve(match ? match[1] : trimmed.split("&")[0].split("?")[0]);
    },
    cancel: () => {
      cancelled = true;
      server.cleanup();
      manualDef.reject(new Error("Auth cancelled"));
    },
  });

  try {
    const boundPort = await server.ready;
    const flow = await initiateAuthFlow(boundPort, oauthState);
    if (cancelled) return null;

    canSubmit = true;
    callbacks.onReady({ authUrl: flow.authUrl, qrText: flow.qrText });
    const code = await Promise.race([server.promise, manualDef.promise]);

    server.cleanup();
    callbacks.onExchanging?.();
    return await exchangeCodeForToken(code, flow.verifier, flow.clientId, boundPort);
  } catch (err) {
    if (cancelled) return null;
    throw err;
  } finally {
    server.cleanup();
  }
}
