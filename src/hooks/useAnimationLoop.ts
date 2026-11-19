import fs from 'fs';
import { useRef, useEffect, useCallback } from 'react';
import {
  preprocessVectorData,
  detectVectorFormat,
  type VectorTransformOptions,
} from '../utils/vectorPreprocessor.js';

interface AnimationConfig {
  wasmModule: any;
  filePath: string;
  pixelWidth: number;
  pixelHeight: number;
  modeInt: number;
  invertDark: boolean;
  transformOptions?: VectorTransformOptions;
  loop: boolean;
  paused: boolean;
  onLoad?: (duration: number, totalFrames: number) => void;
  onComplete?: () => void;
  onFrame: (ansiString: string, frame: number, totalFrames: number, fps: number) => void;
}

interface AnimationControls {
  pause: () => void;
  resume: () => void;
  seek: (delta: number) => void;
}

/**
 * 애니메이션 루프 + FPS 측정 + 재생 제어를 통합하는 커스텀 훅.
 *
 * - Stale Closure 방지: config를 ref에 저장하여 setInterval 콜백이 항상 최신 값 참조
 * - 원본 벡터 문자열 메모리 캐싱으로 렌더 모드(M) 전환 시 프레임 유지 및 즉시 종횡비 재보정
 * - FPS 측정: 1초 간격으로 렌더링된 프레임 수를 카운트
 */
export function useAnimationLoop(config: AnimationConfig): AnimationControls {
  // ─── Stale Closure 방지: config를 ref로 항상 최신 유지 ───
  const configRef = useRef(config);
  configRef.current = config;

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const fpsTimerRef = useRef<NodeJS.Timeout | null>(null);
  const currentFrameRef = useRef(0);
  const totalFramesRef = useRef(1);
  const durationRef = useRef(0);
  const prevFrameRef = useRef('');
  const prevFilePathRef = useRef('');
  const rawFileCacheRef = useRef<{
    filePath: string;
    raw: string;
    format: 'svg' | 'lottie';
  } | null>(null);
  const fpsCountRef = useRef(0);
  const fpsValueRef = useRef(0);
  const setupDoneRef = useRef(false);

  const TARGET_FPS = 30;
  const FRAME_DELAY_MS = 1000 / TARGET_FPS;

  /**
   * 프레임 렌더링 (재생/시크 공용)
   * configRef.current를 통해 항상 최신 onFrame, invertDark 등을 참조
   */
  const renderCurrentFrame = useCallback(() => {
    const cfg = configRef.current;
    const frame = currentFrameRef.current;
    const ansiString = cfg.wasmModule.renderToString(frame, cfg.modeInt, cfg.invertDark);

    if (ansiString !== prevFrameRef.current) {
      prevFrameRef.current = ansiString;
      cfg.onFrame(ansiString, frame, totalFramesRef.current, fpsValueRef.current);
    } else {
      // 프레임 내용이 동일하면 sync 불필요, 메타 정보만 갱신
      cfg.onFrame(ansiString, frame, totalFramesRef.current, fpsValueRef.current);
    }

    fpsCountRef.current++;
  }, []); // deps 없음: configRef를 통해 항상 최신 참조

  /** 프레임 진행 + 루프/완료 처리 */
  const advanceFrame = useCallback(() => {
    const totalFrames = totalFramesRef.current;
    const duration = durationRef.current;

    if (duration > 0) {
      currentFrameRef.current += totalFrames / (duration * TARGET_FPS);
      if (currentFrameRef.current >= totalFrames) {
        if (configRef.current.loop) {
          currentFrameRef.current = 0;
        } else {
          stopTimer();
          configRef.current.onComplete?.();
        }
      }
    }
  }, []); // deps 없음: configRef를 통해 항상 최신 참조

  const startTimer = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setInterval(() => {
      renderCurrentFrame();
      advanceFrame();
    }, FRAME_DELAY_MS);
  }, [renderCurrentFrame, advanceFrame]);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 초기 설정 및 렌더 모드/종횡비 전환 시 즉시 재보정 로드
  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      const cfg = configRef.current;
      await cfg.wasmModule.init();
      if (cancelled) return;

      cfg.wasmModule.setSize(cfg.pixelWidth, cfg.pixelHeight);

      let loaded = false;
      if (typeof cfg.wasmModule.loadContent === 'function') {
        try {
          if (!rawFileCacheRef.current || rawFileCacheRef.current.filePath !== cfg.filePath) {
            const raw = fs.readFileSync(cfg.filePath, 'utf8');
            const format = detectVectorFormat(cfg.filePath, raw);
            rawFileCacheRef.current = { filePath: cfg.filePath, raw, format };
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

      if (!loaded) {
        prevFilePathRef.current = '';
        cfg.onFrame('Failed to load file', 0, 1, 0);
        return;
      }

      const totalFrames = Math.max(1, cfg.wasmModule.getTotalFrames());
      const duration = cfg.wasmModule.getDuration();
      const isSameFile = prevFilePathRef.current === cfg.filePath;
      prevFilePathRef.current = cfg.filePath;

      totalFramesRef.current = totalFrames;
      durationRef.current = duration;
      if (!isSameFile) {
        currentFrameRef.current = 0;
        cfg.onLoad?.(duration, totalFrames);
      } else if (currentFrameRef.current >= totalFrames) {
        currentFrameRef.current = totalFrames - 1;
      }
      setupDoneRef.current = true;

      // FPS 카운터
      fpsTimerRef.current = setInterval(() => {
        fpsValueRef.current = fpsCountRef.current;
        fpsCountRef.current = 0;
      }, 1000);

      // paused 상태이거나 동일 파일 모드 전환 시 즉시 현재 프레임 재렌더
      if (configRef.current.paused) {
        renderCurrentFrame();
      } else {
        if (isSameFile) {
          renderCurrentFrame();
        }
        startTimer();
      }
    };

    setup();

    return () => {
      cancelled = true;
      stopTimer();
      if (fpsTimerRef.current) clearInterval(fpsTimerRef.current);
      fpsTimerRef.current = null;
      prevFrameRef.current = '';
      setupDoneRef.current = false;
    };
  }, [
    config.wasmModule,
    config.filePath,
    config.pixelWidth,
    config.pixelHeight,
    config.modeInt,
    config.transformOptions?.pixelAspectX,
    config.transformOptions?.pixelAspectY,
  ]);

  // 외부 제어 API
  const controls: AnimationControls = {
    pause: () => stopTimer(),
    resume: () => {
      if (setupDoneRef.current) startTimer();
    },
    seek: (delta: number) => {
      if (!setupDoneRef.current) return;
      const totalFrames = totalFramesRef.current;
      const step = totalFrames / TARGET_FPS;

      currentFrameRef.current += delta * step;
      if (currentFrameRef.current < 0) currentFrameRef.current = 0;
      if (currentFrameRef.current >= totalFrames) currentFrameRef.current = totalFrames - 1;

      renderCurrentFrame();
    }
  };

  return controls;
}
