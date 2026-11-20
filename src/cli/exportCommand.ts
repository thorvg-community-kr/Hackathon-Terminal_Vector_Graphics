import fs from 'node:fs';
import path from 'node:path';
import { loadVectorAsset } from '../loaders/assetLoader.js';
import { calcPixelSize } from '../LottiePlayer.js';
import { realWasmModule } from '../realWasmModule.js';
import { encodeFramesToGif } from '../renderers/minimalGif.js';
import { encodeRgbaToPng } from '../renderers/minimalPng.js';
import {
  applyBackgroundPresetToPixels,
  normalizeEvenHeight,
  WasmPixelExtractor,
  type PixelFrame,
} from '../renderers/pixelExtractor.js';
import { renderPixelsToSextant } from '../renderers/sextantRenderer.js';
import {
  postProcessAnsiFrame,
  type BackgroundPreset,
} from '../utils/ansiPostProcessor.js';
import {
  getModePixelAspect,
  preprocessVectorData,
  remapPureBlackForeground,
} from '../utils/vectorPreprocessor.js';

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

export class ExportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportValidationError';
  }
}

const VALID_EXPORT_MODES = new Set<string>(['half-block', 'quadrant', 'sextant', 'braille']);
const VALID_BG_PRESETS = new Set<string>(['transparent', 'dark', 'light', 'checkerboard']);
const MAX_EXPORT_PIXEL_DIM = 2048;
const MAX_GIF_FRAMES = 300;

