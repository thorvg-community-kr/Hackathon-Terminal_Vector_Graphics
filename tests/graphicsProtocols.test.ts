import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { crc32, encodeRgbaToPng } from '../src/renderers/minimalPng.js';
import {
  detectTerminalProtocol,
  isUnsupportedMultiplexerOrWeb,
} from '../src/renderers/protocolDetector.js';
import {
  clearKittyGraphics,
  encodeKittyGraphics,
  KITTY_CLEAR_SEQ,
  KITTY_MAX_CHUNK_SIZE,
} from '../src/renderers/kittyRenderer.js';
import { encodeIterm2Graphics } from '../src/renderers/iterm2Renderer.js';
import { LottiePlayer } from '../src/LottiePlayer.js';
import { buildGraphicsOverlay } from '../src/hooks/useGraphicsOverlay.js';
import {
  calcPixelSize,
  resolveEffectiveRenderMode,
} from '../src/renderers/headlessPipeline.js';
import { getRenderModeOrder } from '../src/InteractiveMenu.js';
import {
  applyBackgroundPresetToPixels,
  type PixelFrame,
} from '../src/renderers/pixelExtractor.js';
import { realWasmModule } from '../src/realWasmModule.js';
import { createTempDirPool } from './helpers/fsFixtures.js';
import { mountInteractiveMenu, renderInk } from './helpers/inkHarness.js';
import { waitMs } from './helpers/wasmHarness.js';

function parsePngChunks(png: Buffer): Array<{
  type: string;
  data: Buffer;
  storedCrc: number;
  computedCrc: number;
}> {
  const chunks: Array<{
    type: string;
    data: Buffer;
    storedCrc: number;
    computedCrc: number;
  }> = [];

  let offset = 8; // skip PNG signature
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const storedCrc = png.readUInt32BE(dataEnd);
    const computedCrc = crc32(png.subarray(offset + 4, dataEnd));
    chunks.push({
      type,
      data: png.subarray(dataStart, dataEnd),
      storedCrc,
      computedCrc,
    });
    offset = dataEnd + 4;
  }

  return chunks;
}

