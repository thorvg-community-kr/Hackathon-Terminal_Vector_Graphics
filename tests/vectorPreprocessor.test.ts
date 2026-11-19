import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realWasmModule } from '../src/realWasmModule.js';
import {
  detectVectorFormat,
  getModePixelAspect,
  preprocessVectorData,
} from '../src/utils/vectorPreprocessor.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function measureForegroundBoundingBox(rawAnsi: string): {
  cols: number;
  rows: number;
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
} {
  let fg = -1;
  let bg = -1;
  let col = 0;
  let row = 0;
  let minCol = Infinity;
  let maxCol = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  let i = 0;

  while (i < rawAnsi.length) {
    const code = rawAnsi.charCodeAt(i);
    if (code === 0x1b && rawAnsi[i + 1] === '[') {
      const mIdx = rawAnsi.indexOf('m', i + 2);
      if (mIdx !== -1) {
        const body = rawAnsi.slice(i + 2, mIdx);
        if (body === '' || body === '0') {
          fg = -1;
          bg = -1;
        } else {
          const parts = body.split(';').map(Number);
          for (let p = 0; p < parts.length; p++) {
            const c = parts[p];
            if (c === 0) {
              fg = -1;
              bg = -1;
            } else if (c === 39) {
              fg = -1;
            } else if (c === 49) {
              bg = -1;
            } else if (c === 38 && parts[p + 1] === 2) {
              fg = (parts[p + 2] << 16) | (parts[p + 3] << 8) | parts[p + 4];
              p += 4;
            } else if (c === 48 && parts[p + 1] === 2) {
              bg = (parts[p + 2] << 16) | (parts[p + 3] << 8) | parts[p + 4];
              p += 4;
            }
          }
        }
        i = mIdx + 1;
        continue;
      }
    }

    if (code === 0x0a) {
      row++;
      col = 0;
      i++;
      continue;
    }

    const ch = rawAnsi[i];
    i++;

    const hasVisibleBg = bg !== -1 && bg !== 0x000000;
    const hasVisibleFg = ch !== ' ' && fg !== 0x000000;
    if (hasVisibleBg || hasVisibleFg) {
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
    }

    col++;
  }

  return {
    cols: maxCol >= minCol ? maxCol - minCol + 1 : 0,
    rows: maxRow >= minRow ? maxRow - minRow + 1 : 0,
    minCol,
    maxCol,
    minRow,
    maxRow,
  };
}

