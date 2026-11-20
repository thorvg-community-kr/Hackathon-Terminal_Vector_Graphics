import { loadVectorAsset } from '../loaders/assetLoader.js';
import { realWasmModule } from '../realWasmModule.js';
import { parseLottieMarkers } from '../utils/lottieMarkers.js';
import {
  preprocessVectorData,
  remapPureBlackForeground,
} from '../utils/vectorPreprocessor.js';

export interface LayerTypeBreakdown {
  precomp: number; // ty === 0
  solid: number; // ty === 1
  image: number; // ty === 2
  null: number; // ty === 3
  shape: number; // ty === 4
  text: number; // ty === 5
  audio: number; // ty === 6
  video: number; // ty === 9
  camera: number; // ty === 13
  other: number;
}

export interface VectorMarkerInfo {
  name: string;
  frame: number;
  durationFrames: number;
}

export interface VectorInspectionReport {
  source: string;
  sourceKind: 'file' | 'dotlottie' | 'url' | 'stdin';
  format: 'svg' | 'lottie' | 'dotlottie';
  byteSize: number;
  width: number;
  height: number;
  frames: number;
  fps: number;
  duration: number;
  version?: string;
  animationIds?: string[];
  layerCount: number;
  layerTypes: LayerTypeBreakdown;
  markers: VectorMarkerInfo[];
  warnings: string[];
  engineLoadOk: boolean;
  engineError?: string;
}

function emptyLayerBreakdown(): LayerTypeBreakdown {
  return {
    precomp: 0,
    solid: 0,
    image: 0,
    null: 0,
    shape: 0,
    text: 0,
    audio: 0,
    video: 0,
    camera: 0,
    other: 0,
  };
}

function inferSourceKind(source: string): 'file' | 'dotlottie' | 'url' | 'stdin' {
  const trimmed = source.trim();
  if (trimmed === '-') return 'stdin';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return 'url';
  if (trimmed.toLowerCase().endsWith('.lottie')) return 'dotlottie';
  return 'file';
}

function countLottieLayers(
  layers: unknown,
  breakdown: LayerTypeBreakdown,
): number {
  if (!Array.isArray(layers)) return 0;
  let total = 0;
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    total++;
    const ty = (layer as Record<string, unknown>).ty;
    switch (ty) {
      case 0:
        breakdown.precomp++;
        break;
      case 1:
        breakdown.solid++;
        break;
      case 2:
        breakdown.image++;
        break;
      case 3:
        breakdown.null++;
        break;
      case 4:
        breakdown.shape++;
        break;
      case 5:
        breakdown.text++;
        break;
      case 6:
        breakdown.audio++;
        break;
      case 9:
        breakdown.video++;
        break;
      case 13:
        breakdown.camera++;
        break;
      default:
        breakdown.other++;
        break;
    }
  }
  return total;
}

function detectLottieExpressions(root: unknown): boolean {
  const stack: Array<{ val: unknown; depth: number }> = [{ val: root, depth: 0 }];
  while (stack.length > 0) {
    const { val, depth } = stack.pop()!;
    if (!val || typeof val !== 'object' || depth > 24) continue;
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        stack.push({ val: val[i], depth: depth + 1 });
      }
      continue;
    }
    const obj = val as Record<string, unknown>;
    if (typeof obj.x === 'string' && obj.x.trim().length > 0) {
      return true;
    }
    for (const key of Object.keys(obj)) {
      const child = obj[key];
      if (child && typeof child === 'object') {
        stack.push({ val: child, depth: depth + 1 });
      }
    }
  }
  return false;
}

function extractSvgAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = attrs.match(re);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

function parseSvgDim(raw: string | undefined): number {
  if (!raw || raw.trim().endsWith('%')) return 0;
  const m = raw.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt)?$/i);
  if (!m) return 0;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return m[2]?.toLowerCase() === 'pt' ? num * (96 / 72) : num;
}

