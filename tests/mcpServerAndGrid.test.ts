import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createTermvgMcpServer,
  installMcpStdioGuard,
} from '../src/mcp/termvgMcpServer.js';
import {
  generateGridSnapshots,
  GRID_SMALL_TERMINAL_NOTICE,
  isTerminalLargeEnoughForGrid,
} from '../src/components/GridPreviewPanel.js';
import { InteractiveMenu } from '../src/InteractiveMenu.js';
import { KITTY_CLEAR_SEQ } from '../src/renderers/kittyRenderer.js';
import { realWasmModule } from '../src/realWasmModule.js';
import type { FileItem } from '../src/hooks/useFileScanner.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createMockTerminalStreams(cols = 120, rows = 36) {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & PassThrough;
  (stdout as any).columns = cols;
  (stdout as any).rows = rows;
  (stdout as any).isTTY = true;

  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
  (stdin as any).isTTY = true;
  (stdin as any).setRawMode = vi.fn();
  (stdin as any).ref = vi.fn();
  (stdin as any).unref = vi.fn();

  const chunks: string[] = [];
  stdout.on('data', (chunk: Buffer | string) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });

  return {
    stdout,
    stdin,
    getChunks: () => chunks,
    getOutput: () => chunks.join(''),
    getLatestChunk: () => chunks[chunks.length - 1] ?? '',
  };
}

