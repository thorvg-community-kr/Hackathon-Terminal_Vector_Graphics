import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');

/**
 * 테스트별 임시 디렉터리 생성 및 일괄 정리를 관리한다.
 */
export function createTempDirPool(defaultPrefix = 'termvg-test-') {
  const dirs: string[] = [];
  return {
    create(prefix = defaultPrefix): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    cleanup(): void {
      while (dirs.length > 0) {
        const dir = dirs.pop();
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * 빌드된 dist/index.js CLI 엔트리를 하위 프로세스로 실행한다.
 */
export function runBuiltCli(
  args: string[],
  stdinInput?: Buffer | string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [DIST_ENTRY, ...args], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    proc.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.stdin.end(stdinInput);
  });
}

export interface SampleLottieOptions {
  name?: string;
  layerName?: string;
  width?: number;
  height?: number;
  op?: number;
  diameter?: number;
  color?: [number, number, number, number];
  assets?: unknown[];
  markers?: Array<{ cm: string; tm: number; dr: number }>;
}

/**
 * 단일 원형 벡터 레이어를 포함한 테스트용 Lottie JSON 문자열을 생성한다.
 */
export function makeSampleLottie(options: SampleLottieOptions = {}): string {
  const {
    name = 'Sample',
    layerName = 'Dot',
    width = 100,
    height = 100,
    op = 60,
    diameter = 40,
    color = [0.2, 0.8, 1, 1],
    assets = [],
    markers,
  } = options;

  const cx = width / 2;
  const cy = height / 2;
  const payload: Record<string, unknown> = {
    v: '5.7.4',
    fr: 30,
    ip: 0,
    op,
    w: width,
    h: height,
    nm: name,
    ddd: 0,
    assets,
    layers: [
      {
        ddd: 0,
        ind: 1,
        ty: 4,
        nm: layerName,
        sr: 1,
        ks: {
          o: { a: 0, k: 100 },
          r: { a: 0, k: 0 },
          p: { a: 0, k: [cx, cy, 0] },
          a: { a: 0, k: [0, 0, 0] },
          s: { a: 0, k: [100, 100, 100] },
        },
        ao: 0,
        shapes: [
          {
            ty: 'gr',
            it: [
              { ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [diameter, diameter] } },
              { ty: 'fl', c: { a: 0, k: color }, o: { a: 0, k: 100 } },
              {
                ty: 'tr',
                p: { a: 0, k: [0, 0] },
                a: { a: 0, k: [0, 0] },
                s: { a: 0, k: [100, 100] },
                r: { a: 0, k: 0 },
                o: { a: 0, k: 100 },
              },
            ],
          },
        ],
        ip: 0,
        op,
        st: 0,
      },
    ],
  };

  if (markers) payload.markers = markers;
  return JSON.stringify(payload);
}
