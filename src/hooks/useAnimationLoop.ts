import fs from 'fs';
import { useRef, useEffect, useCallback, useMemo } from 'react';
import {
  preprocessVectorData,
  detectVectorFormat,
  type VectorTransformOptions,
} from '../utils/vectorPreprocessor.js';
import { remapPureBlackForeground } from '../utils/ansiPostProcessor.js';
import { extractDotLottie, isZipMagicBytes } from '../loaders/dotLottieReader.js';
import type { LoadedVectorAsset } from '../loaders/assetLoader.js';

export interface ClampedPixelSize {
  width: number;
  height: number;
}

/**
 * 초소형 터미널이나 홀수 해상도가 WASM setSize(uint32_t)에 전달되어
 * 언더플로우나 행 잘림이 발생하지 않도록 최소 크기(16x8) 및 짝수 정렬을 보장한다.
 */
export function clampEvenPixelSize(
  rawWidth: number,
  rawHeight: number,
  minWidth = 16,
  minHeight = 8,
): ClampedPixelSize {
  const safeMinW = Number.isFinite(minWidth)
    ? Math.max(2, Math.floor(minWidth) + (Math.floor(minWidth) % 2))
    : 16;
  const safeMinH = Number.isFinite(minHeight)
    ? Math.max(2, Math.floor(minHeight) + (Math.floor(minHeight) % 2))
    : 8;

  const finiteW = Number.isFinite(rawWidth) ? Math.floor(rawWidth) : safeMinW;
  const finiteH = Number.isFinite(rawHeight) ? Math.floor(rawHeight) : safeMinH;

  const clampedW = Math.max(safeMinW, finiteW);
  const clampedH = Math.max(safeMinH, finiteH);

  return {
    width: clampedW % 2 === 0 ? clampedW : clampedW + 1,
    height: clampedH % 2 === 0 ? clampedH : clampedH + 1,
  };
}

/**
 * Wall-Clock 기반 경과 시간(초) 계산.
 * - 0 < rawDt <= 0.5s: 렌더링 지연을 실제 경과 시간 그대로 반영하여 슬로우 모션 방지
 * - rawDt > 0.5s: 탭 전환·절전 복귀 등 비정상 스파이크 시 0.1s로 클램핑
 */
export function computeWallClockDeltaSec(
  lastMs: number | null,
  nowMs: number,
  fallbackDt = 1 / 30,
): number {
  if (lastMs === null) return fallbackDt;
  const rawDt = (nowMs - lastMs) / 1000;
  if (!Number.isFinite(rawDt) || rawDt <= 0) return 0;
  return rawDt > 0.5 ? 0.1 : rawDt;
}

export interface AnimationConfig {
  wasmModule: any;
  filePath: string;
  pixelWidth: number;
  pixelHeight: number;
  modeInt: number;
  invertDark: boolean;
  transformOptions?: VectorTransformOptions;
  /** 커스텀 에셋 로더 (미지정 시 rawFileCache + loadContent 또는 load 폴백) */
  loadAsset?: () => boolean;
  /** 커스텀 프레임 렌더러 (미지정 시 wasmModule.renderToString 호출) */
  renderFrame?: (frameIndex: number) => string;
  /** 외부 렌더 옵션(배경 프리셋 등) 변경 감지 키 */
  renderOptionKey?: string;
  /** 재생 배속 (기본값: 1.0) */
  speed?: number;
  /** 역재생 여부 (기본값: false) */
  reverse?: boolean;
  /** 마커 구간 반복 범위 [startFrame, endFrame) */
  segmentRange?: [number, number] | null;
  /** Hot Reload 버전 카운터 */
  reloadVersion?: number;
  /** Hot Reload 등에서 디스크 재읽기 없이 주입할 원시 벡터 문자열 */
  rawContentOverride?: string;
  /** 통합 에셋 로더(URL / stdin / .lottie)를 통해 사전 적재된 벡터 에셋 */
  loadedAsset?: LoadedVectorAsset;
  loop: boolean;
  paused: boolean;
  onLoad?: (duration: number, totalFrames: number, isStatic?: boolean) => void;
  onComplete?: () => void;
  /** ANSI 문자열이 실제로 변경되었을 때만 호출 (중복 React 리렌더 차단) */
  onFrame: (ansiString: string, frame: number, totalFrames: number, fps: number) => void;
  /** 프레임 인덱스·FPS·정적 상태 변경 시 호출 (경량 헤더 메타 갱신) */
  onMetaUpdate?: (frame: number, totalFrames: number, fps: number, isStatic: boolean) => void;
}

