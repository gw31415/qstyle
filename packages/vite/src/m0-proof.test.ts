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

describe('M0 css-asset production proof (plan.md §3.4 R1.1-R1.3/R1.6)', () => {
  it(
    'vite.build() emits qstyle chunk assets, units index, and asset-name routes manifest',
    async (): Promise<void> => {
      const { build } = await import('vite');
      const here: string = path.dirname(fileURLToPath(import.meta.url));
      const fixtureDir: string = path.resolve(here, '../../../fixtures/m0-css-asset');
      const distDir: string = path.join(fixtureDir, 'dist');

      await build({
        root: fixtureDir,
        logLevel: 'silent',
        build: {
          outDir: 'dist',
          emptyOutDir: true,
        },
      });

      // (a) chunk planner が決定した qstyle asset が出る (vite CSS 配管外の自家 emit)。
      const assetsDir: string = path.join(distDir, 'assets');
      const assetFiles: string[] = fs
        .readdirSync(assetsDir)
        .filter((f: string): boolean => /^qstyle\.q_[0-9a-f]+\.css$/.test(f));
      expect(assetFiles.length).toBeGreaterThan(0);
      const allCss: string = assetFiles
        .map((f: string): string => fs.readFileSync(path.join(assetsDir, f), 'utf8'))
        .join('\n');
      expect(allCss).toMatch(/\.q_[0-9a-f]{8}\{display:flex/);

      // (b) JS に CSS text が混入しない (単一 style.css への統合が消える)。
      const jsFiles: string[] = collectJsFiles(distDir);
      expect(jsFiles.length).toBeGreaterThan(0);
      const allJs: string = jsFiles
        .map((f: string): string => fs.readFileSync(f, 'utf8'))
        .join('\n');
      expect(allJs).not.toContain('display:flex');
      // transform が注入した lazy module stub (R1.6 案 B: unit id のみ。minify で helper 名は
      // 短縮されるため、unit id 配列呼び出しと units index 参照で検証する)。
      expect(allJs).toMatch(/\(\[["`]q_[0-9a-f]{8}["`]\]\)/);
      expect(allJs).toContain('qstyle.units.json');
      expect(allJs).not.toContain('virtual:qstyle/pack/');

      // (c) qstyle.units.json の units が実在 file 名と一致する。
      const unitsRaw: string = fs.readFileSync(path.join(distDir, 'qstyle.units.json'), 'utf8');
      const units: { units: Record<string, string[]> } = JSON.parse(unitsRaw) as {
        units: Record<string, string[]>;
      };
      const unitIds: string[] = Object.keys(units.units);
      expect(unitIds.length).toBeGreaterThan(0);
      for (const unitId of unitIds) {
        expect(unitId).toMatch(/^q_[0-9a-f]{8}$/);
        for (const fileName of units.units[unitId] ?? []) {
          // dist 相対 path (client helper は BASE_URL 基準で URL 解決する)
          expect(fileName).toMatch(/^assets\/qstyle\.q_[0-9a-f]+\.css$/);
          expect(assetFiles).toContain(path.basename(fileName));
          expect(fs.existsSync(path.join(distDir, fileName))).toBe(true);
        }
      }

      // (d) routes option を渡すと qstyle.routes.json の assets が実在 file 名と一致する。
      const routesRaw: string = fs.readFileSync(path.join(distDir, 'qstyle.routes.json'), 'utf8');
      const routes: { entries: { route: string; assets: string[] }[] } = JSON.parse(
        routesRaw,
      ) as { entries: { route: string; assets: string[] }[] };
      expect(routes.entries.length).toBeGreaterThan(0);
      for (const entry of routes.entries) {
        expect(entry.assets.length).toBeGreaterThan(0);
        for (const asset of entry.assets) {
          expect(assetFiles).toContain(path.basename(asset));
        }
      }
    },
    120_000,
  );
});
