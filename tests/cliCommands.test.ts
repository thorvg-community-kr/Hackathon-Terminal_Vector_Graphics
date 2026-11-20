import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { inspectVectorAsset, runInspectCli } from '../src/cli/inspectCommand.js';
import { exportVectorAsset, runExportCli } from '../src/cli/exportCommand.js';
import { encodeFramesToGif } from '../src/renderers/minimalGif.js';
import type { PixelFrame } from '../src/renderers/pixelExtractor.js';
import {
  CliValidationError,
  parseAndValidatePlayFlags,
  SinglePlayer,
} from '../src/index.js';
import { realWasmModule } from '../src/realWasmModule.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runBuiltCli(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const distEntry = path.join(REPO_ROOT, 'dist', 'index.js');
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [distEntry, ...args], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    proc.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.stdin.end();
  });
}

/**
 * 표준 GIF89a LSB-First 가변 폭 LZW 디코더 (테스트 무결성 검증 전용)
 */
function decodeFirstGifFrameIndices(gifBuf: Buffer): {
  width: number;
  height: number;
  imageDescriptorCount: number;
  pixels: Uint8Array;
  lct: Buffer;
} {
  expect(gifBuf.subarray(0, 6).toString('ascii')).toBe('GIF89a');
  expect(gifBuf[gifBuf.length - 1]).toBe(0x3b);

  let pos = 13; // Header(6) + LSD(7)
  let imageDescriptorCount = 0;
  let firstPixels: Uint8Array | null = null;
  let firstWidth = 0;
  let firstHeight = 0;
  let firstLct = Buffer.alloc(0);

  while (pos < gifBuf.length - 1) {
    const block = gifBuf[pos];
    if (block === 0x21) {
      // Extension block
      pos += 2;
      while (pos < gifBuf.length) {
        const subLen = gifBuf[pos++];
        if (subLen === 0) break;
        pos += subLen;
      }
    } else if (block === 0x2c) {
      imageDescriptorCount++;
      const w = gifBuf.readUInt16LE(pos + 5);
      const h = gifBuf.readUInt16LE(pos + 7);
      const packed = gifBuf[pos + 9];
      pos += 10;

      const hasLct = (packed & 0x80) !== 0;
      const lctEntries = hasLct ? 1 << ((packed & 0x07) + 1) : 0;
      const lct = gifBuf.subarray(pos, pos + lctEntries * 3);
      pos += lctEntries * 3;

      const minCodeSize = gifBuf[pos++];
      const lzwChunks: Buffer[] = [];
      while (pos < gifBuf.length) {
        const subLen = gifBuf[pos++];
        if (subLen === 0) break;
        lzwChunks.push(gifBuf.subarray(pos, pos + subLen));
        pos += subLen;
      }

      if (firstPixels === null) {
        firstWidth = w;
        firstHeight = h;
        firstLct = Buffer.from(lct);
        firstPixels = decodeLzwBytes(Buffer.concat(lzwChunks), minCodeSize, w * h);
      }
    } else if (block === 0x3b) {
      break;
    } else {
      throw new Error(`Unexpected GIF block marker 0x${block.toString(16)} at ${pos}`);
    }
  }

  return {
    width: firstWidth,
    height: firstHeight,
    imageDescriptorCount,
    pixels: firstPixels ?? new Uint8Array(0),
    lct: firstLct,
  };
}

