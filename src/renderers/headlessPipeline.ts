import util from 'node:util';
import type { LoadedVectorAsset } from '../loaders/assetLoader.js';
import {
  postProcessAnsiFrame,
  type BackgroundPreset,
} from '../utils/ansiPostProcessor.js';
import {
  preprocessVectorData,
  remapPureBlackForeground,
  type VectorTransformOptions,
} from '../utils/vectorPreprocessor.js';
import { encodeIterm2Graphics } from './iterm2Renderer.js';
import { encodeKittyGraphics } from './kittyRenderer.js';
import {
  applyBackgroundPresetToPixels,
  WasmPixelExtractor,
  type PixelFrame,
} from './pixelExtractor.js';
import { detectTerminalProtocol } from './protocolDetector.js';
import { renderPixelsToSextant } from './sextantRenderer.js';

export type RenderMode =
  | 'auto'
  | 'kitty'
  | 'iterm2'
  | 'sextant'
  | 'quadrant'
  | 'braille'
  | 'half-block';

export type EffectiveRenderMode = Exclude<RenderMode, 'auto'>;

export interface CalcPixelSizeOptions {
  paused?: boolean;
  isStatic?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ClampedPixelSize {
  width: number;
  height: number;
}

export interface LoadWasmVectorResult {
  loaded: boolean;
  isStatic: boolean;
  totalFrames: number;
  duration: number;
}

export interface RenderVectorFrameOptions {
  mode: EffectiveRenderMode;
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
  invertDark?: boolean;
  background?: BackgroundPreset;
  optimizeRle?: boolean;
  extractor?: WasmPixelExtractor;
  bgScratch?: { current: Uint8Array };
}

/** 렌더 모드 → C++ enum 매핑 (sextant/kitty/iterm2는 Mode 0 무손실 RGB 브릿지 사용) */
export const RENDER_MODE_INT: Record<EffectiveRenderMode, number> = {
  'half-block': 0,
  quadrant: 1,
  sextant: 0,
  braille: 2,
  kitty: 0,
  iterm2: 0,
};

export const VALID_PLAY_MODES = new Set<string>([
  'auto',
  'kitty',
  'iterm2',
  'sextant',
  'quadrant',
  'braille',
  'half-block',
]);
export const VALID_EXPORT_MODES = new Set<string>([
  'half-block',
  'quadrant',
  'sextant',
  'braille',
]);
export const VALID_BG_PRESETS = new Set<string>([
  'transparent',
  'dark',
  'light',
  'checkerboard',
]);

export class CliValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliValidationError';
  }
}

export function validateRenderMode(
  raw: unknown,
  allowed: ReadonlySet<string>,
  allowedText: string,
  flagLabel = '--mode',
): string {
  if (typeof raw !== 'string' || !allowed.has(raw)) {
    throw new CliValidationError(
      `Error: Invalid ${flagLabel} "${String(raw)}". Allowed: ${allowedText}.`,
    );
  }
  return raw;
}

export function validateBgPreset(raw: unknown, flagLabel = '--bg'): BackgroundPreset {
  if (typeof raw !== 'string' || !VALID_BG_PRESETS.has(raw)) {
    throw new CliValidationError(
      `Error: Invalid ${flagLabel} "${String(raw)}". Allowed: transparent, dark, light, checkerboard.`,
    );
  }
  return raw as BackgroundPreset;
}

export function validatePositiveInt(raw: unknown, flagName: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new CliValidationError(`Error: ${flagName} must be a positive integer.`);
  }
  return raw;
}

/**
 * 'auto' 모드를 현재 터미널 환경변수에 맞는 실제 렌더 모드로 해석한다.
 */
