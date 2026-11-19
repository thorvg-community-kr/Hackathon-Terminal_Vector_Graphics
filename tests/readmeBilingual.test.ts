import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const DETAILS_PATH = path.join(REPO_ROOT, 'docs/DETAILS.md');

function splitBilingualReadme(content: string): {
  header: string;
  english: string;
  korean: string;
} {
  const enMarker = '## English';
  const koMarker = '## 한국어';
  const enIdx = content.indexOf(enMarker);
  const koIdx = content.indexOf(koMarker);

  expect(enIdx).toBeGreaterThan(-1);
  expect(koIdx).toBeGreaterThan(enIdx);

  return {
    header: content.slice(0, enIdx),
    english: content.slice(enIdx, koIdx),
    korean: content.slice(koIdx),
  };
}

function extractRelativeMarkdownTargets(markdown: string): string[] {
  const matches = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)];
  return matches
    .map((m) => m[1].trim())
    .filter((target) => {
      if (!target) return false;
      if (target.startsWith('#')) return false;
      if (/^https?:\/\//i.test(target)) return false;
      if (target.startsWith('mailto:')) return false;
      return true;
    })
    .map((target) => target.split('#')[0]);
}

describe('Task 13: Bilingual README.md & Synchronized docs/DETAILS.md', () => {
  const readme = fs.readFileSync(README_PATH, 'utf8');
  const details = fs.readFileSync(DETAILS_PATH, 'utf8');

  it('provides centered bilingual navigation header and symmetrical ## English / ## 한국어 sections', () => {
    const { header, english, korean } = splitBilingualReadme(readme);

    expect(header).toContain('<div align="center">');
    expect(header).toContain('[English](#english)');
    expect(header).toContain('[한국어](#한국어)');
    expect(korean).toContain('[▲ English](#english)');

    for (let sectionNum = 1; sectionNum <= 9; sectionNum++) {
      expect(english).toMatch(new RegExp(`^### ${sectionNum}\\. `, 'm'));
      expect(korean).toMatch(new RegExp(`^### ${sectionNum}\\. `, 'm'));
    }

    expect(english).toContain('```mermaid');
    expect(korean).toContain('```mermaid');
  });

  it('documents all 4 render modes, 4 background presets, CLI commands, and TUI shortcuts in both languages', () => {
    const { english, korean } = splitBilingualReadme(readme);

    const requiredTerms = [
      'quadrant',
      'sextant',
      'braille',
      'half-block',
      'transparent',
      'dark',
      'light',
      'checkerboard',
      'termvg play',
      'termvg web',
      '--help',
      '--version',
      '`Space`',
      '`M`',
      '`B`',
      '`D`',
      '`/`',
      '`F`',
      '`R`',
      '`O`',
      '`L`',
      '`?`',
      '`Q`',
      '`Esc`',
      '160 × 120',
      'U+1FB00',
      '~/.termvg/token.json',
      '25 MB',
    ];

    for (const section of [english, korean]) {
      for (const term of requiredTerms) {
        expect(section.toLowerCase()).toContain(term.toLowerCase());
      }
    }
  });

  it('resolves all relative markdown links cleanly and avoids stale typos or unmerged task claims', () => {
    for (const [docPath, content] of [
      [README_PATH, readme],
      [DETAILS_PATH, details],
    ] as const) {
      const targets = extractRelativeMarkdownTargets(content);
      expect(targets.length).toBeGreaterThan(0);

      for (const relTarget of targets) {
        const resolved = path.resolve(path.dirname(docPath), relTarget);
        expect(fs.existsSync(resolved)).toBe(true);
      }

      const lower = content.toLowerCase();
      expect(lower).not.toContain('react-wasm');
      expect(lower).not.toContain('lottiemcpclient.ts');
      expect(lower).not.toContain('termvg inspect');
      expect(lower).not.toContain('termvg export');
      expect(lower).not.toContain('termvg mcp');
      expect(content).not.toMatch(/\.lottie(?![a-z0-9])/i);
    }
  });

  it('keeps docs/DETAILS.md updated with Sextant (2x3) and Background Preset (B) specs', () => {
    expect(details).toContain('Sextant');
    expect(details).toContain('160 × 120');
    expect(details).toContain('4/3');
    expect(details).toContain('transparent');
    expect(details).toContain('dark');
    expect(details).toContain('light');
    expect(details).toContain('checkerboard');
    expect(details).toContain('useMcpSearch.ts');
  });
});
