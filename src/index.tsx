#!/usr/bin/env node
import React, { useEffect } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { render, Box, useApp } from 'ink';
import meow from 'meow';
import open from 'open';
import { InteractiveMenu } from './InteractiveMenu.js';
import {
  calcPixelSize,
  LottiePlayer,
  type EffectiveRenderMode,
} from './LottiePlayer.js';
import { realWasmModule } from './realWasmModule.js';
import { createSyncStdout } from './utils/syncOutput.js';
import { clampEvenPixelSize } from './hooks/useAnimationLoop.js';
import {
  getModePixelAspect,
  preprocessVectorData,
  remapPureBlackForeground,
} from './utils/vectorPreprocessor.js';
import {
  postProcessAnsiFrame,
  type BackgroundPreset,
} from './utils/ansiPostProcessor.js';
import {
  isUrlInput,
  loadVectorAsset,
  type LoadedVectorAsset,
} from './loaders/assetLoader.js';
import { detectTerminalProtocol } from './renderers/protocolDetector.js';
import {
  applyBackgroundPresetToPixels,
  WasmPixelExtractor,
} from './renderers/pixelExtractor.js';
import { renderPixelsToSextant } from './renderers/sextantRenderer.js';
import { encodeKittyGraphics } from './renderers/kittyRenderer.js';
import { encodeIterm2Graphics } from './renderers/iterm2Renderer.js';
import { runInspectCli } from './cli/inspectCommand.js';
import { runExportCli } from './cli/exportCommand.js';
import {
  installMcpStdioGuard,
  runMcpServerStdio,
} from './mcp/termvgMcpServer.js';

export type PlayModeFlag =
  | 'auto'
  | 'kitty'
  | 'iterm2'
  | 'sextant'
  | 'quadrant'
  | 'braille'
  | 'half-block';

export interface ValidatedPlayOptions {
  renderMode: EffectiveRenderMode;
  loop: boolean;
  speed: number;
  backgroundPreset: BackgroundPreset;
  invertDark: boolean;
  width?: number;
  height?: number;
  subAnimationId?: string;
}

export class CliValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliValidationError';
  }
}

const VALID_PLAY_MODES = new Set<string>([
  'auto',
  'kitty',
  'iterm2',
  'sextant',
  'quadrant',
  'braille',
  'half-block',
]);
const VALID_BG_PRESETS = new Set<string>(['transparent', 'dark', 'light', 'checkerboard']);

/**
 * `termvg play` 플래그를 검증하고 `--mode auto`를 환경에 맞는 실제 렌더 모드로 해석한다.
 * 잘못된 플래그 입력 시 `CliValidationError`를 던져 종료 코드 2로 매핑한다.
 */
