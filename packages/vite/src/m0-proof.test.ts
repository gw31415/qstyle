import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticAtom, hashStaticAtom } from '@qstyle/core';

function collectJsFiles(dir: string): string[] {
  const out: string[] = [];
  const entries: fs.Dirent[] = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full: string = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

describe('M0 minimal production proof (plan.md §87)', () => {
  it(
    'vite.build() emits manifest, atom class, and pack css',
    async (): Promise<void> => {
      const { build } = await import('vite');
      const here: string = path.dirname(fileURLToPath(import.meta.url));
      const fixtureDir: string = path.resolve(here, '../../../fixtures/m0-minimal');

      await build({
        root: fixtureDir,
        logLevel: 'silent',
        build: {
          outDir: 'dist',
          emptyOutDir: true,
        },
      });

      // (a) dist/qstyle-manifest.json が存在する
      const manifestPath: string = path.join(fixtureDir, 'dist', 'qstyle-manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const atom = createStaticAtom({
        property: 'display',
        value: 'flex',
        provenance: [],
      });
      const atomId: string = hashStaticAtom(atom);

      // (b) ビルド済み JS に unit class 文字列が含まれる (1 適用単位 1 class, §38)
      const jsFiles: string[] = collectJsFiles(path.join(fixtureDir, 'dist'));
      expect(jsFiles.length).toBeGreaterThan(0);
      const allJs: string = jsFiles.map((f: string): string => fs.readFileSync(f, 'utf8')).join('\n');
      const unitClass: RegExpMatchArray | null = allJs.match(/q_[0-9a-f]{8}/);
      expect(unitClass).not.toBeNull();

      // (c) pack css が実 asset として出る (import graph 経由。lazy bundle は直前読み込み)。
      const cssFiles: string[] = fs
        .readdirSync(path.join(fixtureDir, 'dist', 'assets'))
        .filter((f: string): boolean => f.endsWith('.css'));
      expect(cssFiles.length).toBeGreaterThan(0);
      const allCss: string = cssFiles
        .map((f: string): string =>
          fs.readFileSync(path.join(fixtureDir, 'dist', 'assets', f), 'utf8'),
        )
        .join('\n');
      expect(allCss).toContain('display:flex');

      // (d) manifest の unit members に元 atom id が残る (identity は atom 単位)。
      const manifestRaw: string = fs.readFileSync(manifestPath, 'utf8');
      expect(manifestRaw).toContain(atomId);
    },
    120_000,
  );
});

