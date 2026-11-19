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
import { LottiePlayer } from './LottiePlayer.js';
import { realWasmModule } from './realWasmModule.js';
import { createSyncStdout } from './utils/syncOutput.js';
import { clampEvenPixelSize } from './hooks/useAnimationLoop.js';
import { getModePixelAspect, preprocessVectorData } from './utils/vectorPreprocessor.js';
import { postProcessAnsiFrame, remapPureBlackForeground } from './utils/ansiPostProcessor.js';
import {
  isUrlInput,
  loadVectorAsset,
  type LoadedVectorAsset,
} from './loaders/assetLoader.js';

const cli = meow(`
  Usage
    $ termvg [dir|file]
    $ termvg play <file|url|->
    $ termvg web

  Options
    --help     Show help
    --version  Show version

  Examples
    $ termvg
    $ termvg ./assets
    $ termvg ./assets/43391.json
    $ termvg play example.lottie
    $ termvg play https://example.com/animation.json
    $ cat icon.svg | termvg play -
`, {
  importMeta: import.meta,
  flags: {
    help: { type: 'boolean' },
    version: { type: 'boolean' }
  }
});

const SinglePlayer = ({
  filePath,
  loadedAsset,
  exit,
}: {
  filePath: string;
  loadedAsset?: LoadedVectorAsset;
  exit: () => void;
}) => {
  const [termSize, setTermSize] = React.useState({
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24
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
          rows: process.stdout.rows || 24
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
        width={Math.max(16, termSize.columns)}
        height={Math.max(8, termSize.rows - 2)}
        renderMode="braille"
        invertDark={false}
        loop={false}
        onComplete={exit}
      />
    </Box>
  );
};

const PlayApp = ({
  filePath,
  loadedAsset,
}: {
  filePath: string;
  loadedAsset?: LoadedVectorAsset;
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

/**
 * stdin('-') 파이프 또는 비대화형 스트림 입력을 Ink raw-mode(useInput) 충돌 없이
 * 단발 재생하고 WASM 메모리를 안전하게 해제한다.
 */
export async function runNonInteractiveStreamPlay(
  asset: LoadedVectorAsset,
  deps?: { wasmModule?: any; stdout?: NodeJS.WriteStream },
): Promise<number> {
  const wasm = deps?.wasmModule ?? realWasmModule;
  const out = deps?.stdout ?? process.stdout;
  const cols = Math.max(16, out.columns || 80);
  const rows = Math.max(8, (out.rows || 24) - 2);
  const pixel = clampEvenPixelSize(cols * 2, rows * 4);

  await wasm.init();
  wasm.setSize(pixel.width, pixel.height);

  const raw = remapPureBlackForeground(asset.content, asset.format);
  const processed = preprocessVectorData(raw, asset.format, getModePixelAspect('braille'));
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

  const renderAt = (frameIdx: number) =>
    postProcessAnsiFrame(wasm.renderToString(frameIdx, 2, false), {
      background: 'transparent',
      optimizeRle: true,
    });

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
      const elapsedSec = (performance.now() - startMs) / 1000;
      const targetFrame = Math.floor(elapsedSec * (totalFrames / duration));
      if (targetFrame >= totalFrames) {
        emitFrame(totalFrames - 1, false);
        cleanup(0);
        return;
      }
      emitFrame(Math.max(0, targetFrame), false);
    }, 33);
  });
}

async function runCli(): Promise<void> {
  const command = cli.input[0];
  const rawTarget = cli.input[1];

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
    const target =
      command === 'play'
        ? rawTarget ?? (!process.stdin.isTTY ? '-' : undefined)
        : command;

    if (!target) {
      process.stderr.write('Error: Missing target file, URL, or "-" for stdin.\n');
      process.exit(1);
    }

    let asset: LoadedVectorAsset;
    try {
      asset = await loadVectorAsset(target);
    } catch (err: any) {
      process.stderr.write(`${err?.message || String(err)}\n`);
      process.exit(1);
    }

    if (target === '-' || !process.stdin.isTTY) {
      const code = await runNonInteractiveStreamPlay(asset);
      process.exit(code);
    }

    render(<PlayApp filePath={asset.sourceLabel} loadedAsset={asset} />, {
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
