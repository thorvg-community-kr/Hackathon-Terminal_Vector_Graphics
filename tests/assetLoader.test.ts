import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import React from 'react';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { crc32 } from '../src/renderers/minimalPng.js';
import {
  extractDotLottie,
  isZipMagicBytes,
  MAX_DOTLOTTIE_ENTRIES,
  MAX_DOTLOTTIE_UNCOMPRESSED_BYTES,
} from '../src/loaders/dotLottieReader.js';
import {
  loadVectorAsset,
  MAX_REMOTE_ASSET_BYTES,
} from '../src/loaders/assetLoader.js';
import { realWasmModule } from '../src/realWasmModule.js';
import { scanDirectoryAsync } from '../src/hooks/useFileScanner.js';
import { useMcpSearch, type SearchResultItem } from '../src/hooks/useMcpSearch.js';
import { useFileWatcher } from '../src/hooks/useFileWatcher.js';
import type { FileItem } from '../src/hooks/useFileScanner.js';
import {
  createTempDirPool,
  DIST_ENTRY,
  makeSampleLottie,
  runBuiltCli,
} from './helpers/fsFixtures.js';
import { renderInk } from './helpers/inkHarness.js';
import { waitMs } from './helpers/wasmHarness.js';

interface ZipBuildEntry {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  overrideUncompressedSize?: number;
}

function buildZipBuffer(entries: ZipBuildEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const cdChunks: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 8;
    const payload = method === 8 ? zlib.deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);
    const uncompSize = entry.overrideUncompressedSize ?? entry.data.length;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(uncompSize, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    localChunks.push(lfh, nameBuf, payload);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(uncompSize, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(localOffset, 42);

    cdChunks.push(cdh, nameBuf);
    localOffset += lfh.length + nameBuf.length + payload.length;
  }

  const cdBuf = Buffer.concat(cdChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, cdBuf, eocd]);
}

