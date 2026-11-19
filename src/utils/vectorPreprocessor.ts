/**
 * vectorPreprocessor.ts - 인메모리 SVG / Lottie JSON 비등방 종횡비 보정 및 무손실 벡터 줌/패닝 전처리기
 *
 * - 프리빌트 termvg.wasm을 수정하지 않고 quadrant(2.0) / sextant(4/3) 종횡비 보정과
 *   1.0x~8.0x 무손실 벡터 줌 및 정규화 뷰포트 패닝(SVG 서브 viewBox / Lottie 루트 Precomp 카메라) 수행
 * - Bounded LRU AST 캐시(Lottie 최대 4건 / SVG 최대 8건)로 연속 키 입력 시 중복 파싱 차단
 */

export interface VectorTransformOptions {
  /** 수평 가상 픽셀 보정 배율 (기본값: 1.0, quadrant: 2.0, sextant: 4/3) */
  pixelAspectX?: number;
  /** 수직 가상 픽셀 보정 배율 (기본값: 1.0) */
  pixelAspectY?: number;
  /** 무손실 벡터 줌 배율 (기본값: 1.0, 범위: 1.0 ~ 8.0) */
  zoom?: number;
  /** 정규화 수평 패닝 오프셋 [-1, 1] (기본값: 0.0) */
  panX?: number;
  /** 정규화 수직 패닝 오프셋 [-1, 1] (기본값: 0.0) */
  panY?: number;
}

export interface ViewportState {
  zoom: number;
  panX: number;
  panY: number;
}

export const ZOOM_STEPS = [1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0] as const;

const EPSILON = 1e-6;
const MAX_SVG_CACHE_ENTRIES = 8;
const MAX_LOTTIE_CACHE_ENTRIES = 4;

interface CachedSvgMeta {
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  preservedAttrs: string;
  prefix: string;
  innerBody: string;
  suffix: string;
}

interface CachedLottieAst {
  origW: number;
  origH: number;
  precompId: string;
  ip: number;
  op: number;
  baseTemplate: Record<string, any>;
}

const svgParseCache = new Map<string, CachedSvgMeta | null>();
const lottieAstCache = new Map<string, CachedLottieAst | null>();

function getLru<T>(cache: Map<string, T>, key: string): T | undefined {
  if (!cache.has(key)) return undefined;
  const val = cache.get(key)!;
  cache.delete(key);
  cache.set(key, val);
  return val;
}

function setLru<T>(cache: Map<string, T>, key: string, value: T, maxEntries: number): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, value);
}

/**
 * 테스트 및 메모리 회수를 위해 SVG / Lottie AST LRU 캐시를 비운다.
 */
export function clearVectorPreprocessorCache(): void {
  svgParseCache.clear();
  lottieAstCache.clear();
}

function clamp(val: number, min: number, max: number): number {
  return val < min ? min : val > max ? max : val;
}

/**
 * 줌 배율 [1.0, 8.0] 및 정규화 패닝 오프셋 [-(1 - 1/z), +(1 - 1/z)]를 경계 클램핑한다.
 */
export function clampViewport(zoom: number, panX: number, panY: number): ViewportState {
  const z = clamp(Number.isFinite(zoom) ? zoom : 1.0, 1.0, 8.0);
  if (z <= 1.0001) {
    return { zoom: 1.0, panX: 0, panY: 0 };
  }
  const maxPan = 1 - 1 / z;
  const px = clamp(Number.isFinite(panX) ? panX : 0, -maxPan, maxPan);
  const py = clamp(Number.isFinite(panY) ? panY : 0, -maxPan, maxPan);
  return { zoom: z, panX: px, panY: py };
}

/**
 * ZOOM_STEPS 단계 표에서 현재 줌 배율을 한 단계 확대(+1) 또는 축소(-1)한다.
 */
export function stepZoom(currentZoom: number, direction: 1 | -1): number {
  const safeZoom = Number.isFinite(currentZoom) ? currentZoom : 1.0;
  let nearestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < ZOOM_STEPS.length; i++) {
    const diff = Math.abs(ZOOM_STEPS[i] - safeZoom);
    if (diff < bestDiff) {
      bestDiff = diff;
      nearestIdx = i;
    }
  }
  const nextIdx = clamp(nearestIdx + direction, 0, ZOOM_STEPS.length - 1);
  return ZOOM_STEPS[nextIdx];
}

