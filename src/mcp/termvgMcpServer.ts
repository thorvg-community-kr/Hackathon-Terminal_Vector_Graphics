import util from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { inspectVectorAsset } from '../cli/inspectCommand.js';
import { loadVectorAsset } from '../loaders/assetLoader.js';
import { realWasmModule } from '../realWasmModule.js';
import { encodeRgbaToPng } from '../renderers/minimalPng.js';
import {
  normalizeEvenHeight,
  WasmPixelExtractor,
} from '../renderers/pixelExtractor.js';
import {
  postProcessAnsiFrame,
  remapPureBlackForeground,
} from '../utils/ansiPostProcessor.js';
import {
  getModePixelAspect,
  preprocessVectorData,
} from '../utils/vectorPreprocessor.js';
import { globalWasmMutex } from '../utils/wasmMutex.js';

const MIN_SNAPSHOT_DIM = 16;
const MAX_SNAPSHOT_DIM = 1024;
const DEFAULT_SNAPSHOT_DIM = 256;

/**
 * MCP Stdio 모드에서 stdout JSON-RPC 스트림 오염을 원천 차단하기 위해
 * console.log / info / warn / debug 출력을 모두 stderr로 리다이렉트한다.
 */
export function installMcpStdioGuard(): () => void {
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

function clampEvenSnapshotDim(rawVal: unknown): number {
  const num =
    typeof rawVal === 'number' && Number.isFinite(rawVal)
      ? Math.round(rawVal)
      : DEFAULT_SNAPSHOT_DIM;
  const clamped = Math.min(MAX_SNAPSHOT_DIM, Math.max(MIN_SNAPSHOT_DIM, num));
  return clamped % 2 === 0 ? clamped : Math.min(MAX_SNAPSHOT_DIM, clamped + 1);
}

/**
 * AI 에이전트 연동용 TermVG MCP 서버 인스턴스와 멱등 정리(cleanup) 핸들러를 생성한다.
 * - 직접 zod 의존성 없이 Server + JSON Schema를 사용하여 패키지 의존성을 격리한다.
 * - 단일 WASM 엔진 경합을 막기 위해 모든 도구 핸들러는 globalWasmMutex를 통해 직렬화된다.
 */
export function createTermvgMcpServer(deps?: { wasmModule?: any }): {
  server: Server;
  cleanup: () => void;
} {
  const wasm = deps?.wasmModule ?? realWasmModule;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      wasm.destroy?.();
    } catch {
      // ignore teardown errors
    }
  };

  const server = new Server(
    { name: 'termvg-mcp-server', version: '1.0.2' },
    { capabilities: { tools: {} } },
  );

  server.onclose = () => {
    cleanup();
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'inspect_vector',
        description:
          'Inspect an SVG, Lottie JSON, .lottie archive, or http(s) URL and return metadata, layer breakdown, warnings, and ThorVG WASM validation.',
        inputSchema: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: 'Local vector file path (.svg, .json, .lottie) or http(s):// URL.',
            },
            subAnimationId: {
              type: 'string',
              description: 'Optional animation ID inside a multi-animation .lottie archive.',
            },
          },
          required: ['source'],
          additionalProperties: false,
        },
      },
      {
        name: 'render_vector_snapshot',
        description:
          'Render an SVG, Lottie JSON, .lottie archive, or http(s) URL frame via ThorVG WASM into a PNG image (Base64) and an ANSI terminal preview summary.',
        inputSchema: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: 'Local vector file path (.svg, .json, .lottie) or http(s):// URL.',
            },
            frame: {
              type: 'number',
              description: 'Zero-based frame index to render (default: 0).',
            },
            width: {
              type: 'number',
              description: 'Snapshot PNG width in pixels, clamped to [16, 1024] (default: 256).',
            },
            height: {
              type: 'number',
              description: 'Snapshot PNG height in pixels, clamped to [16, 1024] (default: 256).',
            },
            subAnimationId: {
              type: 'string',
              description: 'Optional animation ID inside a .lottie archive.',
            },
          },
          required: ['source'],
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    const rawSource = args.source;
    if (typeof rawSource !== 'string' || !rawSource.trim()) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Error: "source" string parameter is required.' }],
      };
    }
    const source = rawSource.trim();
    if (source === '-') {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: "Error: stdin ('-') source is not supported in MCP stdio server mode.",
          },
        ],
      };
    }

    const subAnimationId =
      typeof args.subAnimationId === 'string' && args.subAnimationId.trim()
        ? args.subAnimationId.trim()
        : undefined;

    try {
      if (toolName === 'inspect_vector') {
        const report = await globalWasmMutex.runExclusive(() =>
          inspectVectorAsset(source, { wasmModule: wasm, subAnimationId }),
        );
        return {
          ...(report.engineLoadOk ? {} : { isError: true }),
          content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
        };
      }

      if (toolName === 'render_vector_snapshot') {
        const evenW = clampEvenSnapshotDim(args.width);
        const evenH = Math.min(
          MAX_SNAPSHOT_DIM,
          Math.max(MIN_SNAPSHOT_DIM, normalizeEvenHeight(clampEvenSnapshotDim(args.height))),
        );
        const requestedFrame =
          typeof args.frame === 'number' && Number.isFinite(args.frame)
            ? Math.max(0, Math.floor(args.frame))
            : 0;

        const result = await globalWasmMutex.runExclusive(async () => {
          const asset = await loadVectorAsset(source, subAnimationId);
          await wasm.init();

          const raw = remapPureBlackForeground(asset.content, asset.format);

          // 1. PNG 스냅샷 렌더링 (정방형 픽셀, Mode 0 무손실 추출)
          wasm.setSize(evenW, evenH);
          const processedPng = preprocessVectorData(raw, asset.format, {
            pixelAspectX: 1,
            pixelAspectY: 1,
          });
          if (!wasm.loadContent(processedPng)) {
            throw new Error(`ThorVG WASM failed to load "${asset.sourceLabel}".`);
          }

          const rawTotal = wasm.getTotalFrames();
          const totalFrames =
            asset.format === 'svg' || !Number.isFinite(rawTotal) || rawTotal <= 1
              ? 1
              : Math.floor(rawTotal);
          const targetFrame = Math.min(totalFrames - 1, requestedFrame);

          const extractor = new WasmPixelExtractor();
          const pixelFrame = extractor.renderAndExtract(
            wasm,
            targetFrame,
            evenW,
            evenH,
            false,
          );
          const pngBase64 = encodeRgbaToPng(pixelFrame).toString('base64');

          // 2. 40x20 Quadrant RLE ANSI 텍스트 요약 생성
          wasm.setSize(80, 40);
          const processedAnsi = preprocessVectorData(
            raw,
            asset.format,
            getModePixelAspect('quadrant'),
          );
          let ansiSummary = '';
          if (wasm.loadContent(processedAnsi)) {
            const rawAnsi = wasm.renderToString(targetFrame, 1, false);
            ansiSummary = postProcessAnsiFrame(rawAnsi, {
              background: 'transparent',
              optimizeRle: true,
            });
          }

          return {
            pngBase64,
            summaryText:
              `Rendered ${asset.sourceLabel} (format=${asset.format}, frame=${targetFrame}/${totalFrames}, png=${evenW}x${evenH})\n\n` +
              ansiSummary,
          };
        });

        return {
          content: [
            { type: 'image', mimeType: 'image/png', data: result.pngBase64 },
            { type: 'text', text: result.summaryText },
          ],
        };
      }

      return {
        isError: true,
        content: [{ type: 'text', text: `Error: Unknown MCP tool "${toolName}".` }],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }
  });

  return { server, cleanup };
}

