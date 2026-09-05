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

      // (b) ビルド済み JS に atom class 文字列が含まれる
      const jsFiles: string[] = collectJsFiles(path.join(fixtureDir, 'dist'));
      expect(jsFiles.length).toBeGreaterThan(0);
      const allJs: string = jsFiles.map((f: string): string => fs.readFileSync(f, 'utf8')).join('\n');
      expect(allJs).toContain(atomId);

      // (c) virtual pack 由来の display:flex ルールがバンドルに含まれる
      expect(allJs).toContain('display:flex');

      const manifestRaw: string = fs.readFileSync(manifestPath, 'utf8');
      expect(manifestRaw).toContain(atomId);
    },
    120_000,
  );
});
