import fs from 'node:fs';
import path from 'node:path';
import { loadVectorAsset } from '../loaders/assetLoader.js';
import { realWasmModule } from '../realWasmModule.js';
import {
  calcPixelSize,
  clampEvenPixelSize,
  CliValidationError,
  loadVectorIntoWasm,
  renderVectorFrame,
  renderWasmPixelFrame,
  VALID_EXPORT_MODES,
  validateBgPreset,
  validateRenderMode,
} from '../renderers/headlessPipeline.js';
import { encodeFramesToGif } from '../renderers/minimalGif.js';
import { encodeRgbaToPng } from '../renderers/minimalPng.js';
import { WasmPixelExtractor, type PixelFrame } from '../renderers/pixelExtractor.js';
import type { BackgroundPreset } from '../utils/ansiPostProcessor.js';
import { getModePixelAspect } from '../utils/vectorPreprocessor.js';
import { globalWasmMutex } from '../utils/wasmMutex.js';

export type ExportAnsiMode = 'half-block' | 'quadrant' | 'sextant' | 'braille';

export interface ExportOptions {
  source: string;
  outputPath: string;
  frame?: number;
  size?: string;
  fps?: number;
  mode?: ExportAnsiMode;
  bg?: BackgroundPreset;
  invert?: boolean;
  subAnimationId?: string;
  wasmModule?: any;
}

const MAX_EXPORT_PIXEL_DIM = 2048;
const MAX_GIF_FRAMES = 300;

function parseSizeFlag(sizeStr: string): { w: number; h: number } {
  const match = sizeStr.trim().match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new CliValidationError(
      `Error: Invalid --size format "${sizeStr}". Expected <width>x<height> (e.g. 256x256 or 80x40).`,
    );
  }
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    w < 1 ||
    h < 1 ||
    w > MAX_EXPORT_PIXEL_DIM ||
    h > MAX_EXPORT_PIXEL_DIM
  ) {
    throw new CliValidationError(
      `Error: --size dimensions must be integers between 1 and ${MAX_EXPORT_PIXEL_DIM}.`,
    );
  }
  return { w, h };
}

function resolveOutputFormat(outputPath: string): 'png' | 'gif' | 'ans' {
  const ext = path.extname(outputPath).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.gif') return 'gif';
  if (ext === '.ans' || ext === '.txt') return 'ans';
  throw new CliValidationError(
    `Error: Unsupported export extension "${ext || '(none)'}". Supported formats: .png, .gif, .ans, .txt.`,
  );
}

function validateAndNormalizeExportOptions(options: ExportOptions) {
  if (!options.source || !options.source.trim()) {
    throw new CliValidationError('Error: Missing target source for export.');
  }
  if (!options.outputPath || !options.outputPath.trim()) {
    throw new CliValidationError('Error: Missing required -o / --output path.');
  }

  const format = resolveOutputFormat(options.outputPath);
  const frame = options.frame ?? 0;
  if (typeof frame !== 'number' || !Number.isInteger(frame) || frame < 0) {
    throw new CliValidationError('Error: --frame must be a non-negative integer.');
  }

  let fps: number | undefined;
  if (options.fps !== undefined) {
    if (typeof options.fps !== 'number' || !Number.isFinite(options.fps) || options.fps <= 0 || options.fps > 50) {
      throw new CliValidationError('Error: --fps must be a number in (0, 50].');
    }
    fps = options.fps;
  }

  const mode = validateRenderMode(
    options.mode ?? 'quadrant',
    VALID_EXPORT_MODES,
    'half-block, quadrant, sextant, braille',
    'export --mode',
  ) as ExportAnsiMode;
  const bg = validateBgPreset(options.bg ?? 'transparent', '--bg preset');

  const sizeInput = options.size ?? (format === 'ans' ? '80x40' : '256x256');
  if (typeof sizeInput !== 'string') {
    throw new CliValidationError('Error: --size must be a string in WxH format.');
  }
  const { w, h } = parseSizeFlag(sizeInput);

  return { format, w, h, frame, fps, mode, bg, invert: Boolean(options.invert) };
}

/**
 * SVG / Lottie / .lottie / URL / stdin 에셋을 헤드리스로 PNG, GIF89a 또는 ANSI(.ans/.txt) 파일로 추출한다.
 */