export function parseAndValidatePlayFlags(
  flags: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): ValidatedPlayOptions {
  const modeRaw = flags.mode ?? 'auto';
  if (typeof modeRaw !== 'string' || !VALID_PLAY_MODES.has(modeRaw)) {
    throw new CliValidationError(
      `Error: Invalid --mode "${String(modeRaw)}". Allowed: auto, kitty, iterm2, sextant, quadrant, braille, half-block.`,
    );
  }

  let renderMode: EffectiveRenderMode;
  if (modeRaw === 'auto') {
    const detected = detectTerminalProtocol(env);
    renderMode =
      detected === 'kitty' ? 'kitty' : detected === 'iterm2' ? 'iterm2' : 'quadrant';
  } else {
    renderMode = modeRaw as EffectiveRenderMode;
  }

  let speed = 1.0;
  if (flags.speed !== undefined) {
    if (typeof flags.speed !== 'number' || !Number.isFinite(flags.speed) || flags.speed <= 0) {
      throw new CliValidationError('Error: --speed must be a positive number (e.g. 0.5, 1.5, 2).');
    }
    speed = flags.speed;
  }

  const bgRaw = flags.bg ?? 'transparent';
  if (typeof bgRaw !== 'string' || !VALID_BG_PRESETS.has(bgRaw)) {
    throw new CliValidationError(
      `Error: Invalid --bg "${String(bgRaw)}". Allowed: transparent, dark, light, checkerboard.`,
    );
  }
  const backgroundPreset = bgRaw as BackgroundPreset;

  let width: number | undefined;
  if (flags.width !== undefined) {
    if (
      typeof flags.width !== 'number' ||
      !Number.isInteger(flags.width) ||
      flags.width < 1
    ) {
      throw new CliValidationError('Error: --width must be a positive integer.');
    }
    width = flags.width;
  }

  let height: number | undefined;
  if (flags.height !== undefined) {
    if (
      typeof flags.height !== 'number' ||
      !Number.isInteger(flags.height) ||
      flags.height < 1
    ) {
      throw new CliValidationError('Error: --height must be a positive integer.');
    }
    height = flags.height;
  }

  let subAnimationId: string | undefined;
  if (flags.anim !== undefined) {
    if (typeof flags.anim !== 'string' || !flags.anim.trim()) {
      throw new CliValidationError('Error: --anim must be a non-empty animation ID.');
    }
    subAnimationId = flags.anim.trim();
  }

  return {
    renderMode,
    loop: Boolean(flags.loop),
    speed,
    backgroundPreset,
    invertDark: Boolean(flags.invert),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(subAnimationId !== undefined ? { subAnimationId } : {}),
  };
}

const cli = meow(`
  Usage
    $ termvg [dir|file]
    $ termvg play <file|url|-> [options]
    $ termvg inspect <file|url|-> [--json] [--anim <id>]
    $ termvg export <file|url|-> -o <out.(png|gif|ans|txt)> [options]
    $ termvg mcp
    $ termvg web

  Play Options
    -m, --mode <mode>     Render mode: auto, kitty, iterm2, sextant, quadrant, braille, half-block (default: auto)
    --loop / --no-loop    Loop playback (default: --no-loop)
    --speed <n>           Playback speed multiplier (default: 1.0)
    --bg <preset>         Background: transparent, dark, light, checkerboard (default: transparent)
    --invert              Invert dark strokes/fills for dark terminals
    --width <cols>        Override terminal width in columns
    --height <rows>       Override terminal height in rows
    --anim <id>           Select sub-animation ID inside a .lottie archive

  Inspect / Export Options
    --json                Output pure JSON report for CI pipelines (inspect)
    -o, --output <path>   Output file path (.png, .gif, .ans, .txt) (export)
    --frame <n>           Target frame index for .png / .ans (default: 0)
    --size <WxH>          Dimensions (PNG/GIF default: 256x256 px; ANS default: 80x40 cols)
    --fps <n>             Target GIF frame rate 1..50 (default: source FPS or 20)

  General Options
    --help                Show help
    --version             Show version

  Examples
    $ termvg
    $ termvg ./assets
    $ termvg play ./assets/5317-fireworkds.json --mode quadrant --speed 1.5 --bg dark --loop
    $ cat ./assets/2961.svg | termvg play -
    $ termvg inspect ./assets/5317-fireworkds.json --json
    $ termvg export ./assets/5317-fireworkds.json -o preview.gif --size 240x240 --fps 20
`, {
  importMeta: import.meta,
  booleanDefault: undefined,
  flags: {
    mode: { type: 'string', shortFlag: 'm' },
    loop: { type: 'boolean' },
    speed: { type: 'number' },
    bg: { type: 'string' },
    invert: { type: 'boolean' },
    width: { type: 'number' },
    height: { type: 'number' },
    json: { type: 'boolean' },
    output: { type: 'string', shortFlag: 'o' },
    frame: { type: 'number' },
    size: { type: 'string' },
    fps: { type: 'number' },
    anim: { type: 'string' },
    help: { type: 'boolean' },
    version: { type: 'boolean' },
  },
});