/**
 * 현재 보이는 서브 뷰포트 폭의 25%(step = 0.5 / zoom)만큼 방향 패닝 후 경계 클램핑한다.
 */
export function panViewport(
  state: ViewportState,
  dxDir: -1 | 0 | 1,
  dyDir: -1 | 0 | 1,
): ViewportState {
  const current = clampViewport(state.zoom, state.panX, state.panY);
  if (current.zoom <= 1.0001) {
    return { zoom: 1.0, panX: 0, panY: 0 };
  }
  const step = 0.5 / current.zoom;
  return clampViewport(
    current.zoom,
    current.panX + dxDir * step,
    current.panY + dyDir * step,
  );
}

/**
 * 렌더 모드에 따른 가상 픽셀 종횡비 보정 계수를 반환합니다.
 * - quadrant (2x2 subpixels in 1:2 physical cell): pixelAspectX = 2.0
 * - sextant (2x3 subpixels in 1:2 physical cell): pixelAspectX = 4/3
 * - half-block / braille / kitty / iterm2 / 기타: 1.0
 */
export function getModePixelAspect(
  renderMode: string
): { pixelAspectX: number; pixelAspectY: number } {
  switch (renderMode) {
    case 'quadrant':
      return { pixelAspectX: 2.0, pixelAspectY: 1.0 };
    case 'sextant':
      return { pixelAspectX: 4 / 3, pixelAspectY: 1.0 };
    default:
      return { pixelAspectX: 1.0, pixelAspectY: 1.0 };
  }
}

/**
 * 파일 경로 확장자 또는 원시 콘텐츠 헤더를 기반으로 벡터 포맷('svg' | 'lottie')을 판별합니다.
 */
export function detectVectorFormat(
  filePathOrHint: string,
  rawContent?: string
): 'svg' | 'lottie' {
  const lower = filePathOrHint.trim().toLowerCase();
  if (lower.endsWith('.svg')) return 'svg';
  if (lower.endsWith('.json')) return 'lottie';

  if (rawContent) {
    const trimmed = rawContent.trimStart();
    if (trimmed.startsWith('<')) return 'svg';
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'lottie';
  }

  return 'lottie';
}

function parseSvgLength(attrValue: string | undefined): number | null {
  if (!attrValue) return null;
  const trimmed = attrValue.trim();
  if (trimmed.endsWith('%')) return null;
  const match = trimmed.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt)?$/i);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (match[2]?.toLowerCase() === 'pt') {
    return num * (96 / 72);
  }
  return num;
}