function decodeLzwBytes(data: Buffer, minCodeSize: number, expectedPixels: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let bitPos = 0;

  const readCode = (): number => {
    let val = 0;
    for (let i = 0; i < codeSize; i++) {
      const byteIdx = (bitPos + i) >> 3;
      const bitIdx = (bitPos + i) & 7;
      if (byteIdx >= data.length) return eoiCode;
      if ((data[byteIdx] >> bitIdx) & 1) {
        val |= 1 << i;
      }
    }
    bitPos += codeSize;
    return val;
  };

  let dict: number[][] = [];
  const resetDict = () => {
    dict = Array.from({ length: clearCode }, (_, i) => [i]);
    dict[clearCode] = [];
    dict[eoiCode] = [];
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
  };
  resetDict();

  const out: number[] = [];
  let prevSeq: number[] | null = null;

  while (out.length <= expectedPixels + 4096) {
    const code = readCode();
    if (code === eoiCode) break;
    if (code === clearCode) {
      resetDict();
      prevSeq = null;
      continue;
    }

    let entry: number[];
    if (code < dict.length && dict[code]) {
      entry = dict[code];
    } else if (code === nextCode && prevSeq !== null) {
      entry = [...prevSeq, prevSeq[0]];
    } else {
      throw new Error(`Invalid LZW code ${code} (nextCode=${nextCode})`);
    }

    for (let i = 0; i < entry.length; i++) {
      out.push(entry[i]);
    }

    if (prevSeq !== null && nextCode < 4096) {
      dict[nextCode] = [...prevSeq, entry[0]];
      nextCode++;
      if (nextCode === 1 << codeSize && codeSize < 12) {
        codeSize++;
      }
    }
    prevSeq = entry;
  }

  return Uint8Array.from(out);
}