function parseSizeFlag(sizeStr: string): { w: number; h: number } {
  const match = sizeStr.trim().match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new ExportValidationError(
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
    throw new ExportValidationError(
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
  throw new ExportValidationError(
    `Error: Unsupported export extension "${ext || '(none)'}". Supported formats: .png, .gif, .ans, .txt.`,
  );
}

function validateAndNormalizeExportOptions(
  options: ExportOptions,
): {
  format: 'png' | 'gif' | 'ans';
  w: number;
  h: number;
  frame: number;
  fps?: number;
  mode: ExportAnsiMode;
  bg: BackgroundPreset;
  invert: boolean;
} {
  if (!options.source || !options.source.trim()) {
    throw new ExportValidationError('Error: Missing target source for export.');
  }
  if (!options.outputPath || !options.outputPath.trim()) {
    throw new ExportValidationError('Error: Missing required -o / --output path.');
  }

  const format = resolveOutputFormat(options.outputPath);

  let frame = 0;
  if (options.frame !== undefined) {
    if (
      typeof options.frame !== 'number' ||
      !Number.isInteger(options.frame) ||
      options.frame < 0
    ) {
      throw new ExportValidationError('Error: --frame must be a non-negative integer.');
    }
    frame = options.frame;
  }

  let fps: number | undefined;
  if (options.fps !== undefined) {
    if (
      typeof options.fps !== 'number' ||
      !Number.isFinite(options.fps) ||
      options.fps <= 0 ||
      options.fps > 50
    ) {
      throw new ExportValidationError('Error: --fps must be a number in (0, 50].');
    }
    fps = options.fps;
  }

  const modeRaw = options.mode ?? 'quadrant';
  if (typeof modeRaw !== 'string' || !VALID_EXPORT_MODES.has(modeRaw)) {
    throw new ExportValidationError(
      `Error: Invalid export --mode "${String(modeRaw)}". Allowed: half-block, quadrant, sextant, braille.`,
    );
  }
  const mode = modeRaw as ExportAnsiMode;

  const bgRaw = options.bg ?? 'transparent';
  if (typeof bgRaw !== 'string' || !VALID_BG_PRESETS.has(bgRaw)) {
    throw new ExportValidationError(
      `Error: Invalid --bg preset "${String(bgRaw)}". Allowed: transparent, dark, light, checkerboard.`,
    );
  }
  const bg = bgRaw as BackgroundPreset;

  const defaultSize = format === 'ans' ? '80x40' : '256x256';
  const sizeInput = options.size ?? defaultSize;
  if (typeof sizeInput !== 'string') {
    throw new ExportValidationError('Error: --size must be a string in WxH format.');
  }
  const { w, h } = parseSizeFlag(sizeInput);

  return {
    format,
    w,
    h,
    frame,
    fps,
    mode,
    bg,
    invert: Boolean(options.invert),
  };
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

  try {
    await wasm.init();

    const raw = remapPureBlackForeground(asset.content, asset.format);

    if (cfg.format === 'png' || cfg.format === 'gif') {
      const evenW = Math.max(2, Math.min(MAX_EXPORT_PIXEL_DIM, cfg.w + (cfg.w % 2)));
      const evenH = Math.max(2, Math.min(MAX_EXPORT_PIXEL_DIM, normalizeEvenHeight(cfg.h)));
      wasm.setSize(evenW, evenH);

      const processed = preprocessVectorData(raw, asset.format, {
        pixelAspectX: 1,
        pixelAspectY: 1,
      });
      if (!wasm.loadContent(processed)) {
        throw new Error(`Error: ThorVG WASM failed to load "${asset.sourceLabel}".`);
      }

      const rawTotal = wasm.getTotalFrames();
      const duration = wasm.getDuration();
      const isStatic =
        asset.format === 'svg' ||
        !Number.isFinite(rawTotal) ||
        !Number.isFinite(duration) ||
        rawTotal <= 1 ||
        duration <= 0;
      const totalFrames = isStatic ? 1 : Math.max(1, Math.floor(rawTotal));

      const extractor = new WasmPixelExtractor();
      const bgScratch = { current: new Uint8Array(0) };

      if (cfg.format === 'png') {
        const clampedFrame = Math.min(totalFrames - 1, Math.max(0, cfg.frame));
        let pf = extractor.renderAndExtract(wasm, clampedFrame, evenW, evenH, cfg.invert);
        if (cfg.bg !== 'transparent') {
          pf = applyBackgroundPresetToPixels(pf, cfg.bg, bgScratch);
        }
        const pngBuf = encodeRgbaToPng(pf);
        await fs.promises.writeFile(resolvedOut, pngBuf);
        return { bytesWritten: pngBuf.length, format: 'png' };
      }

      // .gif 다중 프레임 샘플링 및 독립 버퍼 복사
      const nativeFps = !isStatic && duration > 0 ? Math.round(totalFrames / duration) : 20;
      const targetFps = cfg.fps ?? Math.min(50, Math.max(1, nativeFps || 20));
      const exportCount = isStatic
        ? 1
        : Math.min(MAX_GIF_FRAMES, Math.max(1, Math.round(duration * targetFps)));

      const frames: PixelFrame[] = [];
      for (let i = 0; i < exportCount; i++) {
        const sampleFrame =
          exportCount <= 1
            ? 0
            : Math.min(totalFrames - 1, Math.floor((i * totalFrames) / exportCount));
        let pf = extractor.renderAndExtract(wasm, sampleFrame, evenW, evenH, cfg.invert);
        if (cfg.bg !== 'transparent') {
          pf = applyBackgroundPresetToPixels(pf, cfg.bg, bgScratch);
        }
        frames.push({
          width: pf.width,
          height: pf.height,
          data: new Uint8Array(pf.data),
        });
      }

      const gifBuf = encodeFramesToGif(frames, { fps: targetFps, loop: true });
      await fs.promises.writeFile(resolvedOut, gifBuf);
      return { bytesWritten: gifBuf.length, format: 'gif' };
    }

    // .ans / .txt 유니코드 ANSI 내보내기
    const rawPixel = calcPixelSize(cfg.w, cfg.h, cfg.mode);
    const evenW = Math.max(2, Math.min(MAX_EXPORT_PIXEL_DIM, rawPixel.w + (rawPixel.w % 2)));
    const evenH = Math.max(2, Math.min(MAX_EXPORT_PIXEL_DIM, normalizeEvenHeight(rawPixel.h)));
    wasm.setSize(evenW, evenH);

    const aspect = getModePixelAspect(cfg.mode);
    const processed = preprocessVectorData(raw, asset.format, aspect);
    if (!wasm.loadContent(processed)) {
      throw new Error(`Error: ThorVG WASM failed to load "${asset.sourceLabel}".`);
    }

    const rawTotal = wasm.getTotalFrames();
    const totalFrames = Number.isFinite(rawTotal) && rawTotal > 1 ? Math.floor(rawTotal) : 1;
    const clampedFrame = Math.min(totalFrames - 1, Math.max(0, cfg.frame));

    let ansiOutput: string;
    if (cfg.mode === 'sextant') {
      const extractor = new WasmPixelExtractor();
      const pf = extractor.renderAndExtract(wasm, clampedFrame, evenW, evenH, cfg.invert);
      ansiOutput = renderPixelsToSextant(pf, { background: cfg.bg, optimizeRle: true });
    } else {
      const modeInt = cfg.mode === 'half-block' ? 0 : cfg.mode === 'quadrant' ? 1 : 2;
      const rawAnsi = wasm.renderToString(clampedFrame, modeInt, cfg.invert);
      ansiOutput = postProcessAnsiFrame(rawAnsi, { background: cfg.bg, optimizeRle: true });
    }

    const outBuf = Buffer.from(ansiOutput + '\n', 'utf8');
    await fs.promises.writeFile(resolvedOut, outBuf);
    return { bytesWritten: outBuf.length, format: 'ans' };
  } finally {
    if (ownsWasm) {
      wasm.destroy();
    }
  }
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

  if (flags.frame !== undefined && typeof flags.frame !== 'number') {
    process.stderr.write('Error: --frame must be a non-negative integer.\n');
    return 2;
  }
  if (flags.fps !== undefined && typeof flags.fps !== 'number') {
    process.stderr.write('Error: --fps must be a number in (0, 50].\n');
    return 2;
  }
  if (flags.size !== undefined && typeof flags.size !== 'string') {
    process.stderr.write('Error: --size must be in WxH format.\n');
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
    if (err instanceof ExportValidationError) {
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
