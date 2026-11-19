import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  exchangeCodeForToken,
  generateOAuthState,
  initiateAuthFlow,
  loadToken,
  saveToken,
  startCallbackServer,
  tryGetCachedToken,
  type TokenData,
} from '../src/lottieAuth.js';

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termvg-auth-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) {
      await fn();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('lottieAuth security & callback resilience', () => {
  it('enforces 0o700 directory and 0o600 file permissions when saving tokens', () => {
    const root = makeTempDir();
    const tokenDir = path.join(root, '.termvg');
    const tokenFile = path.join(tokenDir, 'token.json');

    const sample: TokenData = {
      access_token: 'acc_secret_123',
      refresh_token: 'ref_secret_456',
      client_id: 'client_abc',
      expires_at: Date.now() + 3600_000,
    };

    saveToken(sample, tokenFile);
    expect(loadToken(tokenFile)).toEqual(sample);

    if (process.platform !== 'win32') {
      expect(fs.statSync(tokenDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);

      // Existing overly permissive file & directory must be tightened on overwrite
      fs.chmodSync(tokenDir, 0o755);
      fs.chmodSync(tokenFile, 0o644);
      saveToken(sample, tokenFile);
      expect(fs.statSync(tokenDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    }
  });

  it('returns null safely for missing, malformed, or schema-incomplete token.json', async () => {
    const root = makeTempDir();
    const missingFile = path.join(root, 'missing.json');
    expect(loadToken(missingFile)).toBeNull();
    expect(await tryGetCachedToken(missingFile)).toBeNull();

    const brokenFile = path.join(root, 'broken.json');
    fs.writeFileSync(brokenFile, '{broken', 'utf8');
    expect(loadToken(brokenFile)).toBeNull();
    expect(await tryGetCachedToken(brokenFile)).toBeNull();

    const missingFieldsFile = path.join(root, 'partial.json');
    fs.writeFileSync(
      missingFieldsFile,
      JSON.stringify({ access_token: 'abc', client_id: 'cid' }),
      'utf8'
    );
    expect(loadToken(missingFieldsFile)).toBeNull();
    expect(await tryGetCachedToken(missingFieldsFile)).toBeNull();

    const emptyTokenFile = path.join(root, 'empty.json');
    fs.writeFileSync(
      emptyTokenFile,
      JSON.stringify({ access_token: '', client_id: 'cid', expires_at: Date.now() + 600_000 }),
      'utf8'
    );
    expect(loadToken(emptyTokenFile)).toBeNull();

    const validFile = path.join(root, 'valid.json');
    saveToken(
      {
        access_token: 'cached_valid_tok',
        refresh_token: 'ref_tok',
        client_id: 'cid',
        expires_at: Date.now() + 600_000,
      },
      validFile
    );
    expect(await tryGetCachedToken(validFile)).toBe('cached_valid_tok');
  });

  it('falls back to an ephemeral port on EADDRINUSE and resolves callback code', async () => {
    const dummy = http.createServer((_, res) => {
      res.writeHead(200);
      res.end('dummy');
    });
    await new Promise<void>((resolve) => dummy.listen(0, () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => dummy.close(() => resolve())));

    const address = dummy.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected numeric dummy port');
    }
    const occupiedPort = address.port;

    const handle = startCallbackServer('state-123', occupiedPort, 5000);
    cleanups.push(() => handle.cleanup());

    const fallbackPort = await handle.ready;
    expect(fallbackPort).toBeGreaterThan(0);
    expect(fallbackPort).not.toBe(occupiedPort);

    const response = await fetch(
      `http://127.0.0.1:${fallbackPort}/callback?code=ok_code&state=state-123`
    );
    expect(response.status).toBe(200);
    await expect(handle.promise).resolves.toBe('ok_code');
  });

  it('escapes HTML in OAuth error responses and rejects state mismatch or empty code', async () => {
    // 1. Reflected XSS protection on error query parameter
    const xssHandle = startCallbackServer('expected-state', 0, 5000);
    cleanups.push(() => xssHandle.cleanup());
    const xssPort = await xssHandle.ready;

    const xssRejection = expect(xssHandle.promise).rejects.toThrow('OAuth error:');
    const xssRes = await fetch(
      `http://127.0.0.1:${xssPort}/callback?error=${encodeURIComponent('<script>alert(1)</script>')}&state=bad`
    );
    const xssBody = await xssRes.text();
    expect(xssRes.status).toBe(400);
    expect(xssBody).not.toContain('<script>');
    expect(xssBody).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    await xssRejection;

    // 2. State mismatch rejection
    const stateHandle = startCallbackServer('expected-state', 0, 5000);
    cleanups.push(() => stateHandle.cleanup());
    const statePort = await stateHandle.ready;

    const stateRejection = expect(stateHandle.promise).rejects.toThrow('State mismatch');
    const stateRes = await fetch(
      `http://127.0.0.1:${statePort}/callback?code=abc&state=wrong-state`
    );
    expect(stateRes.status).toBe(400);
    await stateRejection;

    // 3. Empty/missing authorization code rejection
    const emptyCodeHandle = startCallbackServer('expected-state', 0, 5000);
    cleanups.push(() => emptyCodeHandle.cleanup());
    const emptyCodePort = await emptyCodeHandle.ready;

    const emptyCodeRejection = expect(emptyCodeHandle.promise).rejects.toThrow(
      'Missing authorization code'
    );
    const emptyCodeRes = await fetch(
      `http://127.0.0.1:${emptyCodePort}/callback?code=%20%20&state=expected-state`
    );
    expect(emptyCodeRes.status).toBe(400);
    await emptyCodeRejection;
  });

  it('propagates dynamic redirectPort consistently through initiateAuthFlow and exchangeCodeForToken', async () => {
    const root = makeTempDir();
    const tokenFile = path.join(root, '.termvg', 'token.json');
    const fetchCalls: Array<{ url: string; body: string }> = [];

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';
      fetchCalls.push({ url, body });

      if (url.endsWith('/register')) {
        return new Response(JSON.stringify({ client_id: 'dyn_client_1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          access_token: 'exchanged_access_tok',
          refresh_token: 'exchanged_refresh_tok',
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    vi.stubGlobal('fetch', mockFetch);

    const state = generateOAuthState();
    expect(state.length).toBeGreaterThanOrEqual(20);

    const flow = await initiateAuthFlow(45123, state);
    expect(flow.redirectPort).toBe(45123);
    expect(flow.state).toBe(state);
    expect(flow.clientId).toBe('dyn_client_1');
    expect(flow.authUrl).toContain(encodeURIComponent('http://localhost:45123/callback'));
    expect(JSON.parse(fetchCalls[0].body).redirect_uris).toEqual([
      'http://localhost:45123/callback',
    ]);

    const token = await exchangeCodeForToken(
      'auth_code_xyz',
      flow.verifier,
      flow.clientId,
      45123,
      tokenFile
    );
    expect(token).toBe('exchanged_access_tok');
    expect(fetchCalls[1].body).toContain(
      `redirect_uri=${encodeURIComponent('http://localhost:45123/callback')}`
    );
    expect(loadToken(tokenFile)?.access_token).toBe('exchanged_access_tok');
  });

  it('refreshes near-expiry cached token into customTokenFile with 0o600 permissions', async () => {
    const root = makeTempDir();
    const tokenFile = path.join(root, '.termvg', 'token.json');

    saveToken(
      {
        access_token: 'expiring_access_tok',
        refresh_token: 'valid_refresh_tok',
        client_id: 'cid_refresh',
        expires_at: Date.now() + 60_000, // within 5-minute refresh window
      },
      tokenFile
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: 'refreshed_access_tok',
            refresh_token: 'rotated_refresh_tok',
            expires_in: 7200,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );

    const token = await tryGetCachedToken(tokenFile);
    expect(token).toBe('refreshed_access_tok');

    const persisted = loadToken(tokenFile);
    expect(persisted?.access_token).toBe('refreshed_access_tok');
    expect(persisted?.refresh_token).toBe('rotated_refresh_tok');
    if (process.platform !== 'win32') {
      expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    }
  });

  it('does not emit unhandledRejection when binding fails or cleanup runs before ready', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      // 1. Synchronous/immediate cleanup before server emits listening; only ready is awaited
      const cancelledHandle = startCallbackServer('state-cancel', 0, 5000);
      cancelledHandle.cleanup();
      await expect(cancelledHandle.ready).rejects.toThrow('Callback server closed before listening');

      // 2. Non-EADDRINUSE binding error rejects both ready & promise simultaneously; caller awaits only ready
      const fakeServer = new EventEmitter() as http.Server;
      fakeServer.listen = ((..._args: unknown[]) => {
        queueMicrotask(() => {
          const err = Object.assign(new Error('listen EACCES: permission denied'), {
            code: 'EACCES',
          });
          fakeServer.emit('error', err);
        });
        return fakeServer;
      }) as http.Server['listen'];
      fakeServer.close = (() => fakeServer) as http.Server['close'];
      fakeServer.closeIdleConnections = () => {};

      vi.spyOn(http, 'createServer').mockReturnValueOnce(fakeServer);

      const errHandle = startCallbackServer('state-eacces', 9876, 5000);
      cleanups.push(() => errHandle.cleanup());
      await expect(errHandle.ready).rejects.toThrow('listen EACCES');

      // Allow Node promise rejection tracking turn to settle
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
