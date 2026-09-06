import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * route 分離 chunk の実 build 検証 (plan.md §4.1 / §3.4)。
 * fixtures/route-css-asset: 2 route (`/`, `/about`) + route-local component 各 1 +
 * 両 route 共有 component 各 1。§4.1 の unit id usage 配線修正後は
 * module ことの chunk + 共有 chunk に分離し、局所変更が無関係 chunk の hash を
 * 動かさないことを content hash 付き file 名で固定する。
 * - RTE-001: route-local unit が他 route の初期 asset に混入しない
 * - RTE-002/003: shared unit は単一 chunk になり manifest が正確
 * - HASH-007: route A の style 変更 → route B の chunk file 名が不変
 * - HASH-008: shared component の style 変更 → 関係 chunk (shared + 両 route の
 *   entries) のみ変化し、route-local chunk は不変
 */
const fixtureDir: string = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/route-css-asset',
);
const distDir: string = path.join(fixtureDir, 'dist');
const assetsDir: string = path.join(distDir, 'assets');
const QSTYLE_ASSET_RE: RegExp = /^qstyle\.q_[0-9a-f]+\.css$/;

interface RouteEntry {
  readonly route: string;
  readonly assets: readonly string[];
}

interface Snapshot {
  /** assets/ 直下の qstyle chunk file 名。 */
  readonly cssFiles: readonly string[];
  /** fileName -> css text。 */
  readonly cssTextOf: Readonly<Record<string, string>>;
  readonly routes: readonly RouteEntry[];
}

async function buildFixture(): Promise<void> {
  const { build } = await import('vite');
  await build({
    root: fixtureDir,
    logLevel: 'silent',
    build: { outDir: 'dist', emptyOutDir: true },
  });
}

/** build 直後の dist から snapshot を読む (emptyOutDir で消えるため都度読む)。 */
function readSnapshot(): Snapshot {
  const cssFiles: string[] = fs
    .readdirSync(assetsDir)
    .filter((f: string): boolean => QSTYLE_ASSET_RE.test(f));
  const cssTextOf: Record<string, string> = {};
  for (const file of cssFiles) {
    cssTextOf[file] = fs.readFileSync(path.join(assetsDir, file), 'utf8');
  }
  const routes: readonly RouteEntry[] = (
    JSON.parse(fs.readFileSync(path.join(distDir, 'qstyle.routes.json'), 'utf8')) as {
      entries: RouteEntry[];
    }
  ).entries;
  return { cssFiles, cssTextOf, routes };
}

/** base build は file 内で 1 回だけ (以降は in-memory snapshot を使う)。 */
let baseCache: Snapshot | null = null;
async function baseSnapshot(): Promise<Snapshot> {
  if (baseCache === null) {
    await buildFixture();
    baseCache = readSnapshot();
  }
  return baseCache;
}

function assetsOf(snapshot: Snapshot, route: string): readonly string[] {
  return snapshot.routes.find((entry) => entry.route === route)?.assets ?? [];
}

/** manifest の asset 参照は dist 相対 (assets/<file>)。file 名と揃えるための正規化。 */
function assetRef(fileName: string): string {
  return `assets/${fileName}`;
}

/** needle を含む chunk file 名。見つからなければ test 失敗。 */
function fileContaining(snapshot: Snapshot, needle: string): string {
  const file: string | undefined = snapshot.cssFiles.find((f) =>
    (snapshot.cssTextOf[f] ?? '').includes(needle),
  );
  if (file === undefined) throw new Error(`no chunk contains ${JSON.stringify(needle)}`);
  return file;
}

/** fixture source を一時改変して build し、終了時に必ず復元する。 */
async function withVariant(
  file: string,
  replace: (source: string) => string,
  fn: () => Promise<void>,
): Promise<void> {
  const full: string = path.join(fixtureDir, 'src', file);
  const original: string = fs.readFileSync(full, 'utf8');
  try {
    fs.writeFileSync(full, replace(original));
    await buildFixture();
    await fn();
  } finally {
    fs.writeFileSync(full, original);
  }
}