export const SinglePlayer = ({
  filePath,
  loadedAsset,
  playOptions,
  exit,
}: {
  filePath: string;
  loadedAsset?: LoadedVectorAsset;
  playOptions?: ValidatedPlayOptions;
  exit: () => void;
}) => {
  const opts = playOptions ?? parseAndValidatePlayFlags({});
  const [termSize, setTermSize] = React.useState({
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });
  const resizeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = React.useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    const onResize = () => {
      if (resizeTimerRef.current !== null) {
        clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null;
        if (!isMountedRef.current) return;
        setTermSize({
          columns: process.stdout.columns || 80,
          rows: process.stdout.rows || 24,
        });
      }, 80);
    };
    process.stdout.on('resize', onResize);
    return () => {
      isMountedRef.current = false;
      if (resizeTimerRef.current !== null) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      process.stdout.off('resize', onResize);
    };
  }, []);

  return (
    <Box flexDirection="column">
      <LottiePlayer
        wasmModule={realWasmModule}
        filePath={filePath}
        loadedAsset={loadedAsset}
        width={opts.width ?? Math.max(16, termSize.columns)}
        height={opts.height ?? Math.max(8, termSize.rows - 2)}
        renderMode={opts.renderMode}
        invertDark={opts.invertDark}
        backgroundPreset={opts.backgroundPreset}
        speed={opts.speed}
        loop={opts.loop}
        onComplete={exit}
      />
    </Box>
  );
};

const PlayApp = ({
  filePath,
  loadedAsset,
  playOptions,
}: {
  filePath: string;
  loadedAsset?: LoadedVectorAsset;
  playOptions: ValidatedPlayOptions;
}) => {
  const { exit } = useApp();

  useEffect(() => {
    const handleSignal = () => {
      realWasmModule.destroy();
      exit();
    };
    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
    process.on('SIGHUP', handleSignal);
    return () => {
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
      process.off('SIGHUP', handleSignal);
    };
  }, [exit]);

  return (
    <SinglePlayer
      filePath={filePath}
      loadedAsset={loadedAsset}
      playOptions={playOptions}
      exit={() => {
        realWasmModule.destroy();
        exit();
      }}
    />
  );
};