export async function exportVectorAsset(
  options: ExportOptions,
): Promise<{ bytesWritten: number; format: 'png' | 'gif' | 'ans' }> {
  const cfg = validateAndNormalizeExportOptions(options);
  const resolvedOut = path.resolve(process.cwd(), options.outputPath);

  const asset = await loadVectorAsset(options.source, options.subAnimationId);
  await fs.promises.mkdir(path.dirname(resolvedOut), { recursive: true });

  const wasm = options.wasmModule ?? realWasmModule;
  const ownsWasm = !options.wasmModule;

  return globalWasmMutex.runExclusive(async () => {
    try {
      const rawPixel =
        cfg.format === 'ans' ? calcPixelSize(cfg.w, cfg.h, cfg.mode) : { w: cfg.w, h: cfg.h };
      const { width: evenW, height: evenH } = clampEvenPixelSize(
        rawPixel.w,
        rawPixel.h,
        2,
        2,
        MAX_EXPORT_PIXEL_DIM,
        MAX_EXPORT_PIXEL_DIM,
      );
      const transform =
        cfg.format === 'ans' ? getModePixelAspect(cfg.mode) : { pixelAspectX: 1, pixelAspectY: 1 };

      const meta = await loadVectorIntoWasm(wasm, asset, evenW, evenH, transform);
      if (!meta.loaded) {
        throw new Error(`Error: ThorVG WASM failed to load "${asset.sourceLabel}".`);
      }

      const clampedFrame = Math.min(meta.totalFrames - 1, Math.max(0, cfg.frame));
      const extractor = new WasmPixelExtractor();
      const bgScratch = { current: new Uint8Array(0) };

      if (cfg.format === 'png') {
        const pf = renderWasmPixelFrame(wasm, extractor, clampedFrame, evenW, evenH, {
          invertDark: cfg.invert,
          background: cfg.bg,
          bgScratch,
        });
        const pngBuf = encodeRgbaToPng(pf);
        await fs.promises.writeFile(resolvedOut, pngBuf);
        return { bytesWritten: pngBuf.length, format: 'png' };
      }

      if (cfg.format === 'gif') {
        const nativeFps =
          !meta.isStatic && meta.duration > 0 ? Math.round(meta.totalFrames / meta.duration) : 20;
        const targetFps = cfg.fps ?? Math.min(50, Math.max(1, nativeFps || 20));
        const exportCount = meta.isStatic
          ? 1
          : Math.min(MAX_GIF_FRAMES, Math.max(1, Math.round(meta.duration * targetFps)));

        const frames: PixelFrame[] = [];
        for (let i = 0; i < exportCount; i++) {
          const sampleFrame =
            exportCount <= 1
              ? 0
              : Math.min(meta.totalFrames - 1, Math.floor((i * meta.totalFrames) / exportCount));
          const pf = renderWasmPixelFrame(wasm, extractor, sampleFrame, evenW, evenH, {
            invertDark: cfg.invert,
            background: cfg.bg,
            bgScratch,
          });
          frames.push({ width: pf.width, height: pf.height, data: new Uint8Array(pf.data) });
        }

        const gifBuf = encodeFramesToGif(frames, { fps: targetFps, loop: true });
        await fs.promises.writeFile(resolvedOut, gifBuf);
        return { bytesWritten: gifBuf.length, format: 'gif' };
      }

      const ansiOutput = renderVectorFrame(wasm, clampedFrame, {
        mode: cfg.mode,
        cols: cfg.w,
        rows: cfg.h,
        pixelWidth: evenW,
        pixelHeight: evenH,
        invertDark: cfg.invert,
        background: cfg.bg,
        optimizeRle: true,
        extractor,
        bgScratch,
      });
      const outBuf = Buffer.from(ansiOutput + '\n', 'utf8');
      await fs.promises.writeFile(resolvedOut, outBuf);
      return { bytesWritten: outBuf.length, format: 'ans' };
    } finally {
      if (ownsWasm) {
        wasm.destroy();
      }
    }
  });
}

/**
 * `termvg export <source> -o <out.(png|gif|ans|txt)>` CLI 실행 진입점.
 * 반환값: 종료 코드 (0: 성공, 1: 에셋/I/O 실패, 2: 플래그/확장자 검증 오류)
 */
export async function runExportCli(
  source: string | undefined,
  flags: Record<string, any>,
): Promise<number> {
  const outputPath = typeof flags.output === 'string' ? flags.output : '';
  if (!source || !source.trim() || !outputPath.trim()) {
    process.stderr.write(
      'Usage: termvg export <file|url|-> -o <out.(png|gif|ans|txt)> [--frame N] [--size WxH] [--fps N] [--mode half-block|quadrant|sextant|braille] [--bg transparent|dark|light|checkerboard] [--invert] [--anim id]\n' +
        'Error: Both <source> and -o/--output are required.\n',
    );
    return 2;
  }

  try {
    const res = await exportVectorAsset({
      source,
      outputPath,
      frame: flags.frame,
      size: flags.size,
      fps: flags.fps,
      mode: flags.mode,
      bg: flags.bg,
      invert: Boolean(flags.invert),
      subAnimationId: typeof flags.anim === 'string' ? flags.anim : undefined,
    });
    process.stdout.write(
      `Exported ${res.format.toUpperCase()} (${res.bytesWritten} bytes) -> ${outputPath}\n`,
    );
    return 0;
  } catch (err: any) {
    if (err instanceof CliValidationError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    if (err?.code === 'EACCES' || err?.code === 'EPERM' || err?.code === 'EISDIR') {
      process.stderr.write(`Error: Cannot write output file "${outputPath}": ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`${err?.message || String(err)}\n`);
    return 1;
  }
}