function analyzeSvgMetadata(content: string): {
  width: number;
  height: number;
  layerCount: number;
  layerTypes: LayerTypeBreakdown;
  warnings: string[];
} {
  const breakdown = emptyLayerBreakdown();
  const warnings: string[] = [];
  const masked = content
    .replace(/<!DOCTYPE[^\[>]*(?:\[[\s\S]*?\]\s*)?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  let width = 0;
  let height = 0;
  const svgMatch = masked.match(/<svg\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/i);
  if (svgMatch) {
    const attrs = svgMatch[1];
    const vb = extractSvgAttr(attrs, 'viewBox');
    if (vb) {
      const nums = vb.trim().split(/[\s,]+/).map(Number);
      if (nums.length === 4 && nums.every(Number.isFinite) && nums[2] > 0 && nums[3] > 0) {
        width = nums[2];
        height = nums[3];
      }
    }
    if (width <= 0 || height <= 0) {
      width = parseSvgDim(extractSvgAttr(attrs, 'width'));
      height = parseSvgDim(extractSvgAttr(attrs, 'height'));
    }
  }

  const shapeMatches = masked.match(/<(?:path|rect|circle|ellipse|polygon|polyline|line)\b/gi);
  breakdown.shape = shapeMatches ? shapeMatches.length : 0;

  const textMatches = masked.match(/<text\b/gi);
  breakdown.text = textMatches ? textMatches.length : 0;

  const imageMatches = masked.match(/<image\b/gi);
  breakdown.image = imageMatches ? imageMatches.length : 0;

  const groupMatches = masked.match(/<g\b/gi);
  breakdown.null = groupMatches ? groupMatches.length : 0;

  const useMatches = masked.match(/<use\b/gi);
  breakdown.precomp = useMatches ? useMatches.length : 0;

  const layerCount =
    breakdown.shape + breakdown.text + breakdown.image + breakdown.null + breakdown.precomp;

  if (breakdown.text > 0 || /@font-face/i.test(masked)) {
    warnings.push('Contains SVG <text> or @font-face (external font rendering may vary)');
  }

  const imageTags = masked.match(/<image\b[^>]*>/gi) ?? [];
  const hasExternalImage = imageTags.some((tag) => {
    const href = extractSvgAttr(tag, 'href') ?? extractSvgAttr(tag, 'xlink:href');
    return Boolean(href && !href.trim().toLowerCase().startsWith('data:'));
  });
  if (hasExternalImage) {
    warnings.push('Contains external <image> reference(s) without embedded Data URI');
  }

  return { width, height, layerCount, layerTypes: breakdown, warnings };
}

function analyzeLottieMetadata(content: string): {
  width: number;
  height: number;
  fps: number;
  frames: number;
  duration: number;
  version?: string;
  layerCount: number;
  layerTypes: LayerTypeBreakdown;
  markers: VectorMarkerInfo[];
  warnings: string[];
} {
  const breakdown = emptyLayerBreakdown();
  const warnings: string[] = [];
  const parsed = JSON.parse(content) as Record<string, any>;

  const width = Number.isFinite(Number(parsed.w)) ? Number(parsed.w) : 0;
  const height = Number.isFinite(Number(parsed.h)) ? Number(parsed.h) : 0;
  const fps = Number.isFinite(Number(parsed.fr)) ? Number(parsed.fr) : 0;
  const ip = Number.isFinite(Number(parsed.ip)) ? Number(parsed.ip) : 0;
  const op = Number.isFinite(Number(parsed.op)) ? Number(parsed.op) : 0;
  const frames = op > ip ? Math.round(op - ip) : 0;
  const duration = fps > 0 && frames > 0 ? Math.round((frames / fps) * 1000) / 1000 : 0;
  const version = typeof parsed.v === 'string' ? parsed.v : undefined;

  let layerCount = countLottieLayers(parsed.layers, breakdown);
  const assets = Array.isArray(parsed.assets) ? parsed.assets : [];

  let hasExternalImage = false;
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') continue;
    if (Array.isArray(asset.layers)) {
      layerCount += countLottieLayers(asset.layers, breakdown);
    }
    if (typeof asset.p === 'string' && asset.p.length > 0 && !asset.p.startsWith('data:') && asset.e !== 1) {
      hasExternalImage = true;
    }
  }

  const hasFonts =
    breakdown.text > 0 ||
    (parsed.fonts && Array.isArray(parsed.fonts.list) && parsed.fonts.list.length > 0);
  if (hasFonts) {
    warnings.push('Uses text/fonts (system font rendering may vary or require glyph outlines)');
  }
  if (hasExternalImage) {
    warnings.push('Contains external image asset reference(s) without embedded Data URI');
  }
  if (detectLottieExpressions(parsed)) {
    warnings.push('Contains After Effects expressions ("x") which are not supported by ThorVG');
  }

  const markers = parseLottieMarkers(parsed, frames > 0 ? frames : undefined).map((m) => ({
    name: m.name,
    frame: m.time,
    durationFrames: m.duration,
  }));

  return {
    width,
    height,
    fps,
    frames,
    duration,
    version,
    layerCount,
    layerTypes: breakdown,
    markers,
    warnings,
  };
}

/**
 * 벡터 에셋(.svg / .json / .lottie / URL / stdin)의 메타데이터, 레이어 통계,
 * 호환성 경고 및 ThorVG WASM 로드 유효성을 검사한다. (stdout 오염 원천 격리)
 */
export async function inspectVectorAsset(
  source: string,
  options?: { wasmModule?: any; subAnimationId?: string },
): Promise<VectorInspectionReport> {
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };

  try {
    let asset;
    try {
      asset = await loadVectorAsset(source, options?.subAnimationId);
    } catch (err: any) {
      const kind = inferSourceKind(source);
      return {
        source,
        sourceKind: kind,
        format: kind === 'dotlottie' ? 'dotlottie' : 'lottie',
        byteSize: 0,
        width: 0,
        height: 0,
        frames: 0,
        fps: 0,
        duration: 0,
        layerCount: 0,
        layerTypes: emptyLayerBreakdown(),
        markers: [],
        warnings: [],
        engineLoadOk: false,
        engineError: err instanceof Error ? err.message : String(err),
      };
    }

    const reportFormat: 'svg' | 'lottie' | 'dotlottie' =
      asset.sourceKind === 'dotlottie' || asset.containerFormat === 'dotlottie'
        ? 'dotlottie'
        : asset.format;

    let width = 0;
    let height = 0;
    let fps = 0;
    let frames = asset.format === 'svg' ? 1 : 0;
    let duration = 0;
    let version: string | undefined;
    let layerCount = 0;
    let layerTypes = emptyLayerBreakdown();
    let markers: VectorMarkerInfo[] = [];
    let warnings: string[] = [];

    if (asset.format === 'svg') {
      const meta = analyzeSvgMetadata(asset.content);
      width = meta.width;
      height = meta.height;
      layerCount = meta.layerCount;
      layerTypes = meta.layerTypes;
      warnings = meta.warnings;
    } else {
      const meta = analyzeLottieMetadata(asset.content);
      width = meta.width;
      height = meta.height;
      fps = meta.fps;
      frames = meta.frames;
      duration = meta.duration;
      version = meta.version;
      layerCount = meta.layerCount;
      layerTypes = meta.layerTypes;
      markers = meta.markers;
      warnings = meta.warnings;
    }

    const wasm = options?.wasmModule ?? realWasmModule;
    let engineLoadOk = false;
    let engineError: string | undefined;

    try {
      await wasm.init();
      const testW = Math.max(16, Math.min(256, Math.round(width || 64) & ~1 || 64));
      const testH = Math.max(16, Math.min(256, Math.round(height || 64) & ~1 || 64));
      wasm.setSize(testW, testH);
      const raw = remapPureBlackForeground(asset.content, asset.format);
      const processed = preprocessVectorData(raw, asset.format, {
        pixelAspectX: 1,
        pixelAspectY: 1,
      });
      engineLoadOk = Boolean(wasm.loadContent(processed));
      if (engineLoadOk) {
        if (asset.format === 'lottie') {
          const wasmFrames = wasm.getTotalFrames();
          const wasmDuration = wasm.getDuration();
          if (Number.isFinite(wasmFrames) && wasmFrames > 0) {
            frames = Math.round(wasmFrames);
          }
          if (Number.isFinite(wasmDuration) && wasmDuration >= 0) {
            duration = Math.round(wasmDuration * 1000) / 1000;
          }
          if (fps <= 0 && duration > 0 && frames > 0) {
            fps = Math.round((frames / duration) * 100) / 100;
          }
        }
      } else {
        engineError = 'ThorVG WASM engine rejected the vector asset';
      }
    } catch (err: any) {
      engineLoadOk = false;
      engineError = err instanceof Error ? err.message : String(err);
    }

    const report: VectorInspectionReport = {
      source: asset.sourceLabel,
      sourceKind: asset.sourceKind,
      format: reportFormat,
      byteSize: asset.byteSize,
      width,
      height,
      frames,
      fps,
      duration,
      ...(version !== undefined ? { version } : {}),
      ...(asset.animationIds ? { animationIds: asset.animationIds } : {}),
      layerCount,
      layerTypes,
      markers,
      warnings,
      engineLoadOk,
      ...(engineError !== undefined ? { engineError } : {}),
    };
    return report;
  } finally {
    console.log = origLog;
  }
}