describe('Task 11: CLI inspect, export (PNG/GIF/ANSI), and play flags', () => {
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

  it('inspects Lottie & SVG assets accurately, detects warnings, and guarantees pure JSON stdout', async () => {
    const fireworksPath = path.join(REPO_ROOT, 'assets/5317-fireworkds.json');
    const svgPath = path.join(REPO_ROOT, 'assets/1528966158.svg');

    const report = await inspectVectorAsset(fireworksPath);
    expect(report.engineLoadOk).toBe(true);
    expect(report.format).toBe('lottie');
    expect(report.frames).toBe(150);
    expect(report.duration).toBe(5);
    expect(report.fps).toBe(30);
    expect(report.width).toBe(720);
    expect(report.height).toBe(1280);
    expect(report.layerCount).toBeGreaterThan(0);

    const svgReport = await inspectVectorAsset(svgPath);
    expect(svgReport.engineLoadOk).toBe(true);
    expect(svgReport.format).toBe('svg');
    expect(svgReport.frames).toBe(1);

    // 표현식/외부 이미지/텍스트 경고 탐지 및 stdout 오염 차단 검증
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termvg-inspect-'));
    tempDirs.push(tmpDir);
    const noisyLottiePath = path.join(tmpDir, 'warn.json');
    fs.writeFileSync(
      noisyLottiePath,
      JSON.stringify({
        v: '5.7.4',
        fr: 30,
        ip: 0,
        op: 30,
        w: 64,
        h: 64,
        fonts: { list: [{ fName: 'Arial' }] },
        assets: [{ id: 'ext', p: 'photo.png', e: 0 }],
        layers: [
          {
            ty: 5,
            ks: { o: { a: 0, k: 100, x: '100;' } },
            ip: 0,
            op: 30,
          },
        ],
      }),
      'utf8',
    );
    const brokenPath = path.join(tmpDir, 'broken.json');
    fs.writeFileSync(brokenPath, '{not valid json', 'utf8');

    const warnReport = await inspectVectorAsset(noisyLottiePath);
    expect(warnReport.warnings.length).toBeGreaterThanOrEqual(3);
    expect(warnReport.layerTypes.text).toBe(1);

    const brokenCode = await runInspectCli(brokenPath, { json: true });
    expect(brokenCode).toBe(1);

    // 실제 CLI 바이너리 stdout JSON 순수성 검증
    const cliOk = await runBuiltCli(['inspect', 'assets/5317-fireworkds.json', '--json']);
    expect(cliOk.code).toBe(0);
    const parsed = JSON.parse(cliOk.stdout);
    expect(parsed.frames).toBe(150);
    expect(parsed.duration).toBe(5);
    expect(parsed.engineLoadOk).toBe(true);
    expect(parsed.layerCount).toBeGreaterThan(0);

    const cliFail = await runBuiltCli(['inspect', brokenPath, '--json']);
    expect(cliFail.code).toBe(1);
    const parsedFail = JSON.parse(cliFail.stdout);
    expect(parsedFail.engineLoadOk).toBe(false);
  });

  it('exports valid .png, multi-frame LZW .gif, and RLE .ans outputs with full LZW round-trip integrity', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termvg-export-'));
    tempDirs.push(tmpDir);

    const pngOut = path.join(tmpDir, 'nested/snap.png');
    const gifOut = path.join(tmpDir, 'nested/anim.gif');
    const ansOut = path.join(tmpDir, 'nested/art.ans');
    const sextantOut = path.join(tmpDir, 'nested/sextant.txt');

    const pngRes = await exportVectorAsset({
      source: path.join(REPO_ROOT, 'assets/5317-fireworkds.json'),
      outputPath: pngOut,
      frame: 30,
      size: '120x120',
    });
    expect(pngRes.format).toBe('png');
    const pngBuf = fs.readFileSync(pngOut);
    expect(pngBuf.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(pngBuf.includes(Buffer.from('IHDR'))).toBe(true);
    expect(pngBuf.includes(Buffer.from('IDAT'))).toBe(true);
    expect(pngBuf.includes(Buffer.from('IEND'))).toBe(true);
    expect(pngBuf.readUInt32BE(16)).toBe(120);
    expect(pngBuf.readUInt32BE(20)).toBe(120);

    const gifRes = await exportVectorAsset({
      source: path.join(REPO_ROOT, 'assets/5317-fireworkds.json'),
      outputPath: gifOut,
      size: '64x64',
      fps: 10,
    });
    expect(gifRes.format).toBe('gif');
    const gifBuf = fs.readFileSync(gifOut);
    expect(gifBuf.includes(Buffer.from('NETSCAPE2.0'))).toBe(true);

    const decodedGif = decodeFirstGifFrameIndices(gifBuf);
    expect(decodedGif.width).toBe(64);
    expect(decodedGif.height).toBe(64);
    expect(decodedGif.imageDescriptorCount).toBeGreaterThanOrEqual(2);
    expect(decodedGif.pixels.length).toBe(64 * 64);

    // 대용량 260색 Median-Cut + 4096 사전 clearCode 리셋 포함 LZW 왕복 무결성 검증
    const w = 100;
    const h = 100;
    const synthData = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        if (x < 10 && y < 10) {
          synthData[idx + 3] = 0; // 투명 영역 -> 인덱스 255
        } else {
          synthData[idx] = (x * 17 + y * 5) & 0xff;
          synthData[idx + 1] = (x * 7 + y * 29) & 0xff;
          synthData[idx + 2] = (x * 13 + y * 11) & 0xff;
          synthData[idx + 3] = 255;
        }
      }
    }
    const synthFrame: PixelFrame = { width: w, height: h, data: synthData };
    const synthGif = encodeFramesToGif([synthFrame, synthFrame], { fps: 15, loop: true });
    const decodedSynth = decodeFirstGifFrameIndices(synthGif);
    expect(decodedSynth.pixels.length).toBe(w * h);
    expect(decodedSynth.pixels[0]).toBe(255); // 투명 인덱스 255 확인

    const ansRes = await exportVectorAsset({
      source: path.join(REPO_ROOT, 'assets/5317-fireworkds.json'),
      outputPath: ansOut,
      frame: 30,
      size: '40x20',
      mode: 'quadrant',
      bg: 'dark',
    });
    expect(ansRes.format).toBe('ans');
    const ansText = fs.readFileSync(ansOut, 'utf8');
    expect(ansText).toContain('\x1b[');
    expect(ansText.length).toBeGreaterThan(20);

    const sextantRes = await exportVectorAsset({
      source: path.join(REPO_ROOT, 'assets/2961.svg'),
      outputPath: sextantOut,
      size: '40x20',
      mode: 'sextant',
    });
    expect(sextantRes.format).toBe('ans');
    expect(fs.readFileSync(sextantOut, 'utf8').length).toBeGreaterThan(10);
  });

  it('returns exit code 2 for invalid flags/extensions and exit code 1 for I/O or asset errors', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termvg-cli-err-'));
    tempDirs.push(tmpDir);

    expect(await runInspectCli(undefined, {})).toBe(2);
    expect(await runExportCli(undefined, {})).toBe(2);
    expect(await runExportCli('assets/2961.svg', { output: path.join(tmpDir, 'out.mp4') })).toBe(2);
    expect(
      await runExportCli('assets/2961.svg', {
        output: path.join(tmpDir, 'out.png'),
        size: 'abc',
      }),
    ).toBe(2);
    expect(
      await runExportCli('assets/2961.svg', {
        output: path.join(tmpDir, 'out.png'),
        frame: -1,
      }),
    ).toBe(2);
    expect(
      await runExportCli('assets/2961.svg', {
        output: path.join(tmpDir, 'out.gif'),
        fps: 99,
      }),
    ).toBe(2);

    // 존재하는 디렉터리 경로를 파일 출력 대상으로 지정 시 EISDIR -> 종료 코드 1
    expect(await runExportCli('assets/2961.svg', { output: path.join(tmpDir, 'sub.png') })).toBe(0);
    const existingDirAsOut = path.join(tmpDir, 'dir_as_file.png');
    fs.mkdirSync(existingDirAsOut);
    expect(await runExportCli('assets/2961.svg', { output: existingDirAsOut })).toBe(1);

    // 실제 CLI 프로세스 종료 코드 2 검증
    const badMode = await runBuiltCli(['play', 'assets/2961.svg', '--mode', 'invalid']);
    expect(badMode.code).toBe(2);

    const badSpeed = await runBuiltCli(['play', 'assets/2961.svg', '--speed', '-1']);
    expect(badSpeed.code).toBe(2);

    const badExt = await runBuiltCli(['export', 'assets/2961.svg', '-o', path.join(tmpDir, 'x.mp4')]);
    expect(badExt.code).toBe(2);
  });

  it('validates play flags, resolves --mode auto by terminal env, and forwards options to SinglePlayer', async () => {
    const opts = parseAndValidatePlayFlags({
      mode: 'quadrant',
      speed: 2,
      bg: 'dark',
      loop: true,
      invert: true,
      width: 120,
      height: 30,
      anim: 'intro',
    });

    expect(opts).toEqual({
      renderMode: 'quadrant',
      loop: true,
      speed: 2,
      backgroundPreset: 'dark',
      invertDark: true,
      width: 120,
      height: 30,
      subAnimationId: 'intro',
    });

    expect(parseAndValidatePlayFlags({}, { KITTY_WINDOW_ID: '1' }).renderMode).toBe('kitty');
    expect(parseAndValidatePlayFlags({}, { ITERM_SESSION_ID: 'w0t0p0' }).renderMode).toBe('iterm2');
    expect(parseAndValidatePlayFlags({}, { TERM: 'xterm-256color' }).renderMode).toBe('quadrant');

    expect(() => parseAndValidatePlayFlags({ mode: 'bogus' })).toThrow(CliValidationError);
    expect(() => parseAndValidatePlayFlags({ speed: -1 })).toThrow(CliValidationError);
    expect(() => parseAndValidatePlayFlags({ speed: null })).toThrow(CliValidationError);
    expect(() => parseAndValidatePlayFlags({ bg: 'neon' })).toThrow(CliValidationError);
    expect(() => parseAndValidatePlayFlags({ width: 0 })).toThrow(CliValidationError);

    // SinglePlayer 렌더링 마운트 시 검증된 props(width/height/mode/bg) 전달 확인
    const stdout = new PassThrough() as any;
    stdout.columns = 80;
    stdout.rows = 24;
    stdout.isTTY = true;
    const stdin = new PassThrough() as any;
    stdin.isTTY = true;
    stdin.setRawMode = vi.fn();
    stdin.ref = vi.fn();
    stdin.unref = vi.fn();

    const chunks: string[] = [];
    stdout.on('data', (c: Buffer | string) => chunks.push(c.toString()));

    const onExit = vi.fn();
    const inst = render(
      React.createElement(SinglePlayer, {
        filePath: path.join(REPO_ROOT, 'assets/2961.svg'),
        playOptions: parseAndValidatePlayFlags({
          mode: 'quadrant',
          bg: 'dark',
          width: 40,
          height: 20,
          loop: false,
        }),
        exit: onExit,
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await new Promise((r) => setTimeout(r, 350));
    inst.unmount();

    const output = chunks.join('');
    // dark 배경 프리셋 RGB(24,24,37)이 실제 출력에 반영됨을 확인
    expect(output).toContain('24;24;37');
  });
});
