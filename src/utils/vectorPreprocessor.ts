/**
 * vectorPreprocessor.ts - 인메모리 SVG / Lottie JSON 비등방 종횡비 보정 전처리기
 *
 * - 프리빌트 termvg.wasm을 수정하지 않고 quadrant 모드(2x2 셀 내 1:2 물리 비율)의
 *   세로 2배 왜곡을 인메모리 논리 캔버스 사전 스케일링(pixelAspectX = 2.0)으로 보정
 * - Task 06(sextant: pixelAspectX = 4/3) 및 Task 08(zoom / panX / panY) 확장 계약 호환
 */

export interface VectorTransformOptions {
  /** 수평 가상 픽셀 보정 배율 (기본값: 1.0, quadrant: 2.0, sextant: 4/3) */
  pixelAspectX?: number;
  /** 수직 가상 픽셀 보정 배율 (기본값: 1.0) */
  pixelAspectY?: number;
  /** 무손실 벡터 줌 배율 슬롯 — Task 08 확장용 (기본값: 1.0) */
  zoom?: number;
  /** 정규화 수평 패닝 오프셋 [-1, 1] — Task 08 확장용 (기본값: 0.0) */
  panX?: number;
  /** 정규화 수직 패닝 오프셋 [-1, 1] — Task 08 확장용 (기본값: 0.0) */
  panY?: number;
}

const EPSILON = 1e-6;

function clamp(val: number, min: number, max: number): number {
  return val < min ? min : val > max ? max : val;
}

/**
 * 렌더 모드에 따른 가상 픽셀 종횡비 보정 계수를 반환합니다.
 * - quadrant (2x2 subpixels in 1:2 physical cell): pixelAspectX = 2.0
 * - sextant (2x3 subpixels in 1:2 physical cell): pixelAspectX = 4/3
 * - half-block / braille / 기타: 1.0
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

function preprocessSvg(
  rawContent: string,
  sx: number,
  sy: number,
  zoom: number,
  panX: number,
  panY: number
): string {
  // Remove DOCTYPE/DTD declarations to prevent ThorVG XML parser errors
  const sanitized = rawContent.replace(/<!DOCTYPE[\s\S]*?(?:\[[\s\S]*?\])?\s*>/gi, '');

  const openMatch = sanitized.match(/<svg\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/i);
  if (!openMatch || openMatch.index === undefined) {
    return rawContent;
  }

  const rawAttrs = openMatch[1];
  if (rawAttrs.trimEnd().endsWith('/')) {
    return rawContent; // Self-closing empty <svg />
  }

  // Locate closing </svg> tag (case-insensitive, last occurrence)
  const closeMatches = [...sanitized.matchAll(/<\/svg\s*>/gi)];
  if (closeMatches.length === 0) {
    return rawContent;
  }
  const lastClose = closeMatches[closeMatches.length - 1];
  const closeIdx = lastClose.index;
  if (closeIdx === undefined || closeIdx <= openMatch.index + openMatch[0].length) {
    return rawContent;
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
    return rawContent;
  }

  const subW = vw / zoom;
  const subH = vh / zoom;
  const maxPan = zoom > 1 ? 1 - 1 / zoom : 0;
  const cx = vx + vw / 2 + clamp(panX, -maxPan, maxPan) * (vw / 2);
  const cy = vy + vh / 2 + clamp(panY, -maxPan, maxPan) * (vh / 2);
  const subX = cx - subW / 2;
  const subY = cy - subH / 2;

  const outW = subW * sx;
  const outH = subH * sy;

  const preservedAttrs = stripSvgLayoutAttrs(rawAttrs);
  const newOpenTag = `<svg${preservedAttrs} width="${outW}" height="${outH}" viewBox="0 0 ${outW} ${outH}">`;
  const transformAttr =
    subX !== 0 || subY !== 0
      ? `scale(${sx}, ${sy}) translate(${-subX}, ${-subY})`
      : `scale(${sx}, ${sy})`;

  const prefix = sanitized.slice(0, openMatch.index);
  const innerBody = sanitized.slice(openMatch.index + openMatch[0].length, closeIdx);
  const suffix = sanitized.slice(closeIdx);

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

function preprocessLottie(
  rawContent: string,
  sx: number,
  sy: number,
  zoom: number,
  panX: number,
  panY: number
): string {
  let parsed: any;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return rawContent;
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray(parsed.layers) ||
    !(Number(parsed.w) > 0) ||
    !(Number(parsed.h) > 0)
  ) {
    return rawContent;
  }

  const origW = Number(parsed.w);
  const origH = Number(parsed.h);
  const outW = Math.max(1, Math.round(origW * sx));
  const outH = Math.max(1, Math.round(origH * sy));

  const maxPan = zoom > 1 ? 1 - 1 / zoom : 0;
  const anchorX = origW / 2 + clamp(panX, -maxPan, maxPan) * (origW / 2);
  const anchorY = origH / 2 + clamp(panY, -maxPan, maxPan) * (origH / 2);

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
    ip: parsed.ip ?? 0,
    op: parsed.op ?? 60,
    st: 0,
    bm: 0,
  };

  return JSON.stringify({
    ...parsed,
    w: outW,
    h: outH,
    assets: [...existingAssets, precompAsset],
    layers: [wrapperLayer],
  });
}

/**
 * 인메모리 SVG / Lottie JSON 문자열에 픽셀 종횡비 및 줌/패닝 변환을 적용합니다.
 * 항등 변환이거나 유효하지 않은 입력일 경우 원본 참조를 그대로 반환합니다.
 */
export function preprocessVectorData(
  rawContent: string,
  format: 'svg' | 'lottie',
  options?: VectorTransformOptions
): string {
  if (!rawContent) return rawContent;

  const sx = options?.pixelAspectX ?? 1;
  const sy = options?.pixelAspectY ?? 1;
  const zoom = options?.zoom ?? 1;
  const panX = options?.panX ?? 0;
  const panY = options?.panY ?? 0;

  if (
    !Number.isFinite(sx) ||
    !Number.isFinite(sy) ||
    !Number.isFinite(zoom) ||
    !Number.isFinite(panX) ||
    !Number.isFinite(panY) ||
    sx <= 0 ||
    sy <= 0 ||
    zoom <= 0
  ) {
    return rawContent;
  }

  if (
    Math.abs(sx - 1) < EPSILON &&
    Math.abs(sy - 1) < EPSILON &&
    Math.abs(zoom - 1) < EPSILON &&
    Math.abs(panX) < EPSILON &&
    Math.abs(panY) < EPSILON
  ) {
    return rawContent;
  }

  if (format === 'svg') {
    return preprocessSvg(rawContent, sx, sy, zoom, panX, panY);
  }
  return preprocessLottie(rawContent, sx, sy, zoom, panX, panY);
}
