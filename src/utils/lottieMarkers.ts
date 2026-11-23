export interface LottieMarker {
  name: string;
  time: number;
  duration: number;
  endFrame: number;
}

export const PLAYBACK_SPEEDS = [0.25, 0.5, 1.0, 1.5, 2.0] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/**
 * 정렬된 이산 프리셋 배열에서 현재 값에 가장 가까운 항목을 기준으로 한 단계(-1/+1) 이동한다.
 */
export function stepDiscretePreset<T extends number>(
  steps: readonly T[],
  current: number,
  direction: 1 | -1,
  defaultValue: T,
): T {
  const safe = Number.isFinite(current) ? current : defaultValue;
  let nearestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < steps.length; i++) {
    const diff = Math.abs(steps[i] - safe);
    if (diff < bestDiff) {
      bestDiff = diff;
      nearestIdx = i;
    }
  }
  return steps[Math.max(0, Math.min(steps.length - 1, nearestIdx + direction))];
}

/**
 * PLAYBACK_SPEEDS 목록([0.25, 0.5, 1.0, 1.5, 2.0])에서 배속을 한 단계 감소(-1) 또는 증가(+1)한다.
 */
export function stepPlaybackSpeed(current: number, direction: 1 | -1): PlaybackSpeed {
  return stepDiscretePreset(PLAYBACK_SPEEDS, current, direction, 1.0);
}

/**
 * Lottie JSON(문자열 또는 파싱된 객체)에서 Named Markers 배열을 추출·정규화·시간순 정렬한다.
 * SVG 등 비-Lottie 입력이나 마커 미존재 시 빈 배열을 안전하게 반환한다.
 */
export function parseLottieMarkers(
  source: string | Record<string, unknown>,
  totalFrames?: number,
): LottieMarker[] {
  let obj: unknown = source;
  if (typeof source === 'string') {
    const trimmed = source.trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return [];
    }
    try {
      obj = JSON.parse(source);
    } catch {
      return [];
    }
  }

  if (!obj || typeof obj !== 'object') {
    return [];
  }

  const rawMarkers = (obj as Record<string, unknown>).markers;
  if (!Array.isArray(rawMarkers) || rawMarkers.length === 0) {
    return [];
  }

  const hasLimit =
    typeof totalFrames === 'number' && Number.isFinite(totalFrames) && totalFrames > 0;
  const maxFrame = hasLimit ? Math.max(0, totalFrames - 1) : Infinity;

  const parsed: LottieMarker[] = [];
  for (let idx = 0; idx < rawMarkers.length; idx++) {
    const item = rawMarkers[idx];
    if (!item || typeof item !== 'object') continue;

    const record = item as Record<string, unknown>;
    if (typeof record.tm !== 'number' || !Number.isFinite(record.tm)) continue;

    const rawName = String(record.cm ?? '')
      .replace(/[\r\n]+/g, '')
      .trim();
    const name = rawName || `marker_${idx + 1}`;
    const time = Math.min(Math.max(0, record.tm), maxFrame);
    const rawDr = typeof record.dr === 'number' && Number.isFinite(record.dr) ? record.dr : 0;
    const duration = Math.max(0, rawDr);
    const endFrame = hasLimit ? Math.min(totalFrames, time + duration) : time + duration;

    parsed.push({ name, time, duration, endFrame });
  }

  parsed.sort((a, b) => a.time - b.time);
  return parsed;
}

/**
 * 현재 프레임 위치에 해당하는 활성 마커를 반환한다.
 */
export function findActiveMarker(
  markers: readonly LottieMarker[],
  currentFrame: number,
): LottieMarker | null {
  if (markers.length === 0 || !Number.isFinite(currentFrame)) {
    return null;
  }

  // 구간 마커(duration > 0) 우선 매칭 (중첩 시 가장 늦게 시작한 구간 우선)
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i];
    if (m.duration > 0 && currentFrame >= m.time && currentFrame < m.endFrame) {
      return m;
    }
  }

  // 점 마커(duration === 0)는 직전 통과 마커(다음 마커 시작 전까지) 반환
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i];
    if (m.time <= currentFrame) {
      return m.duration === 0 ? m : null;
    }
  }

  return null;
}

/**
 * 현재 프레임 이후의 다음 마커(마지막 마커 이후에는 첫 마커로 순환)를 반환한다.
 */
export function getNextMarker(
  markers: readonly LottieMarker[],
  currentFrame: number,
): { marker: LottieMarker; index: number } | null {
  if (markers.length === 0) {
    return null;
  }

  const cur = Number.isFinite(currentFrame) ? Math.floor(currentFrame) : 0;
  for (let i = 0; i < markers.length; i++) {
    if (Math.floor(markers[i].time) > cur) {
      return { marker: markers[i], index: i };
    }
  }

  return { marker: markers[0], index: 0 };
}