/**
 * `termvg mcp` Stdio JSON-RPC 서버 실행 진입점.
 * 클라이언트 연결 종료(stdin end/close) 또는 시그널 수신 시 WASM 메모리를 1회 해제하고 종료 코드 0으로 종료한다.
 */
export async function runMcpServerStdio(deps?: {
  wasmModule?: any;
  transport?: Transport;
  exitOnClose?: boolean;
}): Promise<void> {
  const restoreConsole = installMcpStdioGuard();
  const { server, cleanup } = createTermvgMcpServer({ wasmModule: deps?.wasmModule });
  const transport = deps?.transport ?? new StdioServerTransport(process.stdin, process.stdout);

  await server.connect(transport);

  await new Promise<void>((resolve) => {
    let settled = false;

    const shutdown = () => {
      if (settled) return;
      settled = true;

      process.stdin.off('end', shutdown);
      process.stdin.off('close', shutdown);
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);

      cleanup();
      void Promise.resolve()
        .then(() => server.close())
        .catch(() => {})
        .finally(() => {
          if (deps?.exitOnClose !== false) {
            process.exit(0);
          } else {
            restoreConsole();
            resolve();
          }
        });
    };

    const prevOnClose = transport.onclose;
    transport.onclose = () => {
      prevOnClose?.();
      shutdown();
    };

    process.stdin.once('end', shutdown);
    process.stdin.once('close', shutdown);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