const SQUARE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <rect x="10" y="10" width="80" height="80" fill="#ff3333" stroke="#ff3333" stroke-width="2"/>
</svg>`;

const CIRCLE_LOTTIE = JSON.stringify({
  v: '5.7.4',
  fr: 30,
  ip: 0,
  op: 60,
  w: 100,
  h: 100,
  nm: 'CircleFixture',
  ddd: 0,
  assets: [],
  layers: [
    {
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: 'CircleShape',
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [50, 50, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: { a: 0, k: [100, 100, 100] },
      },
      ao: 0,
      shapes: [
        {
          ty: 'gr',
          it: [
            { ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [80, 80] } },
            { ty: 'fl', c: { a: 0, k: [1, 0.2, 0.2, 1] }, o: { a: 0, k: 100 } },
            { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
          ],
        },
      ],
      ip: 0,
      op: 60,
      st: 0,
    },
  ],
});

describe('vectorPreprocessor', () => {
  afterAll(() => {
    realWasmModule.destroy();
  });

  it('returns correct mode pixel aspects and detects SVG/Lottie formats', () => {
    expect(getModePixelAspect('quadrant')).toEqual({ pixelAspectX: 2.0, pixelAspectY: 1.0 });
    expect(getModePixelAspect('sextant').pixelAspectX).toBeCloseTo(4 / 3, 6);
    expect(getModePixelAspect('half-block')).toEqual({ pixelAspectX: 1.0, pixelAspectY: 1.0 });
    expect(getModePixelAspect('braille')).toEqual({ pixelAspectX: 1.0, pixelAspectY: 1.0 });

    expect(detectVectorFormat('/tmp/icon.SVG')).toBe('svg');
    expect(detectVectorFormat('/tmp/anim.json')).toBe('lottie');
    expect(detectVectorFormat('stdin', '  <svg></svg>')).toBe('svg');
    expect(detectVectorFormat('stdin', ' {"v":"5.7.4"}')).toBe('lottie');
  });

  it('restores 1:1 physical terminal aspect ratio across half-block, quadrant, and braille for square SVG and circle Lottie', async () => {
    await realWasmModule.init();

    const fixtures: Array<{ name: string; raw: string; format: 'svg' | 'lottie' }> = [
      { name: 'square SVG', raw: SQUARE_SVG, format: 'svg' },
      { name: 'circle Lottie', raw: CIRCLE_LOTTIE, format: 'lottie' },
    ];

    const modes = [
      { name: 'half-block', modeInt: 0, w: 80, h: 80 },
      { name: 'quadrant', modeInt: 1, w: 160, h: 80 },
      { name: 'braille', modeInt: 2, w: 160, h: 160 },
    ] as const;

    // Confirm uncompensated quadrant reproduces the 2x vertical stretch (cols ~ 32 vs rows*2 ~ 64)
    realWasmModule.setSize(160, 80);
    expect(realWasmModule.loadContent(SQUARE_SVG)).toBe(true);
    const uncompensatedBox = measureForegroundBoundingBox(realWasmModule.renderToString(0, 1, false));
    expect(Math.abs(uncompensatedBox.cols - uncompensatedBox.rows * 2)).toBeGreaterThanOrEqual(20);

    for (const fixture of fixtures) {
      for (const m of modes) {
        realWasmModule.setSize(m.w, m.h);
        const aspect = getModePixelAspect(m.name);
        const processed = preprocessVectorData(fixture.raw, fixture.format, aspect);
        expect(realWasmModule.loadContent(processed)).toBe(true);

        const rendered = realWasmModule.renderToString(0, m.modeInt, false);
        const box = measureForegroundBoundingBox(rendered);
        expect(box.cols).toBeGreaterThan(20);
        expect(box.rows).toBeGreaterThan(10);
        // Physical terminal cell aspect is 1:2 -> cols === rows * 2 within +/- 2 cols tolerance
        expect(Math.abs(box.cols - box.rows * 2)).toBeLessThanOrEqual(2);
      }
    }
  });

  it('loads all 6 existing repository assets with pixelAspectX=2.0 while preserving frame count and duration', async () => {
    await realWasmModule.init();
    realWasmModule.setSize(160, 80);

    const sampleFiles = [
      'assets/1528966158.svg',
      'assets/2961.svg',
      'assets/421553147-22eaf24a-a9a7-4a35-abac-df5a54ac5b19.svg',
      'assets/43391.json',
      'assets/5317-fireworkds.json',
      'assets/week02-example01.json',
    ];

    for (const relPath of sampleFiles) {
      const fullPath = path.join(REPO_ROOT, relPath);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const format = detectVectorFormat(fullPath, raw);

      expect(realWasmModule.load(fullPath)).toBe(true);
      const origFrames = realWasmModule.getTotalFrames();
      const origDuration = realWasmModule.getDuration();

      expect(realWasmModule.load(fullPath, { pixelAspectX: 2.0, pixelAspectY: 1.0 })).toBe(true);
      expect(realWasmModule.getTotalFrames()).toBe(origFrames);
      expect(realWasmModule.getDuration()).toBeCloseTo(origDuration, 5);

      const frame = realWasmModule.renderToString(0, 1, false);
      expect(frame.trim().length).toBeGreaterThan(0);

      // Verify raw content on disk was never modified
      expect(fs.readFileSync(fullPath, 'utf8')).toBe(raw);
      expect(preprocessVectorData(raw, format, { pixelAspectX: 1, pixelAspectY: 1 })).toBe(raw);
    }
  });

  it('handles DOCTYPE/XML prolog, stroke-width preservation, Precomp ID collisions, and malformed fallbacks safely', async () => {
    await realWasmModule.init();
    realWasmModule.setSize(160, 80);

    // 1. XML prolog + DOCTYPE SVG + stroke-width must survive cleanly
    const svgWithDoctype = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" width="100px" height="100px" stroke-width="4">
  <rect x="10" y="10" width="80" height="80" fill="#00cc88"/>
</svg>`;
    const processedSvg = preprocessVectorData(svgWithDoctype, 'svg', { pixelAspectX: 2 });
    expect(processedSvg).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(processedSvg).not.toContain('<!DOCTYPE');
    expect(processedSvg).toContain('stroke-width="4"');
    expect(processedSvg).toContain('width="200" height="100" viewBox="0 0 200 100"');
    expect(realWasmModule.loadContent(processedSvg)).toBe(true);

    // 2. Malformed/empty/self-closing/percentage-only inputs fall back to original string untouched
    const noDimsSvg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>';
    expect(preprocessVectorData(noDimsSvg, 'svg', { pixelAspectX: 2 })).toBe(noDimsSvg);

    const selfClosingSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" />';
    expect(preprocessVectorData(selfClosingSvg, 'svg', { pixelAspectX: 2 })).toBe(selfClosingSvg);

    const pctSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"></svg>';
    expect(preprocessVectorData(pctSvg, 'svg', { pixelAspectX: 2 })).toBe(pctSvg);

    expect(preprocessVectorData('{invalid', 'lottie', { pixelAspectX: 2 })).toBe('{invalid');
    const noLayersJson = JSON.stringify({ w: 100, h: 100 });
    expect(preprocessVectorData(noLayersJson, 'lottie', { pixelAspectX: 2 })).toBe(noLayersJson);

    // 3. Precomp ID collision avoidance (__termvg_root_comp__ -> __termvg_root_comp_1__)
    const baseLottie = JSON.parse(CIRCLE_LOTTIE);
    baseLottie.assets = [{ id: '__termvg_root_comp__', layers: [] }];
    const collidingRaw = JSON.stringify(baseLottie);
    const processedLottie = preprocessVectorData(collidingRaw, 'lottie', { pixelAspectX: 2 });
    const parsedOut = JSON.parse(processedLottie);
    expect(parsedOut.w).toBe(200);
    expect(parsedOut.h).toBe(100);
    expect(parsedOut.layers).toHaveLength(1);
    expect(parsedOut.layers[0].refId).toBe('__termvg_root_comp_1__');
    expect(parsedOut.assets.some((a: any) => a.id === '__termvg_root_comp_1__')).toBe(true);
    expect(realWasmModule.loadContent(processedLottie)).toBe(true);

    // 4. Identity fast-path returns exact reference without modification
    expect(preprocessVectorData(SQUARE_SVG, 'svg', { pixelAspectX: 1, pixelAspectY: 1 })).toBe(SQUARE_SVG);
    expect(preprocessVectorData(CIRCLE_LOTTIE, 'lottie')).toBe(CIRCLE_LOTTIE);
  });
});