describe('Task 07: Native Terminal Graphics Protocols (Kitty / iTerm2) & Auto-Detection', () => {
  const tempDirs = createTempDirPool('termvg-kitty-tui-');

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    tempDirs.cleanup();
  });

  afterAll(() => {
    realWasmModule.destroy();
  });

  it('encodes valid PNG buffers with signature, IHDR/IDAT/IEND chunks, accurate CRC32, and lossless RGBA round-trip', () => {
    const width = 4;
    const height = 4;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        if ((x + y) % 2 === 0) {
          // 투명 픽셀
          data[idx] = 0;
          data[idx + 1] = 0;
          data[idx + 2] = 0;
          data[idx + 3] = 0;
        } else {
          data[idx] = 20 + x * 40;
          data[idx + 1] = 50 + y * 35;
          data[idx + 2] = 210;
          data[idx + 3] = 255;
        }
      }
    }

    const png = encodeRgbaToPng({ width, height, data });

    // PNG 매직 시그니처 (8 bytes)
    expect(Array.from(png.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    const chunks = parsePngChunks(png);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);

    for (const chunk of chunks) {
      expect(chunk.storedCrc).toBe(chunk.computedCrc);
    }

    const ihdr = chunks[0].data;
    expect(ihdr.readUInt32BE(0)).toBe(width);
    expect(ihdr.readUInt32BE(4)).toBe(height);
    expect(ihdr[8]).toBe(8); // bitDepth
    expect(ihdr[9]).toBe(6); // colorType RGBA
    expect(ihdr[10]).toBe(0);
    expect(ihdr[11]).toBe(0);
    expect(ihdr[12]).toBe(0);

    expect(chunks[2].storedCrc).toBe(0xae426082);

    // IDAT 압축 해제 후 필터 바이트(0) + 원본 RGBA 바이트 100% 라운드트립 검증
    const inflated = zlib.inflateSync(chunks[1].data);
    const stride = 1 + width * 4;
    expect(inflated.length).toBe(height * stride);
    const restored = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      expect(inflated[y * stride]).toBe(0);
      restored.set(inflated.subarray(y * stride + 1, (y + 1) * stride), y * width * 4);
    }
    expect(Buffer.from(restored)).toEqual(Buffer.from(data));

    // 잘못된 크기/버퍼 방어 검증
    expect(() =>
      encodeRgbaToPng({ width: 0, height: 4, data: new Uint8Array(16) }),
    ).toThrow(RangeError);
    expect(() =>
      encodeRgbaToPng({ width: 4, height: 4, data: new Uint8Array(10) }),
    ).toThrow(RangeError);
    expect(() =>
      encodeRgbaToPng({ width: 2.5, height: 4, data: new Uint8Array(64) }),
    ).toThrow(RangeError);
  });

  it('chunks Kitty APC G payloads into <= 4096-byte Base64 segments with m=1..m=0 and exposes clearKittyGraphics()', () => {
    const width = 64;
    const height = 64;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i++) {
      data[i] = (i * 73 + 19) & 0xff;
    }

    const encodedUncompressed = encodeKittyGraphics(
      { width, height, data },
      { cols: 40, rows: 20, compress: false },
    );

    const apcMatches = [...encodedUncompressed.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
    expect(apcMatches.length).toBeGreaterThanOrEqual(2);

    const b64Parts: string[] = [];
    for (let idx = 0; idx < apcMatches.length; idx++) {
      const header = apcMatches[idx][1];
      const chunk = apcMatches[idx][2];
      b64Parts.push(chunk);

      if (idx === 0) {
        expect(header).toBe('a=T,f=32,i=1,p=1,s=64,v=64,c=40,r=20,C=1,q=2,m=1');
        expect(chunk.length).toBe(KITTY_MAX_CHUNK_SIZE);
      } else if (idx < apcMatches.length - 1) {
        expect(header).toBe('m=1');
        expect(chunk.length).toBe(KITTY_MAX_CHUNK_SIZE);
      } else {
        expect(header).toBe('m=0');
        expect(chunk.length).toBeGreaterThan(0);
        expect(chunk.length).toBeLessThanOrEqual(KITTY_MAX_CHUNK_SIZE);
      }
    }

    const decoded = Buffer.from(b64Parts.join(''), 'base64');
    expect(decoded).toEqual(Buffer.from(data));

    // zlib 압축(o=z) 기본 경로 검증
    const encodedCompressed = encodeKittyGraphics(
      { width, height, data },
      { cols: 40, rows: 20 },
    );
    expect(encodedCompressed).toContain(',o=z,');
    const compMatches = [...encodedCompressed.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
    const compBytes = Buffer.from(compMatches.map((m) => m[2]).join(''), 'base64');
    expect(zlib.inflateSync(compBytes)).toEqual(Buffer.from(data));

    expect(clearKittyGraphics()).toBe(KITTY_CLEAR_SEQ);
    expect(clearKittyGraphics()).toBe('\x1b_Ga=d\x1b\\');
  });

  it('encodes iTerm2 OSC 1337 inline PNG sequences with valid PNG payload and aspect flags', () => {
    const frame: PixelFrame = {
      width: 6,
      height: 4,
      data: new Uint8Array(6 * 4 * 4).fill(200),
    };

    const seq = encodeIterm2Graphics(frame, { cols: 40, rows: 20 });
    expect(seq.startsWith('\x1b]1337;File=inline=1;')).toBe(true);
    expect(seq.endsWith('\x07')).toBe(true);

    const match = seq.match(
      /^\x1b\]1337;File=inline=1;size=(\d+);width=40;height=20;preserveAspectRatio=1:([A-Za-z0-9+/=]+)\x07$/,
    );
    expect(match).not.toBeNull();
    const declaredSize = Number(match![1]);
    const pngBuf = Buffer.from(match![2], 'base64');
    expect(pngBuf.length).toBe(declaredSize);
    expect(Array.from(pngBuf.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    const noPreserve = encodeIterm2Graphics(frame, {
      cols: 12,
      rows: 6,
      preserveAspectRatio: false,
    });
    expect(noPreserve).toContain('preserveAspectRatio=0:');
  });

  it('accurately detects terminal graphics protocols and safely falls back under tmux/screen/ttyd/vscode', () => {
    // Kitty 계열
    expect(detectTerminalProtocol({ KITTY_WINDOW_ID: '1' })).toBe('kitty');
    expect(detectTerminalProtocol({ TERM: 'xterm-kitty' })).toBe('kitty');
    expect(detectTerminalProtocol({ TERM_PROGRAM: 'ghostty' })).toBe('kitty');
    expect(detectTerminalProtocol({ GHOSTTY_RESOURCES_DIR: '/app' })).toBe('kitty');
    expect(detectTerminalProtocol({ TERM: 'xterm-ghostty' })).toBe('kitty');
    expect(detectTerminalProtocol({ TERM_PROGRAM: 'WezTerm' })).toBe('kitty');

    // iTerm2 계열
    expect(detectTerminalProtocol({ TERM_PROGRAM: 'iTerm.app' })).toBe('iterm2');
    expect(detectTerminalProtocol({ ITERM_SESSION_ID: 'w0t0p0' })).toBe('iterm2');
    expect(detectTerminalProtocol({ LC_TERMINAL: 'iTerm2' })).toBe('iterm2');
    expect(detectTerminalProtocol({ TERM_PROGRAM: 'WarpTerminal' })).toBe('iterm2');
    expect(detectTerminalProtocol({ TERM_PROGRAM: 'rio' })).toBe('iterm2');

    // 멀티플렉서 및 ttyd 상속 환경변수 차단 우선순위 검증
    expect(
      isUnsupportedMultiplexerOrWeb({
        KITTY_WINDOW_ID: '1',
        TMUX: '/tmp/tmux-1000/default,123,0',
      }),
    ).toBe(true);
    expect(
      detectTerminalProtocol({
        KITTY_WINDOW_ID: '1',
        TMUX: '/tmp/tmux-1000/default,123,0',
      }),
    ).toBe('unicode');
    expect(
      detectTerminalProtocol({
        KITTY_WINDOW_ID: '1',
        STY: '4242.pts-0.host',
      }),
    ).toBe('unicode');
    expect(
      detectTerminalProtocol({
        TERM: 'screen-256color',
        ITERM_SESSION_ID: 'w0',
      }),
    ).toBe('unicode');
    expect(
      detectTerminalProtocol({
        ITERM_SESSION_ID: 'w0',
        _: '/opt/homebrew/bin/ttyd',
      }),
    ).toBe('unicode');
    expect(
      detectTerminalProtocol({
        TERMVG_WEB: '1',
        KITTY_WINDOW_ID: '1',
      }),
    ).toBe('unicode');
    expect(
      detectTerminalProtocol({
        TERM_PROGRAM: 'ttyd',
        KITTY_WINDOW_ID: '1',
      }),
    ).toBe('unicode');

    // 기본 폴백
    expect(detectTerminalProtocol({ TERM_PROGRAM: 'vscode' })).toBe('unicode');
    expect(detectTerminalProtocol({})).toBe('unicode');
  });

  it('caps adaptive pixel resolution at 200x200 during live playback and 360x360 when paused or static (even heights)', () => {
    const liveKitty = calcPixelSize(120, 60, 'kitty', {
      paused: false,
      isStatic: false,
    });
    expect(liveKitty.w).toBeLessThanOrEqual(200);
    expect(liveKitty.h).toBeLessThanOrEqual(200);
    expect(liveKitty.h % 2).toBe(0);
    expect(liveKitty.w % 2).toBe(0);

    const pausedKitty = calcPixelSize(120, 60, 'kitty', {
      paused: true,
      isStatic: false,
    });
    expect(pausedKitty.w).toBeGreaterThan(200);
    expect(pausedKitty.w).toBeLessThanOrEqual(360);
    expect(pausedKitty.h).toBeGreaterThan(200);
    expect(pausedKitty.h).toBeLessThanOrEqual(360);
    expect(pausedKitty.h % 2).toBe(0);

    const staticIterm2 = calcPixelSize(120, 60, 'iterm2', {
      paused: false,
      isStatic: true,
    });
    expect(staticIterm2.w).toBeGreaterThan(200);
    expect(staticIterm2.w).toBeLessThanOrEqual(360);
    expect(staticIterm2.h).toBeGreaterThan(200);
    expect(staticIterm2.h).toBeLessThanOrEqual(360);
    expect(staticIterm2.h % 2).toBe(0);

    expect(resolveEffectiveRenderMode('auto', { KITTY_WINDOW_ID: '1' })).toBe('kitty');
    expect(resolveEffectiveRenderMode('auto', { TERM_PROGRAM: 'iTerm.app' })).toBe('iterm2');
    expect(resolveEffectiveRenderMode('auto', {})).toBe('quadrant');

    expect(getRenderModeOrder('kitty')).toEqual([
      'kitty',
      'sextant',
      'quadrant',
      'braille',
      'half-block',
    ]);
    expect(getRenderModeOrder('iterm2')).toEqual([
      'iterm2',
      'sextant',
      'quadrant',
      'braille',
      'half-block',
    ]);
    expect(getRenderModeOrder('unicode')).toEqual([
      'quadrant',
      'sextant',
      'braille',
      'half-block',
    ]);
  });

  it('composites BackgroundPreset RGB onto transparent pixels and builds DECSC/DECRC relative overlay safely', () => {
    const frame: PixelFrame = {
      width: 16,
      height: 16,
      data: new Uint8Array(16 * 16 * 4),
    };
    // (0,0) 투명, (8,8) 불투명 빨강
    const solidIdx = (8 * 16 + 8) * 4;
    frame.data[solidIdx] = 255;
    frame.data[solidIdx + 1] = 10;
    frame.data[solidIdx + 2] = 20;
    frame.data[solidIdx + 3] = 255;

    const scratch = { current: new Uint8Array(0) };
    const light = applyBackgroundPresetToPixels(frame, 'light', scratch);
    expect([light.data[0], light.data[1], light.data[2], light.data[3]]).toEqual([
      245, 245, 247, 255,
    ]);
    expect([
      light.data[solidIdx],
      light.data[solidIdx + 1],
      light.data[solidIdx + 2],
      light.data[solidIdx + 3],
    ]).toEqual([255, 10, 20, 255]);

    const checker = applyBackgroundPresetToPixels(frame, 'checkerboard', scratch);
    expect([checker.data[0], checker.data[1], checker.data[2]]).toEqual([42, 42, 55]);
    const tile1Idx = 8 * 4; // (x=8, y=0) -> tileX=1, tileY=0 -> odd tile
    expect([checker.data[tile1Idx], checker.data[tile1Idx + 1], checker.data[tile1Idx + 2]]).toEqual([
      30, 30, 40,
    ]);

    const overlay = buildGraphicsOverlay('PAYLOAD', {
      offsetX: 34,
      offsetY: 3,
      rootHeight: 31,
    });
    expect(overlay).toBe('\x1b7\r\x1b[28A\x1b[34CPAYLOAD\x1b8');
  });

  it('overlays Kitty graphics over an empty Ink placeholder without layout slicing and cleans up on mode switch, help, and exit', async () => {
    vi.stubEnv('KITTY_WINDOW_ID', '1');
    vi.stubEnv('TMUX', '');
    vi.stubEnv('STY', '');
    vi.stubEnv('TERM', 'xterm-kitty');

    const tmpDir = tempDirs.create();
    const svgPath = path.join(tmpDir, 'box.svg');
    fs.writeFileSync(
      svgPath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect x="4" y="4" width="32" height="32" fill="#20a0ff"/></svg>',
      'utf8',
    );

    const { inst, stdin, chunks, getOutput, getLatestChunk } = mountInteractiveMenu(
      { wasmModule: realWasmModule, initialPath: tmpDir, initialDepth: 0 },
      100,
      32,
    );
    const getLatestInkChunk = () =>
      chunks.filter((c) => c.includes('Name:') || c.includes('TermVG 단축키 도움말')).at(-1) ?? '';

    await waitMs(180);

    const kittyOutput = getOutput();
    expect(kittyOutput).toContain('kitty(M)');
    // DECSC/DECRC 상대 좌표 오버레이 내부에 Kitty APC G 시퀀스가 포함됨
    expect(kittyOutput).toMatch(/\x1b7\r(?:\x1b\[\d+A)?(?:\x1b\[\d+C)?\x1b_Ga=T,f=32,i=1,p=1/);
    expect(kittyOutput).toContain('\x1b8');
    // Ink 레이아웃 프레임 내부로 APC 시퀀스가 잘려 들어가지 않음(플레이스홀더 보호)
    const inkLayoutChunks = chunks.filter((c) => c.includes('Live Preview'));
    expect(inkLayoutChunks.length).toBeGreaterThan(0);
    for (const frameChunk of inkLayoutChunks) {
      expect(frameChunk).not.toContain('a=T,f=32');
      expect(frameChunk).not.toContain('\x1b_G');
    }
    expect(
      chunks.some((c) => c.startsWith('\x1b7\r') && c.includes('\x1b_Ga=T,f=32') && c.endsWith('\x1b8')),
    ).toBe(true);

    // 'M' 키로 sextant 모드로 전환 시 Kitty 그래픽 삭제 시퀀스 발행
    const beforeSwitchLen = getOutput().length;
    stdin.write('m');
    await waitMs(120);
    expect(getOutput().slice(beforeSwitchLen)).toContain(KITTY_CLEAR_SEQ);
    expect(getLatestChunk()).toContain('sextant(M)');

    // 다시 kitty로 순환 후 '?' 도움말 오픈 및 ESC 복귀 → 'Q' 종료 시에도 삭제 시퀀스 발행 검증
    stdin.write('m');
    await waitMs(20);
    stdin.write('m');
    await waitMs(20);
    stdin.write('m');
    await waitMs(20);
    stdin.write('m');
    await waitMs(140);
    expect(getLatestInkChunk()).toContain('kitty(M)');

    const beforeHelpLen = getOutput().length;
    stdin.write('?');
    await waitMs(80);
    expect(getOutput().slice(beforeHelpLen)).toContain(KITTY_CLEAR_SEQ);
    expect(getLatestInkChunk()).toContain('TermVG 단축키 도움말');

    stdin.write('\x1b');
    await waitMs(120);
    expect(getLatestInkChunk()).toContain('kitty(M)');

    const beforeQuitLen = getOutput().length;
    stdin.write('q');
    await inst.waitUntilExit();
    expect(getOutput().slice(beforeQuitLen)).toContain(KITTY_CLEAR_SEQ);
  });

  it('renders standalone LottiePlayer in iterm2 mode with OSC 1337 overlay without Ink text corruption', async () => {
    const tmpDir = tempDirs.create('termvg-iterm2-');
    const svgPath = path.join(tmpDir, 'circle.svg');
    fs.writeFileSync(
      svgPath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="12" fill="#ff3366"/></svg>',
      'utf8',
    );

    const onComplete = vi.fn();
    const { inst, getOutput } = renderInk(
      React.createElement(LottiePlayer, {
        wasmModule: realWasmModule,
        filePath: svgPath,
        width: 40,
        height: 20,
        renderMode: 'iterm2',
        backgroundPreset: 'dark',
        loop: false,
        onComplete,
      }),
      80,
      24,
    );

    await waitMs(160);
    const out = getOutput();
    expect(out).toMatch(/\x1b7\r.*\x1b\]1337;File=inline=1;size=\d+;width=40;height=20;preserveAspectRatio=1:/);
    expect(out).toContain('\x07\x1b8');
    expect(onComplete).toHaveBeenCalledTimes(1);

    inst.unmount();
  });
});