describe('Task 10: .lottie (dotLottie) Reader, URL / stdin Asset Loader & Security Guards', () => {
  const tempDirs = createTempDirPool('termvg-dotlottie-');
  const activeServers: http.Server[] = [];

  afterEach(async () => {
    tempDirs.cleanup();
    while (activeServers.length > 0) {
      const srv = activeServers.pop()!;
      srv.closeAllConnections?.();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  afterAll(() => {
    realWasmModule.destroy();
  });

  it('extracts dotLottie v1 and v2 archives in memory and loads them cleanly into termvg.wasm', async () => {
    const tmpDir = tempDirs.create();

    const v1Buf = buildZipBuffer([
      {
        name: 'manifest.json',
        data: Buffer.from(JSON.stringify({ animations: [{ id: 'main' }] })),
      },
      { name: 'animations/main.json', data: Buffer.from(makeSampleLottie({ name: 'V1' })) },
    ]);
    const v2Buf = buildZipBuffer([
      {
        name: 'manifest.json',
        data: Buffer.from(JSON.stringify({ version: '2', animations: [{ id: 'hero' }] })),
      },
      { name: 'a/hero.json', data: Buffer.from(makeSampleLottie({ name: 'V2' })) },
    ]);

    expect(isZipMagicBytes(v1Buf)).toBe(true);
    const v1Path = path.join(tmpDir, 'sample-v1.lottie');
    const v2Path = path.join(tmpDir, 'sample-v2.lottie');
    const fakeLottiePath = path.join(tmpDir, 'corrupt.lottie');
    fs.writeFileSync(v1Path, v1Buf);
    fs.writeFileSync(v2Path, v2Buf);
    fs.writeFileSync(fakeLottiePath, 'not a zip archive', 'utf8');

    await realWasmModule.init();
    realWasmModule.setSize(64, 32);

    const assetV1 = await loadVectorAsset(v1Path);
    expect(assetV1.format).toBe('lottie');
    expect(assetV1.sourceKind).toBe('dotlottie');
    expect(assetV1.containerFormat).toBe('dotlottie');
    expect(assetV1.animationIds).toEqual(['main']);
    expect(realWasmModule.loadContent(assetV1.content)).toBe(true);
    expect(realWasmModule.getTotalFrames()).toBe(60);

    const assetV2 = await loadVectorAsset(v2Path);
    expect(assetV2.format).toBe('lottie');
    expect(assetV2.sourceKind).toBe('dotlottie');
    expect(assetV2.animationIds).toEqual(['hero']);
    expect(realWasmModule.loadContent(assetV2.content)).toBe(true);
    expect(realWasmModule.getTotalFrames()).toBe(60);

    // realWasmModule.load() 직접 호출 및 useFileScanner .lottie 스캔 검증
    expect(realWasmModule.load(v1Path)).toBe(true);
    const scanned = await scanDirectoryAsync(tmpDir, { maxDepth: 1 });
    const names = scanned.map((s) => path.basename(s.value));
    expect(names).toEqual(['sample-v1.lottie', 'sample-v2.lottie']);
  });

  it('supports multi-animation subAnimationId selection and inlines images/ as Base64 Data URIs', () => {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const multiBuf = buildZipBuffer([
      {
        name: 'manifest.json',
        data: Buffer.from(
          JSON.stringify({
            animations: [{ id: 'intro' }, { id: 'outro' }],
          }),
        ),
      },
      { name: 'animations/intro.json', data: Buffer.from(makeSampleLottie({ name: 'IntroAnim' })) },
      {
        name: 'animations/outro.json',
        data: Buffer.from(
          makeSampleLottie({
            name: 'OutroAnim',
            assets: [{ id: 'img_0', w: 16, h: 16, u: 'images/', p: 'img_0.png', e: 0 }],
          }),
        ),
      },
      { name: 'images/img_0.png', data: fakePng, method: 0 },
    ]);

    const firstRes = extractDotLottie(multiBuf);
    expect(firstRes.animationIds).toEqual(['intro', 'outro']);
    expect(firstRes.selectedAnimationId).toBe('intro');
    expect(JSON.parse(firstRes.content).nm).toBe('IntroAnim');

    const outroRes = extractDotLottie(multiBuf, 'outro');
    expect(outroRes.selectedAnimationId).toBe('outro');
    const parsedOutro = JSON.parse(outroRes.content);
    expect(parsedOutro.nm).toBe('OutroAnim');
    expect(parsedOutro.assets[0].e).toBe(1);
    expect(parsedOutro.assets[0].u).toBe('');
    expect(parsedOutro.assets[0].p).toBe(`data:image/png;base64,${fakePng.toString('base64')}`);

    expect(() => extractDotLottie(multiBuf, 'missing')).toThrow(/not found/i);
  });

  it('blocks Zip Bombs (declared >50MB, forged-header inflate >50MB, and >200 entries)', () => {
    // 1. 헤더 선언 크기 50MB 초과 차단
    const smallPayload = Buffer.from(makeSampleLottie());
    const declaredBomb = buildZipBuffer([
      {
        name: 'animations/main.json',
        data: smallPayload,
        overrideUncompressedSize: MAX_DOTLOTTIE_UNCOMPRESSED_BYTES + 1,
      },
    ]);
    expect(() => extractDotLottie(declaredBomb)).toThrow(/exceeds maximum safe size \(50MB\)/);

    // 2. 헤더를 64바이트로 위조했으나 실제 Deflate 스트림이 51MB 제로 바이트로 팽창하는 Zip Bomb 차단
    const bigZeros = Buffer.alloc(51 * 1024 * 1024, 0);
    const forgedBomb = buildZipBuffer([
      {
        name: 'animations/main.json',
        data: bigZeros,
        method: 8,
        overrideUncompressedSize: 64,
      },
    ]);
    expect(() => extractDotLottie(forgedBomb)).toThrow(/exceeds maximum safe size \(50MB\)/);

    // 3. 엔트리 개수 201개 초과 차단
    const manyEntries: ZipBuildEntry[] = Array.from(
      { length: MAX_DOTLOTTIE_ENTRIES + 1 },
      (_, idx) => ({
        name: `extra/${idx}.txt`,
        data: Buffer.from('x'),
        method: 0 as const,
      }),
    );
    const tooManyZip = buildZipBuffer(manyEntries);
    expect(() => extractDotLottie(tooManyZip)).toThrow(/exceeds maximum safe entry count \(200\)/);
  });

  it('ignores Zip-Slip path traversal and backslash entries while extracting valid animation', () => {
    const zipWithTraversal = buildZipBuffer([
      { name: '../../etc/passwd', data: Buffer.from('root:x:0:0'), method: 0 },
      { name: '/abs/evil.json', data: Buffer.from('{}'), method: 0 },
      { name: 'win\\evil.json', data: Buffer.from('{}'), method: 0 },
      { name: 'animations/anim.json', data: Buffer.from(makeSampleLottie({ name: 'SafeAnim' })) },
    ]);

    const extracted = extractDotLottie(zipWithTraversal);
    expect(extracted.selectedAnimationId).toBe('anim');
    expect(JSON.parse(extracted.content).nm).toBe('SafeAnim');
  });

  it('loads SVG, JSON, and .lottie via HTTP URL and blocks bad schemes, SSRF redirects, oversized responses, and timeouts', async () => {
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#00ff00"/></svg>';
    const lottieContent = makeSampleLottie({ name: 'HttpLottie' });
    const dotLottieBuf = buildZipBuffer([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify({ animations: [{ id: 'web' }] })) },
      { name: 'animations/web.json', data: Buffer.from(lottieContent) },
    ]);

    const server = http.createServer((req, res) => {
      const reqUrl = req.url || '/';
      if (reqUrl === '/icon.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end(svgContent);
      } else if (reqUrl === '/sample.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(lottieContent);
      } else if (reqUrl === '/bundle.lottie') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(dotLottieBuf);
      } else if (reqUrl === '/redirect-file') {
        res.writeHead(302, { Location: 'file:///etc/hosts' });
        res.end();
      } else if (reqUrl === '/redirect-ok') {
        res.writeHead(302, { Location: '/sample.json' });
        res.end();
      } else if (reqUrl === '/too-big') {
        // Content-Length 없이 25MB 초과 스트림 전송
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        const chunk = Buffer.alloc(1024 * 1024, 65);
        for (let i = 0; i < 27; i++) {
          res.write(chunk);
        }
        res.end();
      } else if (reqUrl === '/slow') {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200);
            res.end(svgContent);
          }
        }, 500);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    activeServers.push(server);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    const svgAsset = await loadVectorAsset(`${baseUrl}/icon.svg`);
    expect(svgAsset.format).toBe('svg');
    expect(svgAsset.sourceKind).toBe('url');
    expect(svgAsset.containerFormat).toBe('plain');

    const jsonAsset = await loadVectorAsset(`${baseUrl}/redirect-ok`);
    expect(jsonAsset.format).toBe('lottie');
    expect(jsonAsset.sourceKind).toBe('url');

    const lottieAsset = await loadVectorAsset(`${baseUrl}/bundle.lottie`);
    expect(lottieAsset.format).toBe('lottie');
    expect(lottieAsset.sourceKind).toBe('url');
    expect(lottieAsset.containerFormat).toBe('dotlottie');
    expect(lottieAsset.animationIds).toEqual(['web']);

    // 비허용 스킴 및 302 -> file:// SSRF 차단
    await expect(loadVectorAsset('file:///etc/hosts')).rejects.toThrow(/Unsupported URL scheme/i);
    await expect(loadVectorAsset('ftp://example.com/icon.svg')).rejects.toThrow(/Unsupported URL scheme/i);
    await expect(loadVectorAsset(`${baseUrl}/redirect-file`)).rejects.toThrow(/Unsupported URL scheme/i);

    // 404, 25MB 초과 스트리밍, 타임아웃 차단
    expect(MAX_REMOTE_ASSET_BYTES).toBe(25 * 1024 * 1024);
    await expect(loadVectorAsset(`${baseUrl}/missing`)).rejects.toThrow(/HTTP 404/);
    await expect(loadVectorAsset(`${baseUrl}/too-big`)).rejects.toThrow(/25MB/);
    await expect(loadVectorAsset(`${baseUrl}/slow`, undefined, { timeoutMs: 120 })).rejects.toThrow(/timed out/i);
  });

  it('loads SVG, Lottie JSON, and .lottie from stdin streams, rejects interactive TTY, and runs CLI pipe smoke cleanly', async () => {
    const svgBuf = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#ff0000"/></svg>',
    );
    const lottieBuf = Buffer.from(makeSampleLottie({ name: 'StdinLottie' }));
    const dotLottieBuf = buildZipBuffer([
      { name: 'animations/pipe.json', data: lottieBuf },
    ]);

    const makeStream = (buf: Buffer, isTTY: boolean) =>
      Object.assign(Readable.from([buf]), { isTTY });

    const svgRes = await loadVectorAsset('-', undefined, {
      stdinStream: makeStream(svgBuf, false),
    });
    expect(svgRes.format).toBe('svg');
    expect(svgRes.sourceKind).toBe('stdin');

    const lottieRes = await loadVectorAsset('-', undefined, {
      stdinStream: makeStream(lottieBuf, false),
    });
    expect(lottieRes.format).toBe('lottie');
    expect(lottieRes.sourceKind).toBe('stdin');
    expect(lottieRes.containerFormat).toBe('plain');

    const zipRes = await loadVectorAsset('-', undefined, {
      stdinStream: makeStream(dotLottieBuf, false),
    });
    expect(zipRes.format).toBe('lottie');
    expect(zipRes.sourceKind).toBe('stdin');
    expect(zipRes.containerFormat).toBe('dotlottie');
    expect(zipRes.animationIds).toEqual(['pipe']);

    await expect(
      loadVectorAsset('-', undefined, {
        stdinStream: makeStream(svgBuf, true),
      }),
    ).rejects.toThrow(/interactive TTY/i);

    // 실제 빌드된 dist/index.js에 stdin('-') 파이프 실행 검증 (빌드 존재 시)
    if (fs.existsSync(DIST_ENTRY)) {
      const childResult = await runBuiltCli(['play', '-'], svgBuf);
      expect(childResult.code).toBe(0);
      expect(childResult.stderr).toBe('');
      expect(childResult.stdout.length).toBeGreaterThan(0);

      const badUrlRes = await runBuiltCli(['play', 'file:///etc/hosts']);
      expect(badUrlRes.code).toBe(1);
      expect(badUrlRes.stderr).toMatch(/Unsupported URL scheme/i);
    }
  });

  it('preserves binary .lottie downloads in useMcpSearch and reloads .lottie edits in useFileWatcher', async () => {
    const tmpDir = tempDirs.create('termvg-mcp-dotlottie-');

    const v1Buf = buildZipBuffer([
      { name: 'animations/a.json', data: Buffer.from(makeSampleLottie({ name: 'McpDotLottieV1' })) },
    ]);
    const v2Buf = buildZipBuffer([
      { name: 'animations/a.json', data: Buffer.from(makeSampleLottie({ name: 'McpDotLottieV2' })) },
    ]);

    const server = http.createServer((req, res) => {
      if (req.url === '/asset.lottie') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(v1Buf);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    activeServers.push(server);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const added: FileItem[] = [];
    let doDownloadFn: ((item: SearchResultItem) => Promise<void>) | null = null;
    const McpHarness: React.FC = () => {
      const mcp = useMcpSearch((f) => added.push(f), tmpDir);
      doDownloadFn = mcp.doDownload;
      return null;
    };

    const { inst: mcpInst } = renderInk(React.createElement(McpHarness), 80, 24);
    await waitMs(30);

    await doDownloadFn!({
      label: 'Spark',
      value: '__mcp__0',
      meta: {
        jsonUrl: null,
        lottieUrl: `http://127.0.0.1:${port}/asset.lottie`,
        name: 'Spark',
        author: 'alice',
        id: '42',
        likes: 10,
        downloads: 100,
      },
    });
    mcpInst.unmount();

    expect(added).toHaveLength(1);
    expect(added[0].value.endsWith('.lottie')).toBe(true);
    const savedBuf = fs.readFileSync(added[0].value);
    expect(savedBuf.equals(v1Buf)).toBe(true);

    const reloadedContents: string[] = [];
    const WatchHarness: React.FC<{ filePath: string }> = ({ filePath }) => {
      useFileWatcher(filePath, {
        debounceMs: 50,
        retryDelayMs: 80,
        onReload: (content) => {
          reloadedContents.push(content);
          return true;
        },
      });
      return null;
    };

    const { inst: watchInst } = renderInk(
      React.createElement(WatchHarness, { filePath: added[0].value }),
      80,
      24,
    );
    await waitMs(70);

    fs.writeFileSync(added[0].value, v2Buf);
    await waitMs(200);
    watchInst.unmount();

    expect(reloadedContents.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(reloadedContents[reloadedContents.length - 1]).nm).toBe('McpDotLottieV2');
  });
});
