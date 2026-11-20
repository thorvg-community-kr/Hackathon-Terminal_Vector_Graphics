import { afterAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realWasmModule } from '../src/realWasmModule.js';
import {
  postProcessAnsiFrame,
  type BackgroundPreset,
} from '../src/utils/ansiPostProcessor.js';
import { remapPureBlackForeground } from '../src/utils/vectorPreprocessor.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const QUADRANT_MASKS: Record<string, number> = {
  ' ': 0b0000,
  '▘': 0b0001,
  '▝': 0b0010,
  '▀': 0b0011,
  '▖': 0b0100,
  '▌': 0b0101,
  '▞': 0b0110,
  '▛': 0b0111,
  '▗': 0b1000,
  '▚': 0b1001,
  '▐': 0b1010,
  '▜': 0b1011,
  '▄': 0b1100,
  '▙': 0b1101,
  '▟': 0b1110,
  '█': 0b1111,
};

interface SimulatedCell {
  subpixels: [number, number, number, number] | null;
  glyph: string;
  fg: number | null;
  bg: number | null;
}

/**
 * 가상 터미널 셀 시뮬레이터:
 * ANSI SGR 문자열을 셀 단위 (col, row)로 파싱하여
 * 블록 문자는 2x2 서브픽셀 RGB 4-튜플로, 점자 등 일반 문자는 (glyph, fg, bg)로 정규화한다.
 */
function simulateTerminalGrid(ansi: string, defaultBg: number): SimulatedCell[][] {
  const rows: SimulatedCell[][] = [[]];
  let fg = -1;
  let bg = -1;
  let i = 0;

  while (i < ansi.length) {
    const ch = ansi.charCodeAt(i);
    if (ch === 0x1b && ansi[i + 1] === '[') {
      const mIdx = ansi.indexOf('m', i + 2);
      if (mIdx !== -1) {
        const body = ansi.slice(i + 2, mIdx);
        if (body === '' || body === '0') {
          fg = -1;
          bg = -1;
        } else {
          const parts = body.split(';').map(Number);
          for (let p = 0; p < parts.length; p++) {
            const code = parts[p];
            if (code === 0) {
              fg = -1;
              bg = -1;
            } else if (code === 39) {
              fg = -1;
            } else if (code === 49) {
              bg = -1;
            } else if (code === 38 && parts[p + 1] === 2) {
              fg = (parts[p + 2] << 16) | (parts[p + 3] << 8) | parts[p + 4];
              p += 4;
            } else if (code === 48 && parts[p + 1] === 2) {
              bg = (parts[p + 2] << 16) | (parts[p + 3] << 8) | parts[p + 4];
              p += 4;
            }
          }
        }
        i = mIdx + 1;
        continue;
      }
    }

    if (ch === 0x0a) {
      rows.push([]);
      i++;
      continue;
    }

    let glyph: string;
    if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < ansi.length) {
      glyph = ansi.slice(i, i + 2);
      i += 2;
    } else {
      glyph = ansi[i];
      i++;
    }

    const resolvedBg = bg === -1 ? defaultBg : bg;
    const resolvedFg = fg === -1 ? 0xffffff : fg;
    const mask = QUADRANT_MASKS[glyph];

    if (mask !== undefined) {
      rows[rows.length - 1].push({
        subpixels: [
          mask & 1 ? resolvedFg : resolvedBg,
          mask & 2 ? resolvedFg : resolvedBg,
          mask & 4 ? resolvedFg : resolvedBg,
          mask & 8 ? resolvedFg : resolvedBg,
        ],
        glyph: 'block',
        fg: null,
        bg: null,
      });
    } else {
      rows[rows.length - 1].push({
        subpixels: null,
        glyph,
        fg: resolvedFg,
        bg: resolvedBg,
      });
    }
  }

  return rows;
}

