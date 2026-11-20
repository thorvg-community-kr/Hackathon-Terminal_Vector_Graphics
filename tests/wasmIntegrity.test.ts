import { afterAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realWasmModule } from '../src/realWasmModule.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXPECTED_ARTIFACTS = [
  {
    relPath: 'src/termvg.wasm',
    size: 729786,
    sha256: 'b8d8d2daa5757294fdca35dd3ba4d84211dd46f48814c343129467fb76906797',
  },
  {
    relPath: 'src/termvg.cjs',
    size: 121650,
    sha256: '209bbc4cdd1591c8758a5666c2f2d1880910173eb2c2ebbc0784ff82282cb624',
  },
] as const;

describe('Pre-built WASM integrity & smoke tests', () => {
  afterAll(() => {
    realWasmModule.destroy();
  });

  it('matches immutable byte size and SHA-256 digests for pre-built WASM artifacts', () => {
    for (const artifact of EXPECTED_ARTIFACTS) {
      const fullPath = path.join(REPO_ROOT, artifact.relPath);
      expect(fs.existsSync(fullPath)).toBe(true);
      const buf = fs.readFileSync(fullPath);
      const digest = crypto.createHash('sha256').update(buf).digest('hex');
      expect(buf.length).toBe(artifact.size);
      expect(digest).toBe(artifact.sha256);
    }

    expect(fs.existsSync(path.join(REPO_ROOT, 'cpp_src/termvg_wasm.cpp'))).toBe(true);
  });

  it('initializes WASM engine and renders SVG (assets/2961.svg) across modes 0, 1, 2', async () => {
    await realWasmModule.init();
    realWasmModule.setSize(80, 80);

    const loaded = realWasmModule.load(path.join(REPO_ROOT, 'assets/2961.svg'));
    expect(loaded).toBe(true);

    for (const mode of [0, 1, 2]) {
      const rendered = realWasmModule.renderToString(0, mode, false);
      expect(typeof rendered).toBe('string');
      expect(rendered.trim().length).toBeGreaterThan(0);
    }
  });

  it('loads Lottie JSON (assets/5317-fireworkds.json) and renders frame 30', async () => {
    await realWasmModule.init();
    realWasmModule.setSize(80, 80);

    const loaded = realWasmModule.load(path.join(REPO_ROOT, 'assets/5317-fireworkds.json'));
    expect(loaded).toBe(true);
    expect(realWasmModule.getTotalFrames()).toBe(150);
    expect(realWasmModule.getDuration()).toBe(5);

    for (const mode of [0, 1, 2]) {
      const frame = realWasmModule.renderToString(30, mode, false);
      expect(typeof frame).toBe('string');
      expect(frame.trim().length).toBeGreaterThan(0);
    }
  });

  it('returns false without crashing on missing or corrupted vector files', async () => {
    await realWasmModule.init();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termvg-wasm-corrupt-'));

    try {
      expect(realWasmModule.load(path.join(REPO_ROOT, 'assets/__nonexistent__.svg'))).toBe(false);

      const brokenJson = path.join(tmpDir, 'broken.json');
      const brokenSvg = path.join(tmpDir, 'broken.svg');
      fs.writeFileSync(brokenJson, '{not-valid-lottie', 'utf8');
      fs.writeFileSync(brokenSvg, 'not-an-svg', 'utf8');

      expect(realWasmModule.load(brokenJson)).toBe(false);
      expect(realWasmModule.load(brokenSvg)).toBe(false);
    } finally {
      errSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('supports destroy() followed by clean re-initialization and rendering', async () => {
    await realWasmModule.init();
    realWasmModule.destroy();

    await realWasmModule.init();
    realWasmModule.setSize(80, 80);
    expect(realWasmModule.load(path.join(REPO_ROOT, 'assets/2961.svg'))).toBe(true);
    expect(realWasmModule.renderToString(0, 0, false).trim().length).toBeGreaterThan(0);
  });
});