const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Task 12: 2x2 Grid Gallery View & Local MCP Server (termvg mcp)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    realWasmModule.destroy();
  });

  it('handles MCP InMemoryTransport round-trip for listTools, inspect_vector, render_vector_snapshot, stdin rejection, and idempotent destroy', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server, cleanup } = createTermvgMcpServer();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listRes = await client.listTools();
    const toolNames = listRes.tools.map((t) => t.name);
    expect(toolNames).toContain('inspect_vector');
    expect(toolNames).toContain('render_vector_snapshot');

    const inspectRes = await client.callTool({
      name: 'inspect_vector',
      arguments: { source: path.join(REPO_ROOT, 'assets/5317-fireworkds.json') },
    });
    expect(inspectRes.isError).toBeFalsy();
    const inspectText = (inspectRes.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    const report = JSON.parse(inspectText);
    expect(report.engineLoadOk).toBe(true);
    expect(report.frames).toBe(150);

    const snapRes = await client.callTool({
      name: 'render_vector_snapshot',
      arguments: {
        source: path.join(REPO_ROOT, 'assets/2961.svg'),
        width: 128,
        height: 128,
      },
    });
    expect(snapRes.isError).toBeFalsy();
    const snapContent = snapRes.content as Array<{
      type: string;
      mimeType?: string;
      data?: string;
      text?: string;
    }>;
    expect(snapContent[0]?.type).toBe('image');
    expect(snapContent[0]?.mimeType).toBe('image/png');
    const pngBytes = Buffer.from(snapContent[0]?.data ?? '', 'base64');
    expect(pngBytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(snapContent[1]?.type).toBe('text');
    expect(snapContent[1]?.text).toContain('2961.svg');

    // stdin('-') 전달 시 즉시 거부
    const stdinErr = await client.callTool({
      name: 'inspect_vector',
      arguments: { source: '-' },
    });
    expect(stdinErr.isError).toBe(true);

    await client.close();
    await server.close();
    cleanup();

    // 스파이로 멱등 cleanup() 시 wasmModule.destroy() 정확히 1회 호출 검증
    const spyWasm = {
      init: vi.fn(async () => {}),
      setSize: vi.fn(),
      loadContent: vi.fn(() => true),
      getTotalFrames: vi.fn(() => 1),
      getDuration: vi.fn(() => 0),
      renderToString: vi.fn(() => ''),
      destroy: vi.fn(),
    };
    const isolated = createTermvgMcpServer({ wasmModule: spyWasm });
    isolated.cleanup();
    isolated.cleanup();
    expect(spyWasm.destroy).toHaveBeenCalledTimes(1);

    // installMcpStdioGuard가 console.log를 stderr로 리다이렉트하고 복원하는지 확인
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const restore = installMcpStdioGuard();
    console.log('guarded-msg');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('guarded-msg'));
    restore();
  });

  it('runs real `termvg mcp` subprocess with zero stdout contamination and exits 0 on stdin EOF', async () => {
    const distEntry = path.join(REPO_ROOT, 'dist', 'index.js');
    if (!fs.existsSync(distEntry)) {
      return;
    }

    const proc = spawn(process.execPath, [distEntry, 'mcp'], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutLines: string[] = [];
    let rawBuf = '';
    const pendingWaiters: Array<(line: string) => void> = [];

    proc.stdout.on('data', (chunk: Buffer) => {
      rawBuf += chunk.toString('utf8');
      let nlIdx: number;
      while ((nlIdx = rawBuf.indexOf('\n')) !== -1) {
        const line = rawBuf.slice(0, nlIdx).trim();
        rawBuf = rawBuf.slice(nlIdx + 1);
        if (line.length > 0) {
          const waiter = pendingWaiters.shift();
          if (waiter) {
            waiter(line);
          } else {
            stdoutLines.push(line);
          }
        }
      }
    });

    const readNextJson = (timeoutMs = 5000): Promise<any> =>
      new Promise((resolve, reject) => {
        if (stdoutLines.length > 0) {
          const line = stdoutLines.shift()!;
          resolve(JSON.parse(line));
          return;
        }
        const t = setTimeout(() => reject(new Error('Timed out waiting for MCP stdout line')), timeoutMs);
        pendingWaiters.push((line) => {
          clearTimeout(t);
          resolve(JSON.parse(line));
        });
      });

    const sendMsg = (msg: Record<string, unknown>) => {
      proc.stdin.write(JSON.stringify(msg) + '\n');
    };

    sendMsg({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'stdio-smoke', version: '1.0.0' },
      },
    });
    const initResp = await readNextJson();
    expect(initResp.id).toBe(1);
    expect(initResp.result.serverInfo.name).toBe('termvg-mcp-server');

    sendMsg({ jsonrpc: '2.0', method: 'notifications/initialized' });
    sendMsg({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listResp = await readNextJson();
    expect(listResp.id).toBe(2);
    expect(listResp.result.tools.map((t: any) => t.name)).toEqual([
      'inspect_vector',
      'render_vector_snapshot',
    ]);

    sendMsg({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'render_vector_snapshot',
        arguments: { source: 'assets/2961.svg', width: 64, height: 64 },
      },
    });
    const callResp = await readNextJson();
    expect(callResp.id).toBe(3);
    expect(callResp.result.content[0].type).toBe('image');
    const decoded = Buffer.from(callResp.result.content[0].data, 'base64');
    expect(decoded.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const exitPromise = new Promise<number | null>((resolve) => {
      proc.on('close', (code) => resolve(code));
    });
    proc.stdin.end();
    const exitCode = await exitPromise;
    expect(exitCode).toBe(0);
    expect(rawBuf.trim()).toBe('');
  });

  it('serializes grid snapshots through AsyncMutex without cross-contamination and isolates Invalid Asset', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termvg-grid-'));
    tempDirs.push(tmpDir);

    const brokenPath = path.join(tmpDir, 'broken.json');
    fs.writeFileSync(brokenPath, '{corrupted json', 'utf8');

    const files: FileItem[] = [
      { label: '2961.svg', value: path.join(REPO_ROOT, 'assets/2961.svg'), meta: { duration: 0, size: '1kb' } },
      { label: 'broken.json', value: brokenPath, meta: { duration: 0, size: '1kb' } },
      { label: '1528966158.svg', value: path.join(REPO_ROOT, 'assets/1528966158.svg'), meta: { duration: 0, size: '2kb' } },
      { label: '5317-fireworkds.json', value: path.join(REPO_ROOT, 'assets/5317-fireworkds.json'), meta: { duration: 5, size: '9kb' } },
    ];

    let activeCount = 0;
    let maxConcurrency = 0;
    const serializedWasm = {
      init: async () => {
        activeCount++;
        maxConcurrency = Math.max(maxConcurrency, activeCount);
        await waitMs(5);
        await realWasmModule.init();
        activeCount--;
      },
      setSize: (w: number, h: number) => realWasmModule.setSize(w, h),
      loadContent: (c: string) => realWasmModule.loadContent(c),
      getTotalFrames: () => realWasmModule.getTotalFrames(),
      getDuration: () => realWasmModule.getDuration(),
      renderToString: (f: number, m: number, inv: boolean) => realWasmModule.renderToString(f, m, inv),
    };

    const [snapA, snapB] = await Promise.all([
      generateGridSnapshots(files, {
        wasmModule: serializedWasm,
        tileCols: 20,
        tileRows: 10,
        mode: 'quadrant',
        invertDark: false,
        backgroundPreset: 'transparent',
      }),
      generateGridSnapshots(files.slice(0, 2), {
        wasmModule: serializedWasm,
        tileCols: 20,
        tileRows: 10,
        mode: 'quadrant',
        invertDark: false,
        backgroundPreset: 'transparent',
      }),
    ]);

    expect(maxConcurrency).toBe(1);
    expect(snapA.get(files[0].value)?.status).toBe('ready');
    expect(snapA.get(files[0].value)?.ansi.length).toBeGreaterThan(0);
    expect(snapA.get(brokenPath)?.status).toBe('error');
    expect(snapA.get(brokenPath)?.errorMessage).toBe('Invalid Asset');
    expect(snapA.get(files[2].value)?.status).toBe('ready');
    expect(snapA.get(files[3].value)?.status).toBe('ready');
    expect(snapA.get(files[0].value)?.ansi).not.toBe(snapA.get(files[2].value)?.ansi);
    expect(snapB.get(files[0].value)?.ansi).toBe(snapA.get(files[0].value)?.ansi);
  });

  it('guards <60x20 terminals on G press and toggles 2x2 Grid Gallery + Kitty clear + arrow/Enter navigation cleanly', async () => {
    expect(isTerminalLargeEnoughForGrid(50, 18)).toBe(false);
    expect(isTerminalLargeEnoughForGrid(60, 20)).toBe(true);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termvg-grid-tui-'));
    tempDirs.push(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.svg'), '<svg width="10" height="10"><rect width="10" height="10" fill="#ff0000"/></svg>');
    fs.writeFileSync(path.join(tmpDir, 'b.svg'), '<svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="#00ff00"/></svg>');

    const mockWasm = {
      init: vi.fn(async () => {}),
      setSize: vi.fn(),
      load: vi.fn(() => true),
      loadContent: vi.fn(() => true),
      getTotalFrames: vi.fn(() => 0),
      getDuration: vi.fn(() => 0),
      renderToString: vi.fn(() => '\x1b[38;2;255;0;0m▄\x1b[0m'),
      destroy: vi.fn(),
    };

    // 1. 소형 터미널(50x18)에서 'G' 입력 시 그리드 거부 및 안내 문구 출력 검증
    const smallStreams = createMockTerminalStreams(50, 18);
    const smallInst = render(
      React.createElement(InteractiveMenu, {
        wasmModule: mockWasm,
        initialPath: tmpDir,
        initialDepth: 0,
      }),
      { stdout: smallStreams.stdout, stdin: smallStreams.stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );
    await waitMs(120);
    smallStreams.stdin.write('g');
    await waitMs(100);
    const normalizedNoticeOut = smallStreams
      .getLatestChunk()
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/[│\s]+/g, ' ');
    expect(normalizedNoticeOut).toContain(GRID_SMALL_TERMINAL_NOTICE);
    expect(normalizedNoticeOut).not.toContain('2×2 Grid Gallery');
    smallStreams.stdin.write('q');
    await smallInst.waitUntilExit();

    // 2. 정상 터미널(120x36) + Kitty 환경에서 'G' 토글 시 Kitty 클리어, 화살표 이동, Enter 상세 복귀 검증
    const savedEnv = {
      KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
      TERM: process.env.TERM,
      TERM_PROGRAM: process.env.TERM_PROGRAM,
      TMUX: process.env.TMUX,
      STY: process.env.STY,
      TERMVG_WEB: process.env.TERMVG_WEB,
    };
    process.env.KITTY_WINDOW_ID = '1';
    process.env.TERM = 'xterm-kitty';
    delete process.env.TERM_PROGRAM;
    delete process.env.TMUX;
    delete process.env.STY;
    delete process.env.TERMVG_WEB;
    try {
      const largeStreams = createMockTerminalStreams(120, 36);
      const largeInst = render(
        React.createElement(InteractiveMenu, {
          wasmModule: mockWasm,
          initialPath: tmpDir,
          initialDepth: 0,
        }),
        { stdout: largeStreams.stdout, stdin: largeStreams.stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
      );
      await waitMs(120);

      largeStreams.stdin.write('g');
      await waitMs(120);
      expect(largeStreams.getOutput()).toContain(KITTY_CLEAR_SEQ);
      expect(largeStreams.getOutput()).toContain('2×2 Grid Gallery');

      // 오른쪽 화살표로 두 번째 타일(b.svg) 포커스 후 Enter로 상세 프리뷰 복귀
      largeStreams.stdin.write('\x1b[C');
      await waitMs(80);
      largeStreams.stdin.write('\r');
      await waitMs(100);
      const lastUiFrame = largeStreams
        .getChunks()
        .filter((c) => c.includes('ThorVG Terminal Player'))
        .pop() ?? '';
      expect(lastUiFrame).toContain('Name: b.svg');
      expect(lastUiFrame).not.toContain('2×2 Grid Gallery');
      expect(largeStreams.getLatestChunk()).toContain('\x1b_Ga=T');

      largeStreams.stdin.write('q');
      await largeInst.waitUntilExit();
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
