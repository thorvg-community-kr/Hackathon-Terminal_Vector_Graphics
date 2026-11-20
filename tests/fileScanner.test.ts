import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JSON_HEAD_BYTES,
  MAX_SCAN_FILE_BYTES,
  isExcludedJsonFilename,
  isLikelyLottieHead,
  isLikelyLottieJson,
  scanDirectoryAsync,
} from '../src/hooks/useFileScanner.js';
import { createTempDirPool, REPO_ROOT } from './helpers/fsFixtures.js';
import { mountInteractiveMenu } from './helpers/inkHarness.js';
import { createMockWasm, waitMs } from './helpers/wasmHarness.js';

describe('Task 05: Async File Scanner, CWD Auto-Open & Conflict-Free TUI Keybindings', () => {
  const tempDirs = createTempDirPool('termvg-scan-');

  afterEach(() => {
    vi.restoreAllMocks();
    tempDirs.cleanup();
  });

  it('auto-discovers all 6 sample assets in ./assets at depth 1 while excluding project config JSONs', async () => {
    const items = await scanDirectoryAsync(REPO_ROOT, { maxDepth: 1 });
    const fileValues = items.filter((i) => !i.value.startsWith('__folder__')).map((i) => path.basename(i.value));

    expect(fileValues).toEqual(
      expect.arrayContaining([
        '1528966158.svg',
        '2961.svg',
        '421553147-22eaf24a-a9a7-4a35-abac-df5a54ac5b19.svg',
        '43391.json',
        '5317-fireworkds.json',
        'week02-example01.json',
      ]),
    );
    expect(fileValues).not.toContain('package.json');
    expect(fileValues).not.toContain('package-lock.json');
    expect(fileValues).not.toContain('tsconfig.json');

    expect(isExcludedJsonFilename('package.json')).toBe(true);
    expect(isExcludedJsonFilename('package-lock.json')).toBe(true);
    expect(isExcludedJsonFilename('tsconfig.build.json')).toBe(true);
    expect(isExcludedJsonFilename('43391.json')).toBe(false);
    expect(isLikelyLottieJson('{"users":[1,2,3]}')).toBe(false);
    expect(isLikelyLottieJson('{"v":"5.7.4","layers":[]}')).toBe(true);
  });

  it('safely filters malformed JSON, non-Lottie JSON, symlink loops, broken symlinks, and >25MB files', async () => {
    expect(MAX_SCAN_FILE_BYTES).toBe(25 * 1024 * 1024);

    const tmpDir = tempDirs.create();

    const subDir = path.join(tmpDir, 'nested');
    fs.mkdirSync(subDir);

    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{"v":"1","layers":[]}', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.app.json'), '{"v":"1","layers":[]}', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'broken.json'), '{ invalid json', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'data.json'), '{"users":[1,2,3],"items":["a","b"]}', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'valid.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>', 'utf8');
    fs.writeFileSync(path.join(subDir, 'valid-lottie.json'), '{"v":"5.7.4","fr":30,"layers":[]}', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'huge-lottie.json'), '{"v":"5.7.4","layers":[]}', 'utf8');

    // 자기 참조 심볼릭 링크 루프 및 깨진 심볼릭 링크 생성
    fs.symlinkSync('.', path.join(tmpDir, 'loop'));
    fs.symlinkSync('..', path.join(subDir, 'parent-loop'));
    fs.symlinkSync(path.join(tmpDir, 'does-not-exist.json'), path.join(tmpDir, 'dangling.json'));

    // huge-lottie.json만 25MB 초과 크기로 반환하도록 stat 모킹
    const origStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (targetPath, opts) => {
      const realStat = await origStat(targetPath, opts as any);
      if (String(targetPath).endsWith('huge-lottie.json')) {
        return Object.assign(Object.create(Object.getPrototypeOf(realStat)), realStat, {
          size: MAX_SCAN_FILE_BYTES + 1,
        });
      }
      return realStat;
    });

    const items = await scanDirectoryAsync(tmpDir, { maxDepth: 2 });
    const files = items.filter((i) => !i.value.startsWith('__folder__')).map((i) => path.basename(i.value));

    expect(files).toEqual(['valid.svg', 'valid-lottie.json']);
  });

  it('aborts cleanly via AbortController signal without returning stale results', async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const emptyRes = await scanDirectoryAsync(REPO_ROOT, { maxDepth: 1, signal: preAborted.signal });
    expect(emptyRes).toEqual([]);

    const tmpDir = tempDirs.create('termvg-abort-');
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(path.join(tmpDir, `icon-${i}.svg`), '<svg width="4" height="4"/>', 'utf8');
    }

    const controller = new AbortController();
    const scanPromise = scanDirectoryAsync(tmpDir, { maxDepth: 1, signal: controller.signal });
    // 첫 25건 배치 이후 setImmediate 양보 시점에 취소
    controller.abort();
    const abortedRes = await scanPromise;
    expect(abortedRes).toEqual([]);
  });

  it('auto-opens cwd, preserves fileList on invalid path, isolates shortcuts in text input mode, and handles /, R, B, ?, Q', async () => {
    const tmpDir = tempDirs.create('termvg-tui-');
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir);
    fs.writeFileSync(
      path.join(tmpDir, 'alpha.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#ff0000"/></svg>',
      'utf8',
    );
    fs.writeFileSync(path.join(subDir, 'beta.svg'), '<svg width="8" height="8"/>', 'utf8');

    const mockWasm = createMockWasm({ renderToString: () => '\x1b[38;2;255;0;0m▄\x1b[0m' });
    const { inst, stdin, getOutput, getLatestChunk } = mountInteractiveMenu(
      { wasmModule: mockWasm, initialPath: tmpDir, initialDepth: 1 },
      120,
      40,
    );

    await waitMs(80);
    // 초기 스캔 완료 후 자동 선택 및 Depth:1, Bg:transparent 표시 확인
    const initialOut = getOutput();
    expect(initialOut).toContain('alpha.svg');
    expect(initialOut).toContain('Bg:transparent(B)');
    expect(initialOut).toContain('Depth:1(R)');
    expect(initialOut).toContain('/:Search R:Depth B:Bg');
    expect(initialOut).toContain('?:Help');

    // 1. 로컬 검색('/') 중 'qrbmd?' 타이핑 시 전역 단축키가 절대 발동하지 않고 검색어만 입력됨
    stdin.write('/');
    await waitMs(30);
    stdin.write('qrbmd?');
    await waitMs(40);
    expect(mockWasm.destroy).not.toHaveBeenCalled();
    expect(getLatestChunk()).toContain('qrbmd?');
    expect(getLatestChunk()).toContain('Bg:transparent(B)');
    expect(getLatestChunk()).toContain('Depth:1(R)');
    expect(getLatestChunk()).not.toContain('TermVG 단축키 도움말');

    // ESC로 로컬 검색 취소
    stdin.write('\x1b');
    await waitMs(60);

    // 2. 'O' 경로 입력에 존재하지 않는 경로 제출 시 에러 표시 + 기존 alpha.svg 목록 보존
    stdin.write('o');
    await waitMs(30);
    stdin.write('/does-not-exist-xyz');
    await waitMs(20);
    stdin.write('\r');
    await waitMs(60);
    expect(getLatestChunk()).toContain('❌ 존재하지 않는');
    expect(getLatestChunk()).toContain('경로입니다');
    expect(getLatestChunk()).toContain('alpha.svg');

    // 3. 'B'(배경 프리셋), 'R'(스캔 깊이), '?'(도움말 모달) 동작 검증
    stdin.write('b');
    await waitMs(30);
    expect(getLatestChunk()).toContain('Bg:dark(B)');

    stdin.write('r');
    await waitMs(50);
    expect(getLatestChunk()).toContain('Depth:2(R)');

    stdin.write('?');
    await waitMs(40);
    expect(getLatestChunk()).toContain('TermVG 단축키 도움말');
    expect(getLatestChunk()).toContain('/ 또는 F');

    // ESC로 도움말 닫기
    stdin.write('\x1b');
    await waitMs(60);
    expect(getLatestChunk()).not.toContain('TermVG 단축키 도움말');

    // 4. 'Q' 입력 시 wasmModule.destroy() 호출 및 정상 종료
    stdin.write('q');
    await inst.waitUntilExit();
    expect(mockWasm.destroy).toHaveBeenCalledTimes(1);
  });

  it('auto-selects initialFile and displays initialError safely when launched with CLI positional target', async () => {
    const tmpDir = tempDirs.create('termvg-cli-arg-');
    const firstFile = path.join(tmpDir, 'a-first.svg');
    const secondFile = path.join(tmpDir, 'z-second.svg');
    fs.writeFileSync(firstFile, '<svg width="8" height="8"/>', 'utf8');
    fs.writeFileSync(secondFile, '<svg width="8" height="8"/>', 'utf8');

    const mockWasm = createMockWasm({ renderToString: () => '\x1b[38;2;0;255;0m▄\x1b[0m' });
    const { inst, stdin, getLatestChunk } = mountInteractiveMenu(
      {
        wasmModule: mockWasm,
        initialPath: tmpDir,
        initialFile: secondFile,
        initialDepth: 1,
        initialError: '❌ 존재하지 않는 경로입니다',
      },
      120,
      40,
    );

    await waitMs(80);
    expect(getLatestChunk()).toContain('Name: z-second.svg');
    expect(getLatestChunk()).toContain('❌ 존재하지 않는');
    expect(getLatestChunk()).toContain('경로입니다');

    stdin.write('q');
    await inst.waitUntilExit();
    expect(mockWasm.destroy).toHaveBeenCalledTimes(1);
  });

  it('classifies large JSON by head chunk only', async () => {
    expect(isLikelyLottieHead('{"v":"5.7","fr":30,"ip":0,"op":60,"assets":[')).toBe(true);
    expect(isLikelyLottieHead('{"users":[1,2,3]')).toBe(false);

    const dir = tempDirs.create('termvg-head-');
    const pad = 'x'.repeat(JSON_HEAD_BYTES);
    fs.writeFileSync(path.join(dir, 'big.json'), `{"v":"5.7","fr":30,"op":60,"assets":[{"p":"${pad}"}],"layers":[]}`);
    fs.writeFileSync(path.join(dir, 'data.json'), `{"rows":["${pad}"]}`);
    const readSpy = vi.spyOn(fs.promises, 'readFile');
    const items = await scanDirectoryAsync(dir, { maxDepth: 1 });
    const names = items.map((i) => path.basename(i.value));
    expect(names).toContain('big.json');
    expect(names).not.toContain('data.json');
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('falls back to page navigation with ←/→ while paused on a static SVG', async () => {
    const dir = tempDirs.create('termvg-page-');
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(
        path.join(dir, `f${String(i).padStart(2, '0')}.svg`),
        '<svg width="8" height="8"><rect width="8" height="8"/></svg>',
      );
    }
    const wasm = createMockWasm({ renderToString: () => 'x' });
    const { inst, stdin, getLatestChunk } = mountInteractiveMenu(
      { wasmModule: wasm, initialPath: dir, initialDepth: 1 },
      100,
      40,
    );
    await waitMs(100);
    expect(getLatestChunk()).toMatch(/Page 1\//);
    stdin.write(' ');
    await waitMs(30);
    stdin.write('\x1b[C');
    await waitMs(60);
    expect(getLatestChunk()).toMatch(/Page 2\//);
    inst.unmount();
  });
});