describe('ansiPostProcessor', () => {
  afterAll(() => {
    realWasmModule.destroy();
  });

  it('passes through non-ANSI strings unchanged and handles truncated/non-SGR sequences safely', () => {
    expect(postProcessAnsiFrame('')).toBe('');
    expect(postProcessAnsiFrame('Loading...')).toBe('Loading...');
    expect(postProcessAnsiFrame('Failed to load file')).toBe('Failed to load file');
    expect(postProcessAnsiFrame('Loading...', { background: 'dark' })).toBe('Loading...');

    // Incomplete CSI sequence must not throw RangeError or loop infinitely
    const truncated = '\x1b[48;2;10;20;30mA\x1b[38;2;255;0';
    const outTruncated = postProcessAnsiFrame(truncated);
    expect(outTruncated).toContain('A\x1b[38;2;255;0');

    // Non-SGR CSI (\x1b[2K) and unknown SGR (\x1b[1m) are preserved without corrupting columns
    const withNonSgr = '\x1b[2K\x1b[1m\x1b[48;2;0;0;0m\x1b[38;2;0;0;0m▄\x1b[0m';
    const outNonSgr = postProcessAnsiFrame(withNonSgr, { background: 'transparent' });
    expect(outNonSgr).toContain('\x1b[2K');
    expect(outNonSgr).toContain('\x1b[1m');
    expect(outNonSgr).toContain(' ');
    expect(outNonSgr.endsWith('\x1b[0m')).toBe(true);
  });

  it('converts chroma-key margins and flips half-block/quadrant complements in transparent mode', () => {
    // 1. Both top & bottom chroma-key 0;0;0 -> space with no ▄ artifact and no 48;2;0;0;0
    const marginRaw = '\x1b[48;2;0;0;0m\x1b[38;2;0;0;0m▄\x1b[0m';
    const marginOut = postProcessAnsiFrame(marginRaw, { background: 'transparent' });
    expect(marginOut).toBe(' \x1b[0m');
    expect(marginOut).not.toContain('▄');
    expect(marginOut).not.toContain('48;2;0;0;0');

    // 2. Top red (inBg) + bottom chroma-key (inFg) with ▄ -> flipped to ▀ with red fg and \x1b[49m / default bg
    const halfRaw =
      '\x1b[48;2;255;0;0m\x1b[38;2;0;0;0m▄' +
      '\x1b[48;2;0;0;0m\x1b[38;2;0;0;0m▄\x1b[0m';
    const halfOut = postProcessAnsiFrame(halfRaw, { background: 'transparent' });
    expect(halfOut).toContain('\x1b[38;2;255;0;0m▀');
    expect(halfOut).not.toContain('48;2;0;0;0');
    expect(halfOut).not.toContain('38;2;0;0;0');
    expect(halfOut.endsWith('\x1b[0m')).toBe(true);

    // 3. Quadrant complement flip (▘ -> ▟) and explicit \x1b[49m transition after colored background
    const quadRaw =
      '\x1b[48;2;10;20;30m\x1b[38;2;40;50;60m▘' +
      '\x1b[48;2;70;80;90m\x1b[38;2;0;0;0m▘\x1b[0m';
    const quadOut = postProcessAnsiFrame(quadRaw, { background: 'transparent' });
    expect(quadOut).toContain('\x1b[49m');
    expect(quadOut).toContain('\x1b[38;2;70;80;90m▟');
    expect(quadOut).toMatch(/\x1b\[0m$/);

    // 4. Surrogate-pair glyphs (e.g. Sextant U+1FB00) advance column by 1 without splitting UTF-16 units
    const sextantPair = '\uD83E\uDF00'; // U+1FB00
    const checkerOut = postProcessAnsiFrame(
      `\x1b[48;2;0;0;0m\x1b[38;2;200;10;20m${sextantPair}\x1b[48;2;0;0;0m\x1b[38;2;200;10;20m${sextantPair}\x1b[0m`,
      { background: 'checkerboard' }
    );
    expect(checkerOut).toContain('\x1b[48;2;42;42;55m');
    expect(checkerOut).toContain('\x1b[48;2;30;30;40m');
    expect(checkerOut).toContain(sextantPair);
  });

  it('replaces both inBg and block-glyph inFg bidirectionally for dark, light, and checkerboard presets (no Black Halo)', () => {
    const boundaryHalf = '\x1b[48;2;255;0;0m\x1b[38;2;0;0;0m▄\x1b[0m';
    const boundaryQuad = '\x1b[48;2;255;0;0m\x1b[38;2;0;0;0m▘\x1b[0m';

    const darkHalf = postProcessAnsiFrame(boundaryHalf, { background: 'dark' });
    expect(darkHalf).toContain('48;2;255;0;0m');
    expect(darkHalf).toContain('38;2;24;24;37m▄');
    expect(darkHalf).not.toContain(';0;0;0m');

    const lightHalf = postProcessAnsiFrame(boundaryHalf, { background: 'light' });
    expect(lightHalf).toContain('48;2;255;0;0m');
    expect(lightHalf).toContain('38;2;245;245;247m▄');
    expect(lightHalf).not.toContain(';0;0;0m');

    const lightQuad = postProcessAnsiFrame(boundaryQuad, { background: 'light' });
    expect(lightQuad).toContain('48;2;255;0;0m');
    expect(lightQuad).toContain('38;2;245;245;247m▘');
    expect(lightQuad).not.toContain(';0;0;0m');

    // Checkerboard alternates (0,0)=even (42,42,55) and (1,0)=odd (30,30,40), row 1 flips parity
    const twoByTwo =
      '\x1b[48;2;255;0;0m\x1b[38;2;0;0;0m▄\x1b[48;2;255;0;0m\x1b[38;2;0;0;0m▘\x1b[0m\n' +
      '\x1b[48;2;0;0;0m\x1b[38;2;0;0;0m▄\x1b[48;2;255;0;0m\x1b[38;2;0;0;0m▄\x1b[0m';
    const checkerOut = postProcessAnsiFrame(twoByTwo, { background: 'checkerboard' });
    expect(checkerOut).not.toContain(';0;0;0m');
    expect(checkerOut).toContain('38;2;42;42;55m▄');
    expect(checkerOut).toContain('38;2;30;30;40m▘');
    expect(checkerOut).toContain('48;2;30;30;40m\x1b[38;2;30;30;40m▄');

    // Mode 2 (braille) compatibility: fg RLE + preset background injection
    const brailleRaw = '\x1b[38;2;120;200;255m⠿\x1b[38;2;120;200;255m⠁ \x1b[0m';
    const brailleTrans = postProcessAnsiFrame(brailleRaw, { background: 'transparent' });
    expect(brailleTrans).toBe('\x1b[38;2;120;200;255m⠿⠁ \x1b[0m');

    const brailleDark = postProcessAnsiFrame(brailleRaw, { background: 'dark' });
    expect(brailleDark).toBe('\x1b[48;2;24;24;37m\x1b[38;2;120;200;255m⠿⠁ \x1b[0m');
  });

  it('maintains 100% terminal cell visual equivalence between RLE and unoptimized output across all WASM modes & assets', async () => {
    await realWasmModule.init();
    realWasmModule.setSize(80, 40);

    const assets = [
      { file: 'assets/5317-fireworkds.json', frame: 30 },
      { file: 'assets/2961.svg', frame: 0 },
    ];
    const presets: BackgroundPreset[] = ['transparent', 'dark', 'light', 'checkerboard'];

    for (const { file, frame } of assets) {
      expect(realWasmModule.load(path.join(REPO_ROOT, file))).toBe(true);

      for (const mode of [0, 1, 2]) {
        const raw = realWasmModule.renderToString(frame, mode, false);
        expect(raw.length).toBeGreaterThan(0);

        for (const preset of presets) {
          const unoptimized = postProcessAnsiFrame(raw, {
            background: preset,
            optimizeRle: false,
          });
          const optimized = postProcessAnsiFrame(raw, {
            background: preset,
            optimizeRle: true,
          });

          const defaultBg = preset === 'transparent' ? 0x000000 : -2;
          expect(simulateTerminalGrid(optimized, defaultBg)).toEqual(
            simulateTerminalGrid(unoptimized, defaultBg)
          );
          if (preset === 'transparent') {
            expect(simulateTerminalGrid(optimized, 0x000000)).toEqual(
              simulateTerminalGrid(raw, 0x000000)
            );
          } else {
            expect(optimized).not.toContain(';0;0;0m');
          }
        }
      }
    }
  });

  it('reduces ANSI byte size by >= 50% on real WASM assets and meets < 2ms frame budget at 160x80', async () => {
    await realWasmModule.init();

    const targets = [
      { file: 'assets/5317-fireworkds.json', frame: 30 },
      { file: 'assets/2961.svg', frame: 0 },
    ];

    for (const { file, frame } of targets) {
      realWasmModule.setSize(160, 80);
      expect(realWasmModule.load(path.join(REPO_ROOT, file))).toBe(true);

      for (const mode of [0, 1]) {
        const raw = realWasmModule.renderToString(frame, mode, false);
        const rawBytes = Buffer.byteLength(raw, 'utf8');

        const transparentOut = postProcessAnsiFrame(raw, { background: 'transparent' });
        const darkOut = postProcessAnsiFrame(raw, { background: 'dark' });

        expect(Buffer.byteLength(transparentOut, 'utf8')).toBeLessThanOrEqual(rawBytes * 0.5);
        expect(Buffer.byteLength(darkOut, 'utf8')).toBeLessThanOrEqual(rawBytes * 0.5);
      }
    }

    // 160x80 terminal cell benchmark (160x160 pixels in half-block Mode 0)
    realWasmModule.setSize(160, 160);
    expect(realWasmModule.load(path.join(REPO_ROOT, 'assets/5317-fireworkds.json'))).toBe(true);
    const largeRaw = realWasmModule.renderToString(30, 0, false);

    // Warmup JIT
    for (let w = 0; w < 10; w++) {
      postProcessAnsiFrame(largeRaw, { background: 'transparent' });
    }

    const iterations = 50;
    const t0 = performance.now();
    for (let r = 0; r < iterations; r++) {
      postProcessAnsiFrame(largeRaw, { background: 'transparent' });
    }
    const avgMs = (performance.now() - t0) / iterations;
    expect(avgMs).toBeLessThan(2.0);
  });

  it('remaps pure black foreground colors safely in SVG and Lottie shapes without touching transforms', () => {
    const svg = '<svg><path fill="#000" stroke="#000000" style="stop-color: rgb(0, 0, 0)" id="x000"/></svg>';
    const patchedSvg = remapPureBlackForeground(svg, 'svg');
    expect(patchedSvg).toContain('fill="#020202"');
    expect(patchedSvg).toContain('stroke="#020202"');
    expect(patchedSvg).toContain('rgb(2, 2, 2)');
    expect(patchedSvg).toContain('id="x000"');

    const lottie = JSON.stringify({
      layers: [
        {
          ks: { p: { a: 0, k: [0, 0, 0] } },
          shapes: [
            { ty: 'fl', c: { a: 0, k: [0, 0, 0, 1] } },
            { ty: 'st', c: { a: 1, k: [{ t: 0, s: [0, 0, 0, 1] }] } },
          ],
        },
      ],
    });
    const patchedLottie = JSON.parse(remapPureBlackForeground(lottie, 'lottie'));
    expect(patchedLottie.layers[0].ks.p.k).toEqual([0, 0, 0]); // Transform untouched
    expect(patchedLottie.layers[0].shapes[0].c.k).toEqual([0.00784, 0.00784, 0.00784, 1]);
    expect(patchedLottie.layers[0].shapes[1].c.k[0].s).toEqual([0.00784, 0.00784, 0.00784, 1]);
    expect(remapPureBlackForeground('{broken-json', 'lottie')).toBe('{broken-json');
  });

  it('handles long chroma-key cell runs (>256) and color-to-chroma transitions identically', () => {
    const chromaHalf = '\x1b[48;2;0;0;0m\x1b[38;2;0;0;0m▄';
    const chromaSpace = '\x1b[48;2;0;0;0m\x1b[38;2;0;0;0m ';
    const colored = '\x1b[48;2;12;34;56m\x1b[38;2;78;90;12m▀';
    const input =
      colored +
      chromaHalf.repeat(300) +
      chromaSpace.repeat(10) +
      colored +
      chromaHalf.repeat(5);

    const optimized = postProcessAnsiFrame(input, { background: 'transparent', optimizeRle: true });
    const unoptimized = postProcessAnsiFrame(input, { background: 'transparent', optimizeRle: false });

    expect(optimized).toContain('\x1b[49m' + ' '.repeat(310));
    expect(optimized.endsWith('\x1b[49m' + ' '.repeat(5) + '\x1b[0m')).toBe(true);
    expect(simulateTerminalGrid(optimized, 0x000000)).toEqual(
      simulateTerminalGrid(unoptimized, 0x000000)
    );
    expect(simulateTerminalGrid(optimized, 0x000000)).toEqual(
      simulateTerminalGrid(input, 0x000000)
    );
  });
});