export function resolveEffectiveRenderMode(
  renderMode: RenderMode,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveRenderMode {
  if (renderMode !== 'auto') return renderMode;
  const detected = detectTerminalProtocol(env);
  if (detected === 'kitty') return 'kitty';
  if (detected === 'iterm2') return 'iterm2';
  return 'quadrant';
}

/**
 * 렌더 모드 → 픽셀 해상도 계산.
 * - kitty / iterm2: 재생 중 최대 200x200(30fps 유지), 일시정지·정적 SVG 최대 360x360(짝수 높이)
 */
export function calcPixelSize(
  width: number,
  height: number,
  mode: RenderMode,
  options?: CalcPixelSizeOptions,
) {
  const resolved = resolveEffectiveRenderMode(mode, options?.env);
  switch (resolved) {
    case 'kitty':
    case 'iterm2': {
      const maxDim = options?.paused || options?.isStatic ? 360 : 200;
      const safeCols = Math.max(1, Math.floor(Number.isFinite(width) ? width : 80));
      const safeRows = Math.max(1, Math.floor(Number.isFinite(height) ? height : 40));
      const rawW = safeCols * 8;
      const rawH = safeRows * 16;
      const scale = Math.min(1, maxDim / Math.max(1, rawW, rawH));
      const w = Math.max(16, Math.min(maxDim, Math.round(rawW * scale) & ~1));
      const h = Math.max(8, Math.min(maxDim, Math.round(rawH * scale) & ~1));
      return { w, h };
    }
    case 'braille':  return { w: width * 2, h: height * 4 };
    // 셀 행을 짝수로 맞춰 픽셀 높이를 6의 배수(짝수·3배수)로 만든다 — 홀수 높이에서 하단 행 크롭 방지
    case 'sextant':  return { w: width * 2, h: Math.max(2, height - (height % 2)) * 3 };
    case 'quadrant': return { w: width * 2, h: height * 2 };
    default:         return { w: width,     h: height * 2 };
  }
}

function clampEvenAxis(raw: number, minVal: number, maxVal?: number): number {
  const safeMin = Number.isFinite(minVal)
    ? Math.max(2, Math.floor(minVal) + (Math.floor(minVal) % 2))
    : 2;
  const safeMax =
    maxVal !== undefined && Number.isFinite(maxVal)
      ? Math.max(safeMin, Math.floor(maxVal) & ~1)
      : Infinity;
  const finite = Number.isFinite(raw) ? Math.floor(raw) : safeMin;
  const clamped = Math.min(safeMax, Math.max(safeMin, finite));
  return clamped % 2 === 0 ? clamped : Math.min(safeMax, clamped + 1);
}

/**
 * 초소형 터미널이나 홀수 해상도가 WASM setSize(uint32_t)에 전달되어
 * 언더플로우나 행 잘림이 발생하지 않도록 최소 크기(기본 16x8) 및 짝수 정렬을 보장한다.
 */
export function clampEvenPixelSize(
  rawWidth: number,
  rawHeight: number,
  minWidth = 16,
  minHeight = 8,
  maxWidth?: number,
  maxHeight?: number,
): ClampedPixelSize {
  return {
    width: clampEvenAxis(rawWidth, minWidth, maxWidth),
    height: clampEvenAxis(rawHeight, minHeight, maxHeight),
  };
}

/**
 * WASM 초기화 → 해상도 설정 → 검정 치환 및 벡터 전처리 → loadContent → 타임라인 정규화를 일괄 수행한다.
 */
export async function loadVectorIntoWasm(
  wasmModule: any,
  asset: Pick<LoadedVectorAsset, 'content' | 'format'>,
  pixelWidth: number,
  pixelHeight: number,
  transformOptions?: VectorTransformOptions,
): Promise<LoadWasmVectorResult> {
  await wasmModule.init();
  wasmModule.setSize(pixelWidth, pixelHeight);
  const raw = remapPureBlackForeground(asset.content, asset.format);
  const processed = preprocessVectorData(raw, asset.format, transformOptions);
  if (!wasmModule.loadContent(processed)) {
    return { loaded: false, isStatic: true, totalFrames: 1, duration: 0 };
  }

  const rawTotal = wasmModule.getTotalFrames();
  const rawDuration = wasmModule.getDuration();
  const isStatic =
    asset.format === 'svg' ||
    !Number.isFinite(rawTotal) ||
    !Number.isFinite(rawDuration) ||
    rawTotal <= 1 ||
    rawDuration <= 0;
  return {
    loaded: true,
    isStatic,
    totalFrames: isStatic ? 1 : Math.max(1, Math.floor(rawTotal)),
    duration: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0,
  };
}

/**
 * Mode 0 무손실 RGBA 프레임 추출 및 선택적 테마 배경 프리셋 합성을 수행한다.
 */
export function renderWasmPixelFrame(
  wasmModule: any,
  extractor: WasmPixelExtractor,
  frameIdx: number,
  pixelWidth: number,
  pixelHeight: number,
  options?: {
    invertDark?: boolean;
    background?: BackgroundPreset;
    bgScratch?: { current: Uint8Array };
  },
): PixelFrame {
  const safeFrame = Math.max(0, Math.floor(frameIdx));
  const rawMode0 = wasmModule.renderToString(safeFrame, 0, Boolean(options?.invertDark));
  const pf = extractor.extractFromHalfBlockAnsi(rawMode0, pixelWidth, pixelHeight);
  const bg = options?.background ?? 'transparent';
  if (bg !== 'transparent' && options?.bgScratch) {
    return applyBackgroundPresetToPixels(pf, bg, options.bgScratch);
  }
  return pf;
}

/**
 * 모든 렌더 모드(kitty / iterm2 / sextant / quadrant / braille / half-block)에 대한 단일 프레임 출력기.
 */
export function renderVectorFrame(
  wasmModule: any,
  frameIdx: number,
  opts: RenderVectorFrameOptions,
): string {
  const invert = Boolean(opts.invertDark);
  const background = opts.background ?? 'transparent';
  const optimizeRle = opts.optimizeRle ?? true;

  if (opts.mode === 'kitty' || opts.mode === 'iterm2') {
    const extractor = opts.extractor ?? new WasmPixelExtractor();
    const bgScratch = opts.bgScratch ?? { current: new Uint8Array(0) };
    const composited = renderWasmPixelFrame(
      wasmModule,
      extractor,
      frameIdx,
      opts.pixelWidth,
      opts.pixelHeight,
      { invertDark: invert, background, bgScratch },
    );
    return opts.mode === 'kitty'
      ? encodeKittyGraphics(composited, { cols: opts.cols, rows: opts.rows })
      : encodeIterm2Graphics(composited, { cols: opts.cols, rows: opts.rows });
  }

  if (opts.mode === 'sextant') {
    const extractor = opts.extractor ?? new WasmPixelExtractor();
    const pf = renderWasmPixelFrame(
      wasmModule,
      extractor,
      frameIdx,
      opts.pixelWidth,
      opts.pixelHeight,
      { invertDark: invert },
    );
    return renderPixelsToSextant(pf, { background, optimizeRle });
  }

  const rawAnsi = wasmModule.renderToString(frameIdx, RENDER_MODE_INT[opts.mode], invert);
  return postProcessAnsiFrame(rawAnsi, { background, optimizeRle });
}

/**
 * stdout JSON/MCP 스트림 오염을 원천 차단하기 위해 console.log/info/warn/debug를 stderr로 리다이렉트한다.
 */
export function installStderrConsoleGuard(): () => void {
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origDebug = console.debug;

  const redirectToStderr = (...args: unknown[]) => {
    process.stderr.write(util.format(...args) + '\n');
  };

  console.log = redirectToStderr;
  console.info = redirectToStderr;
  console.warn = redirectToStderr;
  console.debug = redirectToStderr;

  return () => {
    console.log = origLog;
    console.info = origInfo;
    console.warn = origWarn;
    console.debug = origDebug;
  };
}

export async function withStderrConsoleGuard<T>(fn: () => Promise<T>): Promise<T> {
  const restore = installStderrConsoleGuard();
  try {
    return await fn();
  } finally {
    restore();
  }
}