const App = () => {
  const { exit } = useApp();
  const command = cli.input[0];
  const filePath = cli.input[1];

  // Global Signal Handling for Web Terminal (ttyd) disconnection or Ctrl+C
  useEffect(() => {
    const handleSignal = () => {
      // Graceful Shutdown: free WASM memory before exiting
      realWasmModule.destroy();
      exit();
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
    process.on('SIGHUP', handleSignal); // Triggered when ttyd websocket disconnects

    return () => {
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
      process.off('SIGHUP', handleSignal);
    };
  }, [exit]);

  if (command === 'play' && filePath) {
    return <SinglePlayer filePath={filePath} exit={() => { realWasmModule.destroy(); exit(); }} />;
  }

  let initialPath = process.cwd();
  let initialFile: string | undefined;
  let initialError: string | null = null;

  if (command) {
    const resolvedTarget = path.resolve(command);
    try {
      const stat = fs.statSync(resolvedTarget);
      if (stat.isDirectory()) {
        initialPath = resolvedTarget;
      } else if (stat.isFile()) {
        initialPath = path.dirname(resolvedTarget);
        initialFile = resolvedTarget;
      } else {
        initialError = '❌ 존재하지 않는 경로입니다';
      }
    } catch (err: any) {
      initialError =
        err?.code === 'EACCES' || err?.code === 'EPERM'
          ? '❌ 접근 권한이 없는 경로입니다'
          : '❌ 존재하지 않는 경로입니다';
    }
  }

  // Interactive Mode
  return (
    <InteractiveMenu
      wasmModule={realWasmModule}
      initialPath={initialPath}
      initialFile={initialFile}
      initialDepth={1}
      initialError={initialError}
    />
  );
};

const MODE_INT_MAP: Record<EffectiveRenderMode, number> = {
  'half-block': 0,
  quadrant: 1,
  sextant: 0,
  braille: 2,
  kitty: 0,
  iterm2: 0,
};

/**
 * stdin('-') 파이프 또는 비대화형 스트림 입력을 Ink raw-mode(useInput) 충돌 없이
 * 단발 재생하고 WASM 메모리를 안전하게 해제한다.
 */
export async function runNonInteractiveStreamPlay(
  asset: LoadedVectorAsset,
  deps?: {
    wasmModule?: any;
    stdout?: NodeJS.WriteStream;
    playOptions?: ValidatedPlayOptions;
  },
): Promise<number> {
  const wasm = deps?.wasmModule ?? realWasmModule;
  const out = deps?.stdout ?? process.stdout;
  const opts = deps?.playOptions ?? parseAndValidatePlayFlags({ mode: 'braille' });
  const cols = opts.width ?? Math.max(16, out.columns || 80);
  const rows = opts.height ?? Math.max(8, (out.rows || 24) - 2);
  const rawPixel = calcPixelSize(cols, rows, opts.renderMode, { isStatic: true });
  const pixel = clampEvenPixelSize(rawPixel.w, rawPixel.h);

  await wasm.init();
  wasm.setSize(pixel.width, pixel.height);

  const raw = remapPureBlackForeground(asset.content, asset.format);
  const processed = preprocessVectorData(
    raw,
    asset.format,
    getModePixelAspect(opts.renderMode),
  );
  if (!wasm.loadContent(processed)) {
    wasm.destroy();
    process.stderr.write(`Error: Failed to load vector asset "${asset.sourceLabel}" into ThorVG.\n`);
    return 1;
  }

  const rawTotalFrames = wasm.getTotalFrames();
  const duration = wasm.getDuration();
  const isStatic =
    !Number.isFinite(rawTotalFrames) ||
    !Number.isFinite(duration) ||
    rawTotalFrames <= 1 ||
    duration <= 0;
  const totalFrames = isStatic ? 1 : Math.max(1, Math.floor(rawTotalFrames));

  const extractor = new WasmPixelExtractor();
  const bgScratch = { current: new Uint8Array(0) };

  const renderAt = (frameIdx: number): string => {
    if (opts.renderMode === 'kitty' || opts.renderMode === 'iterm2') {
      const rawMode0 = wasm.renderToString(frameIdx, 0, opts.invertDark);
      const pf = extractor.extractFromHalfBlockAnsi(rawMode0, pixel.width, pixel.height);
      const composited = applyBackgroundPresetToPixels(pf, opts.backgroundPreset, bgScratch);
      return opts.renderMode === 'kitty'
        ? encodeKittyGraphics(composited, { cols, rows })
        : encodeIterm2Graphics(composited, { cols, rows });
    }
    if (opts.renderMode === 'sextant') {
      const rawMode0 = wasm.renderToString(frameIdx, 0, opts.invertDark);
      const pf = extractor.extractFromHalfBlockAnsi(rawMode0, pixel.width, pixel.height);
      return renderPixelsToSextant(pf, {
        background: opts.backgroundPreset,
        optimizeRle: true,
      });
    }
    const modeInt = MODE_INT_MAP[opts.renderMode];
    return postProcessAnsiFrame(wasm.renderToString(frameIdx, modeInt, opts.invertDark), {
      background: opts.backgroundPreset,
      optimizeRle: true,
    });
  };

  if (isStatic) {
    out.write(renderAt(0) + '\n');
    wasm.destroy();
    return 0;
  }

  return new Promise<number>((resolve) => {
    const startMs = performance.now();
    let lastRenderedFrame = -1;
    let finished = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const cleanup = (code: number) => {
      if (finished) return;
      finished = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      wasm.destroy();
      resolve(code);
    };

    const onSignal = () => cleanup(0);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    const emitFrame = (frameIdx: number, isFirst: boolean) => {
      if (frameIdx === lastRenderedFrame) return;
      lastRenderedFrame = frameIdx;
      const ansi = renderAt(frameIdx);
      if (out.isTTY) {
        const prefix = isFirst ? '\x1b[2J\x1b[H' : '\x1b[H';
        out.write(`\x1b[?2026h${prefix}${ansi}\n\x1b[?2026l`);
      } else {
        out.write(ansi + '\n');
      }
    };

    emitFrame(0, true);

    timer = setInterval(() => {
      const elapsedSec = ((performance.now() - startMs) / 1000) * opts.speed;
      const rawTargetFrame = Math.floor(elapsedSec * (totalFrames / duration));
      if (rawTargetFrame >= totalFrames) {
        if (opts.loop) {
          emitFrame(rawTargetFrame % totalFrames, false);
          return;
        }
        emitFrame(totalFrames - 1, false);
        cleanup(0);
        return;
      }
      emitFrame(Math.max(0, rawTargetFrame), false);
    }, 33);
  });
}

async function runCli(): Promise<void> {
  const command = cli.input[0];
  const rawTarget = cli.input[1];

  if (command === 'mcp') {
    installMcpStdioGuard();
    await runMcpServerStdio();
    return;
  }

  if (command === 'inspect') {
    const code = await runInspectCli(rawTarget, {
      json: Boolean(cli.flags.json),
      anim: typeof cli.flags.anim === 'string' ? cli.flags.anim : undefined,
    });
    process.exit(code);
    return;
  }

  if (command === 'export') {
    const code = await runExportCli(rawTarget, cli.flags);
    process.exit(code);
    return;
  }

  if (command === 'web') {
    console.log('🚀 Starting web terminal on http://localhost:8080 ...');

    const isTs = process.argv[1].endsWith('.ts') || process.argv[1].endsWith('.tsx');
    const args = isTs
      ? ['-W', '-p', '8080', 'npx', 'tsx', process.argv[1]]
      : ['-W', '-p', '8080', process.execPath, process.argv[1]];

    const ttyd = spawn('ttyd', args, {
      stdio: 'inherit'
    });

    ttyd.on('error', () => {
      console.error('❌ Failed to start ttyd. Make sure it is installed (e.g., brew install ttyd).');
      process.exit(1);
    });

    setTimeout(() => {
      open('http://localhost:8080');
      console.log('🌐 Browser opened. Press Ctrl+C to stop the web terminal.');
    }, 1000);

    process.on('SIGINT', () => {
      console.log('\nStopping web terminal...');
      ttyd.kill('SIGINT');
      process.exit(0);
    });
    return;
  }

  if (
    command === 'play' ||
    command === '-' ||
    (command !== undefined && isUrlInput(command))
  ) {
    let playOpts: ValidatedPlayOptions;
    try {
      playOpts = parseAndValidatePlayFlags(cli.flags);
    } catch (err: any) {
      process.stderr.write(`${err?.message || String(err)}\n`);
      process.exit(2);
      return;
    }

    const target =
      command === 'play'
        ? rawTarget ?? (!process.stdin.isTTY ? '-' : undefined)
        : command;

    if (!target) {
      process.stderr.write('Error: Missing target file, URL, or "-" for stdin.\n');
      process.exit(2);
      return;
    }

    let asset: LoadedVectorAsset;
    try {
      asset = await loadVectorAsset(target, playOpts.subAnimationId);
    } catch (err: any) {
      process.stderr.write(`${err?.message || String(err)}\n`);
      process.exit(1);
      return;
    }

    if (target === '-' || !process.stdin.isTTY) {
      const code = await runNonInteractiveStreamPlay(asset, { playOptions: playOpts });
      process.exit(code);
      return;
    }

    render(<PlayApp filePath={asset.sourceLabel} loadedAsset={asset} playOptions={playOpts} />, {
      stdout: createSyncStdout(process.stdout),
    });
    return;
  }

  // Use custom stdout stream to wrap every Ink render in Sync Output sequences
  render(<App />, { stdout: createSyncStdout(process.stdout) });
}

const isCliEntry = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();

if (isCliEntry) {
  runCli().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