function extractSvgAttr(attrs: string, name: string): string | undefined {
  const regex = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = attrs.match(regex);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

function stripSvgLayoutAttrs(attrs: string): string {
  return attrs.replace(/(?:^|\s)(?:width|height|viewBox)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

/** DOCTYPE(내부 서브셋 포함) 제거 정규식 — ThorVG XML 파서 오류 방지 */
const DOCTYPE_RE = /<!DOCTYPE[^\[>]*(?:\[[\s\S]*?\]\s*)?>/gi;

function parseSvgMeta(rawContent: string): CachedSvgMeta | null {
  const cached = getLru(svgParseCache, rawContent);
  if (cached !== undefined) {
    return cached;
  }

  // Remove DOCTYPE/DTD declarations to prevent ThorVG XML parser errors
  const sanitized = rawContent.replace(DOCTYPE_RE, '');

  // 주석 안의 `<svg`를 루트로 오인하지 않도록 같은 길이의 공백으로 마스킹한 사본에서 위치를 찾는다
  const masked = sanitized.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  const openMatch = masked.match(/<svg\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/i);
  if (!openMatch || openMatch.index === undefined) {
    setLru(svgParseCache, rawContent, null, MAX_SVG_CACHE_ENTRIES);
    return null;
  }

  const rawAttrs = openMatch[1];
  if (rawAttrs.trimEnd().endsWith('/')) {
    setLru(svgParseCache, rawContent, null, MAX_SVG_CACHE_ENTRIES);
    return null;
  }

  // Locate closing </svg> tag (case-insensitive, last occurrence)
  const closeMatches = [...masked.matchAll(/<\/svg\s*>/gi)];
  if (closeMatches.length === 0) {
    setLru(svgParseCache, rawContent, null, MAX_SVG_CACHE_ENTRIES);
    return null;
  }
  const lastClose = closeMatches[closeMatches.length - 1];
  const closeIdx = lastClose.index;
  if (closeIdx === undefined || closeIdx <= openMatch.index + openMatch[0].length) {
    setLru(svgParseCache, rawContent, null, MAX_SVG_CACHE_ENTRIES);
    return null;
  }

  // Extract viewBox (priority 1) or width/height (priority 2)
  let vx = 0;
  let vy = 0;
  let vw = 0;
  let vh = 0;

  const viewBoxRaw = extractSvgAttr(rawAttrs, 'viewBox');
  if (viewBoxRaw) {
    const nums = viewBoxRaw
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (nums.length === 4 && nums.every(Number.isFinite)) {
      [vx, vy, vw, vh] = nums;
    }
  }

  if (!(vw > 0 && vh > 0)) {
    const w = parseSvgLength(extractSvgAttr(rawAttrs, 'width'));
    const h = parseSvgLength(extractSvgAttr(rawAttrs, 'height'));
    if (w !== null && h !== null) {
      vx = 0;
      vy = 0;
      vw = w;
      vh = h;
    }
  }

  if (!(vw > 0 && vh > 0)) {
    setLru(svgParseCache, rawContent, null, MAX_SVG_CACHE_ENTRIES);
    return null;
  }

  const meta: CachedSvgMeta = {
    vx,
    vy,
    vw,
    vh,
    preservedAttrs: stripSvgLayoutAttrs(rawAttrs),
    prefix: sanitized.slice(0, openMatch.index),
    innerBody: sanitized.slice(openMatch.index + openMatch[0].length, closeIdx),
    suffix: sanitized.slice(closeIdx),
  };
  setLru(svgParseCache, rawContent, meta, MAX_SVG_CACHE_ENTRIES);
  return meta;
}

function preprocessSvg(
  rawContent: string,
  sx: number,
  sy: number,
  zoom: number,
  panX: number,
  panY: number
): string {
  const meta = parseSvgMeta(rawContent);
  if (!meta) {
    return rawContent;
  }

  const { vx, vy, vw, vh, preservedAttrs, prefix, innerBody, suffix } = meta;
  const subW = vw / zoom;
  const subH = vh / zoom;
  const cx = vx + (vw / 2) * (1 + panX);
  const cy = vy + (vh / 2) * (1 + panY);
  const subX = cx - subW / 2;
  const subY = cy - subH / 2;

  const outW = subW * sx;
  const outH = subH * sy;

  const newOpenTag = `<svg${preservedAttrs} width="${outW}" height="${outH}" viewBox="0 0 ${outW} ${outH}">`;
  const transformAttr =
    subX !== 0 || subY !== 0
      ? `scale(${sx}, ${sy}) translate(${-subX}, ${-subY})`
      : `scale(${sx}, ${sy})`;

  return `${prefix}${newOpenTag}<g transform="${transformAttr}">${innerBody}</g>${suffix}`;
}

function resolveUniquePrecompId(existingAssets: any[]): string {
  const existingIds = new Set<string>();
  for (const asset of existingAssets) {
    if (asset && typeof asset.id === 'string') {
      existingIds.add(asset.id);
    }
  }
  const base = '__termvg_root_comp__';
  if (!existingIds.has(base)) return base;

  let suffix = 1;
  while (existingIds.has(`__termvg_root_comp_${suffix}__`)) {
    suffix++;
  }
  return `__termvg_root_comp_${suffix}__`;
}

function parseLottieAst(rawContent: string): CachedLottieAst | null {
  const cached = getLru(lottieAstCache, rawContent);
  if (cached !== undefined) {
    return cached;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    setLru(lottieAstCache, rawContent, null, MAX_LOTTIE_CACHE_ENTRIES);
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray(parsed.layers) ||
    !(Number(parsed.w) > 0) ||
    !(Number(parsed.h) > 0)
  ) {
    setLru(lottieAstCache, rawContent, null, MAX_LOTTIE_CACHE_ENTRIES);
    return null;
  }

  const origW = Number(parsed.w);
  const origH = Number(parsed.h);
  const existingAssets = Array.isArray(parsed.assets) ? parsed.assets : [];
  const precompId = resolveUniquePrecompId(existingAssets);

  const precompAsset: Record<string, any> = {
    id: precompId,
    nm: 'TermVGRootComp',
    layers: parsed.layers,
  };
  if (parsed.fr !== undefined) {
    precompAsset.fr = parsed.fr;
  }

  const ast: CachedLottieAst = {
    origW,
    origH,
    precompId,
    ip: parsed.ip ?? 0,
    op: parsed.op ?? 99999,
    baseTemplate: {
      ...parsed,
      assets: [...existingAssets, precompAsset],
    },
  };
  setLru(lottieAstCache, rawContent, ast, MAX_LOTTIE_CACHE_ENTRIES);
  return ast;
}

function preprocessLottie(
  rawContent: string,
  sx: number,
  sy: number,
  zoom: number,
  panX: number,
  panY: number
): string {
  const ast = parseLottieAst(rawContent);
  if (!ast) {
    return rawContent;
  }

  const { origW, origH, precompId, ip, op, baseTemplate } = ast;
  const outW = Math.max(1, Math.round(origW * sx));
  const outH = Math.max(1, Math.round(origH * sy));

  const anchorX = (origW / 2) * (1 + panX);
  const anchorY = (origH / 2) * (1 + panY);

  const wrapperLayer = {
    ddd: 0,
    ind: 1,
    ty: 0,
    nm: 'TermVGTransformWrapper',
    refId: precompId,
    sr: 1,
    ks: {
      o: { a: 0, k: 100 },
      r: { a: 0, k: 0 },
      p: { a: 0, k: [outW / 2, outH / 2, 0] },
      a: { a: 0, k: [anchorX, anchorY, 0] },
      s: { a: 0, k: [sx * zoom * 100, sy * zoom * 100, 100] },
    },
    ao: 0,
    w: origW,
    h: origH,
    ip,
    op,
    st: 0,
    bm: 0,
  };

  return JSON.stringify({
    ...baseTemplate,
    w: outW,
    h: outH,
    layers: [wrapperLayer],
  });
}

/**
 * 인메모리 SVG / Lottie JSON 문자열에 픽셀 종횡비 및 줌/패닝 변환을 적용합니다.
 * 항등 변환이거나 유효하지 않은 입력일 경우 원본 참조를 그대로 반환합니다(단 SVG DOCTYPE은 제거).
 */
export function preprocessVectorData(
  rawContent: string,
  format: 'svg' | 'lottie',
  options?: VectorTransformOptions
): string {
  if (!rawContent) return rawContent;

  const sx = options?.pixelAspectX ?? 1;
  const sy = options?.pixelAspectY ?? 1;
  const rawZoom = options?.zoom ?? 1;
  const rawPanX = options?.panX ?? 0;
  const rawPanY = options?.panY ?? 0;

  if (
    !Number.isFinite(sx) ||
    !Number.isFinite(sy) ||
    !Number.isFinite(rawZoom) ||
    !Number.isFinite(rawPanX) ||
    !Number.isFinite(rawPanY) ||
    sx <= 0 ||
    sy <= 0 ||
    rawZoom <= 0
  ) {
    return rawContent;
  }

  const { zoom, panX, panY } = clampViewport(rawZoom, rawPanX, rawPanY);

  if (
    Math.abs(sx - 1) < EPSILON &&
    Math.abs(sy - 1) < EPSILON &&
    zoom <= 1.0001
  ) {
    // 항등 변환이어도 SVG DOCTYPE은 제거해 변환 여부와 무관하게 로드 결과를 일관되게 유지
    return format === 'svg' ? rawContent.replace(DOCTYPE_RE, '') : rawContent;
  }

  if (format === 'svg') {
    return preprocessSvg(rawContent, sx, sy, zoom, panX, panY);
  }
  return preprocessLottie(rawContent, sx, sy, zoom, panX, panY);
}