describe('route-separated css-asset proof (plan.md §4.1 / RTE-001..003 manifest)', () => {
  it(
    'separates route-local chunks and shares one chunk for shared units',
    async (): Promise<void> => {
      const base: Snapshot = await baseSnapshot();

      // module ことの chunk: home (route `/` local) / about (route `/about` local) / shared。
      expect(base.cssFiles).toHaveLength(3);
      const homeFile: string = fileContaining(base, 'crimson');
      const aboutFile: string = fileContaining(base, 'teal');
      const sharedFile: string = fileContaining(base, 'border:1px solid gray');
      expect(new Set([homeFile, aboutFile, sharedFile]).size).toBe(3);

      // RTE-002/003: shared chunk は両 route の初期 asset に現れ、entries は正確。
      expect([...assetsOf(base, '/')].sort()).toEqual(
        [assetRef(homeFile), assetRef(sharedFile)].sort(),
      );
      expect([...assetsOf(base, '/about')].sort()).toEqual(
        [assetRef(aboutFile), assetRef(sharedFile)].sort(),
      );
      // RTE-001: route-local chunk は他 route の初期 asset に混入しない。
      expect(assetsOf(base, '/')).not.toContain(assetRef(aboutFile));
      expect(assetsOf(base, '/about')).not.toContain(assetRef(homeFile));

      // units index: 各 unit は恰好 1 chunk に属し、実在 file を指す。
      const units: Record<string, string[]> = (
        JSON.parse(fs.readFileSync(path.join(distDir, 'qstyle.units.json'), 'utf8')) as {
          units: Record<string, string[]>;
        }
      ).units;
      expect(Object.keys(units).length).toBeGreaterThan(0);
      for (const fileNames of Object.values(units)) {
        expect(fileNames).toHaveLength(1);
        expect(base.cssFiles).toContain(path.basename(fileNames[0] ?? ''));
      }

      // R1.4 (§3.4): build 中に globalThis.__QSTYLE_ROUTES__ へ qstyle.routes.json と
      // 同一内容の manifest が設定される (in-process SSG render 用)。
      const globalRoutes: unknown = (globalThis as { __QSTYLE_ROUTES__?: unknown })
        .__QSTYLE_ROUTES__;
      expect(globalRoutes).toEqual(
        JSON.parse(fs.readFileSync(path.join(distDir, 'qstyle.routes.json'), 'utf8')),
      );
    },
    120_000,
  );

  it(
    'HASH-007: route A style change keeps route B chunk hashes unchanged',
    async (): Promise<void> => {
      const base: Snapshot = await baseSnapshot();
      const baseHomeFile: string = fileContaining(base, 'crimson');
      const baseAboutFile: string = fileContaining(base, 'teal');
      const baseSharedFile: string = fileContaining(base, 'border:1px solid gray');

      await withVariant(
        'home.jsx',
        (source) => source.replace('crimson', 'darkred'),
        async (): Promise<void> => {
          const varied: Snapshot = readSnapshot();
          const variedHomeFile: string = fileContaining(varied, 'darkred');
          // route A の chunk (hash) は変化する。
          expect(variedHomeFile).not.toBe(baseHomeFile);
          // route B local / shared の chunk は byte 不変 (= hash 不変)。
          expect(varied.cssTextOf[baseAboutFile]).toBe(base.cssTextOf[baseAboutFile]);
          expect(varied.cssTextOf[baseSharedFile]).toBe(base.cssTextOf[baseSharedFile]);
          // route B の初期 asset 一覧 (file 名) も完全不変。
          expect(assetsOf(varied, '/about')).toEqual(assetsOf(base, '/about'));
          // route A の entries は新 home chunk 参照に置き換わる。
          expect(assetsOf(varied, '/')).toContain(assetRef(variedHomeFile));
          expect(assetsOf(varied, '/')).not.toContain(assetRef(baseHomeFile));
        },
      );
    },
    120_000,
  );

  it(
    'HASH-008: shared style change invalidates only the shared chunk and route entries',
    async (): Promise<void> => {
      const base: Snapshot = await baseSnapshot();
      const baseHomeFile: string = fileContaining(base, 'crimson');
      const baseAboutFile: string = fileContaining(base, 'teal');
      const baseSharedFile: string = fileContaining(base, 'border:1px solid gray');

      await withVariant(
        'shared.jsx',
        (source) => source.replace('1px solid gray', '2px dotted slategray'),
        async (): Promise<void> => {
          const varied: Snapshot = readSnapshot();
          const variedSharedFile: string = fileContaining(varied, 'border:2px dotted slategray');
          // shared chunk (hash) は変化する。
          expect(variedSharedFile).not.toBe(baseSharedFile);
          // 無関係な route-local chunk は byte 不変 (= hash 不変)。
          expect(varied.cssTextOf[baseHomeFile]).toBe(base.cssTextOf[baseHomeFile]);
          expect(varied.cssTextOf[baseAboutFile]).toBe(base.cssTextOf[baseAboutFile]);
          // shared を使う両 route の entries のみ新 shared chunk へ置き換わる。
          for (const route of ['/', '/about']) {
            expect(assetsOf(varied, route)).toContain(assetRef(variedSharedFile));
            expect(assetsOf(varied, route)).not.toContain(assetRef(baseSharedFile));
            expect(assetsOf(varied, route)).not.toContain(
              assetRef(route === '/' ? baseAboutFile : baseHomeFile),
            );
          }
        },
      );
    },
    120_000,
  );
});
