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
import {
  clampEvenPixelSize,
  installStderrConsoleGuard,
  loadVectorIntoWasm,
  renderVectorFrame,
  renderWasmPixelFrame,
} from '../renderers/headlessPipeline.js';
import { encodeRgbaToPng } from '../renderers/minimalPng.js';
import { WasmPixelExtractor } from '../renderers/pixelExtractor.js';
import { getModePixelAspect } from '../utils/vectorPreprocessor.js';
import { globalWasmMutex } from '../utils/wasmMutex.js';

const MIN_SNAPSHOT_DIM = 16;
const MAX_SNAPSHOT_DIM = 1024;
const DEFAULT_SNAPSHOT_DIM = 256;

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
        const report = await inspectVectorAsset(source, { wasmModule: wasm, subAnimationId });
        return {
          ...(report.engineLoadOk ? {} : { isError: true }),
          content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
        };
      }

      if (toolName === 'render_vector_snapshot') {
        const rawW =
          typeof args.width === 'number' && Number.isFinite(args.width)
            ? Math.round(args.width)
            : DEFAULT_SNAPSHOT_DIM;
        const rawH =
          typeof args.height === 'number' && Number.isFinite(args.height)
            ? Math.round(args.height)
            : DEFAULT_SNAPSHOT_DIM;
        const { width: evenW, height: evenH } = clampEvenPixelSize(
          rawW,
          rawH,
          MIN_SNAPSHOT_DIM,
          MIN_SNAPSHOT_DIM,
          MAX_SNAPSHOT_DIM,
          MAX_SNAPSHOT_DIM,
        );
        const requestedFrame =
          typeof args.frame === 'number' && Number.isFinite(args.frame)
            ? Math.max(0, Math.floor(args.frame))
            : 0;

        const asset = await loadVectorAsset(source, subAnimationId);
        const result = await globalWasmMutex.runExclusive(async () => {
          const pngMeta = await loadVectorIntoWasm(wasm, asset, evenW, evenH, {
            pixelAspectX: 1,
            pixelAspectY: 1,
          });
          if (!pngMeta.loaded) {
            throw new Error(`ThorVG WASM failed to load "${asset.sourceLabel}".`);
          }

          const targetFrame = Math.min(pngMeta.totalFrames - 1, requestedFrame);
          const extractor = new WasmPixelExtractor();
          const pixelFrame = renderWasmPixelFrame(wasm, extractor, targetFrame, evenW, evenH);
          const pngBase64 = encodeRgbaToPng(pixelFrame).toString('base64');

          // 2. 40x20 Quadrant RLE ANSI 텍스트 요약 생성
          const ansiMeta = await loadVectorIntoWasm(
            wasm,
            asset,
            80,
            40,
            getModePixelAspect('quadrant'),
          );
          const ansiSummary = ansiMeta.loaded
            ? renderVectorFrame(wasm, targetFrame, {
                mode: 'quadrant',
                cols: 40,
                rows: 20,
                pixelWidth: 80,
                pixelHeight: 40,
                extractor,
              })
            : '';

          return {
            pngBase64,
            summaryText:
              `Rendered ${asset.sourceLabel} (format=${asset.format}, frame=${targetFrame}/${pngMeta.totalFrames}, png=${evenW}x${evenH})\n\n` +
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
  const restoreConsole = installStderrConsoleGuard();
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