export interface AnimationControls {
  pause: () => void;
  resume: () => void;
  seek: (delta: number) => void;
  seekToFrame: (targetFrame: number) => void;
  isStatic: () => boolean;
}

function resolveSegmentBounds(
  segmentRange: [number, number] | null | undefined,
  totalFrames: number,
): { segStart: number; segEnd: number } {
  const safeTotal = Math.max(1, totalFrames);
  if (!segmentRange) {
    return { segStart: 0, segEnd: safeTotal };
  }
  const rawStart = Number.isFinite(segmentRange[0]) ? Math.floor(segmentRange[0]) : 0;
  const rawEnd = Number.isFinite(segmentRange[1]) ? Math.ceil(segmentRange[1]) : safeTotal;
  const segStart = Math.max(0, Math.min(safeTotal - 1, rawStart));
  const segEnd = Math.max(segStart + 1, Math.min(safeTotal, rawEnd));
  return { segStart, segEnd };
}

const TARGET_FPS = 30;
const FRAME_DELAY_MS = 1000 / TARGET_FPS;

/**
 * 애니메이션 루프 + Wall-Clock 동기화 + 정적 SVG 유휴화 + 프레임 보존 소프트 리사이즈 통합 훅.
 */
export function useAnimationLoop(config: AnimationConfig): AnimationControls {
  // Stale Closure 방지: config를 ref로 항상 최신 유지
  const configRef = useRef(config);
  configRef.current = config;

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fpsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentFrameRef = useRef(0);
  const totalFramesRef = useRef(1);
  const durationRef = useRef(0);
  const isStaticRef = useRef(false);
  const lastTimestampRef = useRef<number | null>(null);

  const prevFrameRef = useRef<string | null>(null);
  const prevReportedFrameRef = useRef<number>(-1);
  const prevReportedFpsRef = useRef<number>(-1);
  const prevReportedStaticRef = useRef<boolean | null>(null);

  const prevFilePathRef = useRef('');
  const prevReloadVersionRef = useRef(0);
  const pendingSeekRef = useRef<number | null>(null);
  const setupSeqRef = useRef(0);
  const rawFileCacheRef = useRef<{
    filePath: string;
    reloadVersion: number;
    raw: string;
    format: 'svg' | 'lottie';
  } | null>(null);

  const fpsCountRef = useRef(0);
  const fpsValueRef = useRef(0);
  const setupDoneRef = useRef(false);

  const clampedSize = useMemo(
    () => clampEvenPixelSize(config.pixelWidth, config.pixelHeight),
    [config.pixelWidth, config.pixelHeight],
  );

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    lastTimestampRef.current = null;
  }, []);

  const stopFpsTimer = useCallback(() => {
    if (fpsTimerRef.current !== null) {
      clearInterval(fpsTimerRef.current);
      fpsTimerRef.current = null;
    }
  }, []);

  const stopCompletionTimer = useCallback(() => {
    if (completionTimerRef.current !== null) {
      clearTimeout(completionTimerRef.current);
      completionTimerRef.current = null;
    }
  }, []);

  const stopAllTimers = useCallback(() => {
    stopTimer();
    stopFpsTimer();
    stopCompletionTimer();
  }, [stopTimer, stopFpsTimer, stopCompletionTimer]);

  /**
   * 현재 프레임 렌더링 (재생/시크/정적/리사이즈 공용)
   * ANSI 문자열이 변했을 때만 onFrame 호출, 메타 변경 시에만 onMetaUpdate 호출
   */
  const renderCurrentFrame = useCallback((force = false) => {
    const cfg = configRef.current;
    const total = totalFramesRef.current;
    const safeFrameIdx = Math.max(0, Math.min(total - 1, Math.floor(currentFrameRef.current)));

    const ansiString = cfg.renderFrame
      ? cfg.renderFrame(safeFrameIdx)
      : cfg.wasmModule.renderToString(safeFrameIdx, cfg.modeInt, cfg.invertDark);

    fpsCountRef.current++;

    const ansiChanged =
      force || prevFrameRef.current === null || ansiString !== prevFrameRef.current;

    if (ansiChanged) {
      prevFrameRef.current = ansiString;
      cfg.onFrame(ansiString, safeFrameIdx, total, fpsValueRef.current);
    }

    const metaChanged =
      safeFrameIdx !== prevReportedFrameRef.current ||
      fpsValueRef.current !== prevReportedFpsRef.current ||
      isStaticRef.current !== prevReportedStaticRef.current;

    if (metaChanged) {
      prevReportedFrameRef.current = safeFrameIdx;
      prevReportedFpsRef.current = fpsValueRef.current;
      prevReportedStaticRef.current = isStaticRef.current;
      cfg.onMetaUpdate?.(safeFrameIdx, total, fpsValueRef.current, isStaticRef.current);
    }
  }, []);

  const startFpsTimer = useCallback(() => {
    if (fpsTimerRef.current !== null || isStaticRef.current) return;
    fpsTimerRef.current = setInterval(() => {
      const nextFps = fpsCountRef.current;
      fpsCountRef.current = 0;
      if (nextFps !== fpsValueRef.current) {
        fpsValueRef.current = nextFps;
        const safeFrameIdx = Math.max(
          0,
          Math.min(totalFramesRef.current - 1, Math.floor(currentFrameRef.current)),
        );
        if (
          safeFrameIdx !== prevReportedFrameRef.current ||
          nextFps !== prevReportedFpsRef.current ||
          isStaticRef.current !== prevReportedStaticRef.current
        ) {
          prevReportedFrameRef.current = safeFrameIdx;
          prevReportedFpsRef.current = nextFps;
          prevReportedStaticRef.current = isStaticRef.current;
          configRef.current.onMetaUpdate?.(
            safeFrameIdx,
            totalFramesRef.current,
            nextFps,
            isStaticRef.current,
          );
        }
      }
    }, 1000);
  }, []);

  const startTimer = useCallback(() => {
    if (timerRef.current !== null || isStaticRef.current) return;
    if (lastTimestampRef.current === null) {
      lastTimestampRef.current = performance.now();
    }

    timerRef.current = setInterval(() => {
      try {
        tick();
      } catch {
        stopAllTimers();
        configRef.current.onFrame('Failed to render frame', 0, 1, 0);
      }
    }, FRAME_DELAY_MS);

    function tick() {
      const cfg = configRef.current;
      const totalFrames = totalFramesRef.current;
      const duration = durationRef.current;

      const now = performance.now();
      const dt = computeWallClockDeltaSec(lastTimestampRef.current, now);
      lastTimestampRef.current = now;

      if (duration > 0 && totalFrames > 0) {
        const speed =
          typeof cfg.speed === 'number' && Number.isFinite(cfg.speed) && cfg.speed > 0
            ? Math.max(0.1, cfg.speed)
            : 1.0;
        const reverse = Boolean(cfg.reverse);
        const { segStart, segEnd } = resolveSegmentBounds(cfg.segmentRange, totalFrames);
        const span = Math.max(1, segEnd - segStart);
        const delta = dt * (totalFrames / duration) * speed;

        if (!reverse) {
          currentFrameRef.current += delta;
          if (currentFrameRef.current >= segEnd) {
            if (cfg.loop) {
              currentFrameRef.current = segStart + ((currentFrameRef.current - segStart) % span);
            } else {
              currentFrameRef.current = segEnd - 1;
              renderCurrentFrame(false);
              stopAllTimers();
              cfg.onComplete?.();
              return;
            }
          }
        } else {
          currentFrameRef.current -= delta;
          if (currentFrameRef.current < segStart) {
            if (cfg.loop) {
              currentFrameRef.current = segEnd - 1;
            } else {
              currentFrameRef.current = segStart;
              renderCurrentFrame(false);
              stopAllTimers();
              cfg.onComplete?.();
              return;
            }
          }
        }
      }

      renderCurrentFrame(false);
    }
  }, [renderCurrentFrame, stopAllTimers]);

  // 초기 설정 및 해상도/렌더 모드/벡터 변환 변경 시 프레임 보존 소프트 리사이즈
  useEffect(() => {
    let cancelled = false;
    const seq = ++setupSeqRef.current;

    const setup = async () => {
      const cfg = configRef.current;
      try {
        await cfg.wasmModule.init();
      } catch {
        if (cancelled || seq !== setupSeqRef.current) return;
        prevFilePathRef.current = '';
        prevFrameRef.current = null;
        isStaticRef.current = false;
        cfg.onFrame('Failed to load file', 0, 1, 0);
        return;
      }

      if (cancelled || seq !== setupSeqRef.current) return;

      cfg.wasmModule.setSize(clampedSize.width, clampedSize.height);

      const reloadVersion = cfg.reloadVersion ?? 0;
      const oldTotalFrames = totalFramesRef.current;
      const oldCurrentFrame = currentFrameRef.current;

      let loaded = false;
      if (cfg.loadAsset) {
        loaded = cfg.loadAsset();
      } else if (typeof cfg.wasmModule.loadContent === 'function') {
        try {
          if (
            !rawFileCacheRef.current ||
            rawFileCacheRef.current.filePath !== cfg.filePath ||
            rawFileCacheRef.current.reloadVersion !== reloadVersion
          ) {
            let source: string;
            let format: 'svg' | 'lottie';
            if (cfg.rawContentOverride !== undefined) {
              source = cfg.rawContentOverride;
              format = detectVectorFormat(cfg.filePath, source);
            } else if (cfg.loadedAsset) {
              source = cfg.loadedAsset.content;
              format = cfg.loadedAsset.format;
            } else {
              const fileBuffer = fs.readFileSync(cfg.filePath);
              if (cfg.filePath.toLowerCase().endsWith('.lottie') || isZipMagicBytes(fileBuffer)) {
                source = extractDotLottie(fileBuffer).content;
                format = 'lottie';
              } else {
                source = fileBuffer.toString('utf8');
                if (source.charCodeAt(0) === 0xfeff) {
                  source = source.slice(1);
                }
                format = detectVectorFormat(cfg.filePath, source);
              }
            }
            // 순수 검정 도형이 WASM 크로마키(0;0;0)와 겹쳐 사라지지 않도록 근접 검정으로 치환
            const raw = remapPureBlackForeground(source, format);
            rawFileCacheRef.current = {
              filePath: cfg.filePath,
              reloadVersion,
              raw,
              format,
            };
          }
          const cached = rawFileCacheRef.current;
          const processed = preprocessVectorData(cached.raw, cached.format, cfg.transformOptions);
          loaded = cfg.wasmModule.loadContent(processed);
        } catch {
          loaded = false;
        }
      } else {
        loaded = cfg.wasmModule.load(cfg.filePath, cfg.transformOptions);
      }

      if (cancelled || seq !== setupSeqRef.current) return;

      if (!loaded) {
        prevFilePathRef.current = '';
        prevFrameRef.current = null;
        prevReportedFrameRef.current = -1;
        prevReportedFpsRef.current = -1;
        prevReportedStaticRef.current = null;
        isStaticRef.current = false;
        cfg.onFrame('Failed to load file', 0, 1, 0);
        return;
      }

      const rawTotalFrames = cfg.wasmModule.getTotalFrames();
      const duration = cfg.wasmModule.getDuration();
      const isStatic =
        !Number.isFinite(rawTotalFrames) ||
        !Number.isFinite(duration) ||
        rawTotalFrames <= 1 ||
        duration <= 0;
      const totalFrames = isStatic ? 1 : Math.max(1, Math.floor(rawTotalFrames));

      const isSameFile = prevFilePathRef.current === cfg.filePath;
      const isHotReload = isSameFile && prevReloadVersionRef.current !== reloadVersion;
      prevFilePathRef.current = cfg.filePath;
      prevReloadVersionRef.current = reloadVersion;

      isStaticRef.current = isStatic;
      totalFramesRef.current = totalFrames;
      durationRef.current = duration;

      if (!isSameFile) {
        const { segStart } = resolveSegmentBounds(cfg.segmentRange, totalFrames);
        currentFrameRef.current = !isStatic && cfg.segmentRange ? segStart : 0;
        fpsCountRef.current = 0;
        fpsValueRef.current = 0;
        prevReportedFrameRef.current = -1;
        prevReportedFpsRef.current = -1;
        prevReportedStaticRef.current = null;
        cfg.onLoad?.(duration, totalFrames, isStatic);
      } else if (isHotReload) {
        // Hot Reload: 진행률(progressRatio) 보존 및 새 에셋 메타(총 프레임/길이) 갱신
        const progressRatio = oldTotalFrames > 0 ? oldCurrentFrame / oldTotalFrames : 0;
        currentFrameRef.current = isStatic
          ? 0
          : Math.min(Math.max(0, totalFrames - 1), progressRatio * totalFrames);
        prevReportedFrameRef.current = -1;
        prevReportedFpsRef.current = -1;
        prevReportedStaticRef.current = null;
        cfg.onLoad?.(duration, totalFrames, isStatic);
      } else {
        // Soft Resize / 모드 전환 시 기존 진행 프레임 인덱스 보존
        currentFrameRef.current = isStatic
          ? 0
          : Math.max(0, Math.min(currentFrameRef.current, totalFrames - 1));
      }

      if (!isStatic && pendingSeekRef.current !== null) {
        currentFrameRef.current = Math.max(0, Math.min(totalFrames - 1, pendingSeekRef.current));
        pendingSeekRef.current = null;
      }

      setupDoneRef.current = true;

      if (isStatic) {
        currentFrameRef.current = 0;
        fpsValueRef.current = 0;
        fpsCountRef.current = 0;
        renderCurrentFrame(true);

        // 단발 실행 CLI(SinglePlayer, loop=false)가 Ink 출력 플러시 후 걸리지 않고 정상 종료하도록 16ms 완료 콜백 예약
        if (!configRef.current.loop) {
          completionTimerRef.current = setTimeout(() => {
            if (!cancelled && seq === setupSeqRef.current) {
              configRef.current.onComplete?.();
            }
          }, 16);
        }
        return;
      }

      if (!configRef.current.paused) {
        lastTimestampRef.current = performance.now();
        renderCurrentFrame(true);
        startFpsTimer();
        startTimer();
      } else {
        lastTimestampRef.current = null;
        renderCurrentFrame(true);
      }
    };

    setup().catch(() => {
      if (cancelled || seq !== setupSeqRef.current) return;
      stopAllTimers();
      configRef.current.onFrame('Failed to load file', 0, 1, 0);
    });

    return () => {
      cancelled = true;
      stopAllTimers();
      prevFrameRef.current = null;
      setupDoneRef.current = false;
    };
  }, [
    config.wasmModule,
    config.filePath,
    clampedSize.width,
    clampedSize.height,
    config.modeInt,
    config.transformOptions?.pixelAspectX,
    config.transformOptions?.pixelAspectY,
    config.transformOptions?.zoom,
    config.transformOptions?.panX,
    config.transformOptions?.panY,
    config.reloadVersion,
    config.rawContentOverride,
    config.loadedAsset,
    renderCurrentFrame,
    startFpsTimer,
    startTimer,
    stopAllTimers,
  ]);

  // 정적/일시정지 상태에서 다크반전(D) 또는 외부 렌더 옵션(배경 프리셋 등) 변경 시 즉시 1회 재렌더
  useEffect(() => {
    if (!setupDoneRef.current) return;
    if (isStaticRef.current || configRef.current.paused) {
      renderCurrentFrame(true);
    }
  }, [config.invertDark, config.renderOptionKey, renderCurrentFrame]);

  const pause = useCallback(() => {
    stopTimer();
    stopFpsTimer();
  }, [stopTimer, stopFpsTimer]);

  const resume = useCallback(() => {
    if (!setupDoneRef.current || isStaticRef.current) return;
    // loop=false 완료 후 재개 시 즉시 재완료되지 않도록 시작 지점으로 되감기
    if (!configRef.current.loop) {
      const { segStart, segEnd } = resolveSegmentBounds(
        configRef.current.segmentRange,
        totalFramesRef.current,
      );
      if (!configRef.current.reverse && currentFrameRef.current >= segEnd - 1) {
        currentFrameRef.current = segStart;
      } else if (configRef.current.reverse && currentFrameRef.current <= segStart) {
        currentFrameRef.current = segEnd - 1;
      }
    }
    startFpsTimer();
    startTimer();
  }, [startFpsTimer, startTimer]);

  // segmentRange 활성 시 현재 프레임이 구간 바깥이면 구간 시작점으로 정렬
  useEffect(() => {
    if (!setupDoneRef.current || isStaticRef.current || !config.segmentRange) return;
    const { segStart, segEnd } = resolveSegmentBounds(
      config.segmentRange,
      totalFramesRef.current,
    );
    if (currentFrameRef.current < segStart || currentFrameRef.current >= segEnd) {
      currentFrameRef.current = segStart;
      renderCurrentFrame(false);
    }
  }, [config.segmentRange?.[0], config.segmentRange?.[1], renderCurrentFrame]);

  // config.paused prop 변화 직접 반영
  useEffect(() => {
    if (!setupDoneRef.current || isStaticRef.current) return;
    if (config.paused) {
      pause();
    } else {
      resume();
    }
  }, [config.paused, pause, resume]);

  const seek = useCallback(
    (delta: number) => {
      if (!setupDoneRef.current || isStaticRef.current) return;
      const totalFrames = totalFramesRef.current;
      const step = Math.max(1, totalFrames / TARGET_FPS);

      currentFrameRef.current += delta * step;
      if (currentFrameRef.current < 0) currentFrameRef.current = 0;
      if (currentFrameRef.current >= totalFrames) currentFrameRef.current = totalFrames - 1;

      renderCurrentFrame(false);
    },
    [renderCurrentFrame],
  );

  const seekToFrame = useCallback(
    (targetFrame: number) => {
      const safeRaw = Number.isFinite(targetFrame) ? Math.max(0, targetFrame) : 0;
      if (!setupDoneRef.current) {
        pendingSeekRef.current = safeRaw;
        return;
      }
      if (isStaticRef.current) return;
      const totalFrames = totalFramesRef.current;
      currentFrameRef.current = Math.max(0, Math.min(totalFrames - 1, safeRaw));
      renderCurrentFrame(false);
    },
    [renderCurrentFrame],
  );

  const isStatic = useCallback(() => isStaticRef.current, []);

  return useMemo(
    () => ({
      pause,
      resume,
      seek,
      seekToFrame,
      isStatic,
    }),
    [pause, resume, seek, seekToFrame, isStatic],
  );
}