function formatHumanReport(report: VectorInspectionReport): string {
  const lines = [
    `Source:      ${report.source} (${report.sourceKind})`,
    `Format:      ${report.format}${report.version ? ` v${report.version}` : ''}`,
    `Size:        ${report.byteSize} bytes (${(report.byteSize / 1024).toFixed(1)} KB)`,
    `Dimensions:  ${report.width} x ${report.height}`,
    `Timeline:    ${report.frames} frames @ ${report.fps} fps (${report.duration}s)`,
    `Layers:      ${report.layerCount} (shape:${report.layerTypes.shape}, precomp:${report.layerTypes.precomp}, image:${report.layerTypes.image}, text:${report.layerTypes.text}, null:${report.layerTypes.null}, solid:${report.layerTypes.solid})`,
    `ThorVG WASM: ${report.engineLoadOk ? 'OK' : `FAILED (${report.engineError ?? 'unknown error'})`}`,
  ];
  if (report.animationIds && report.animationIds.length > 0) {
    lines.push(`Animations:  ${report.animationIds.join(', ')}`);
  }
  if (report.markers.length > 0) {
    lines.push(
      `Markers:     ${report.markers.map((m) => `${m.name}@${m.frame}(+${m.durationFrames})`).join(', ')}`,
    );
  }
  if (report.warnings.length > 0) {
    lines.push('Warnings:');
    for (const w of report.warnings) {
      lines.push(`  - ${w}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * `termvg inspect <source> [--json] [--anim <id>]` CLI 실행 진입점.
 * 반환값: 종료 코드 (0: 성공, 1: 에셋/WASM 실패, 2: 사용법/인자 오류)
 */
export async function runInspectCli(
  source: string | undefined,
  flags: { json?: boolean; anim?: string },
): Promise<number> {
  if (!source || !source.trim()) {
    process.stderr.write(
      'Usage: termvg inspect <file|url|-> [--json] [--anim <id>]\nError: Missing target source.\n',
    );
    return 2;
  }

  try {
    const report = await inspectVectorAsset(source, { subAnimationId: flags.anim });
    if (flags.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else if (report.engineLoadOk) {
      process.stdout.write(formatHumanReport(report));
    } else {
      process.stderr.write(formatHumanReport(report));
    }
    return report.engineLoadOk ? 0 : 1;
  } finally {
    realWasmModule.destroy();
  }
}
