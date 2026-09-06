// @qstyle/qwik/links — route 単位の style 配線 (plan.md §3.3 R1.4 / R1.5 / R1.7)。
//
// R1.4: `<QstyleLinks />` — 現在 route の style assets を `<link rel="stylesheet">`
//   として SSR/SSG の HTML に焼き込む component。root layout に 1 つ置くだけでよい。
// R1.5: `useQstyleRouteStyles()` — client navigation を監視し、遷移先 route の
//   assets を `./client` の `ensureStylesheet` で注入する (link 注入の実体は共通)。
// R1.7: `prefetch` prop — `./prefetch` の prefetchRouteStyles による先読み。
//
// manifest の取得は 2 経路 (§3.3 R1.4):
// - SSG (in-process render): vite plugin (qstyle:css-asset) が generateBundle で設定する
//   `globalThis.__QSTYLE_ROUTES__` を同期で読む。render が同期でも link が静的 HTML に焼かれる。
// - SSR runtime / client: `qstyle.routes.json` を fetch して module singleton に cache。
//   SSR の component render は同期のため fetch は間に合かず、globalThis がなければ
//   何も描かない (client 側 useVisibleTask$ で補完する二段構え)。
//
// end-to-end (SSG で link が焼かれる、navigation で注入される等) は QWK-001..004 /
// RTE-004..007 相当として C0.1/C0.2 Playwright 基盤で検証する (unit test は純関数と
// module 境界のみ)。qwik city public API (`useLocation`) のみを使い、内部 manifest
// (q-manifest.json 等) には依存しない (§3.5 リスク方針)。
//
// 実装上の注意 (precompiled library pattern): 本 package は qwik optimizer を通らず
// tsdown で build されるため、`component$` / `useVisibleTask$` 等 `$` 系 API は
// 実行時に throw される (optimizer が変換前提)。そのため @qwik.dev/router の
// prebuilt dist と同じく `componentQrl` / `useVisibleTaskQrl` + `inlinedQrl` を使い、
// closure は inlinedQrl の capture array → fn 内で `_captures` 経由で読む。

import { inlinedQrl, isDev, type Component, type JSXOutput, type TaskCtx } from '@qwik.dev/core';
import { _captures, componentQrl, useVisibleTaskQrl } from '@qwik.dev/core/internal';
import { useLocation, type RouteLocation } from '@qwik.dev/router';
import { clientBaseUrl, ensureStylesheet, resolveAssetUrl } from './client.js';
import { prefetchRouteStyles, type RouteStylePrefetch } from './prefetch.js';

/** `qstyle.routes.json` の 1 entry (build が emit する shape。§3.2 R1.3)。 */
export interface QstyleRouteEntry {
  readonly route: string;
  readonly assets: readonly string[];
}

/**
 * route manifest。`@qstyle/core` の `StyleManifest` と構造互換。compilerVersion 等、
 * この layer で使わない field が増えても壊れないよう未知 field は無視して読む。
 */
export interface QstyleRouteManifest {
  readonly version: number;
  readonly entries: readonly QstyleRouteEntry[];
}

const ROUTES_FILE = 'qstyle.routes.json';

/**
 * manifest 相当の unknown 値を検証して読む。shape 外は null (crash しない)。
 * vite 側 `serializeManifest` が emit する JSON と、`globalThis.__QSTYLE_ROUTES__`
 * (object として設定される) の両方を受け付ける。
 */
export function parseRouteManifest(value: unknown): QstyleRouteManifest | null {
  if (typeof value !== 'object' || value === null) return null;
  const record: { readonly version?: unknown; readonly entries?: unknown } =
    value as { readonly version?: unknown; readonly entries?: unknown };
  if (record.version !== 1) return null;
  if (!Array.isArray(record.entries)) return null;
  const entries: QstyleRouteEntry[] = [];
  for (const raw of record.entries) {
    if (typeof raw !== 'object' || raw === null) return null;
    const entry: { readonly route?: unknown; readonly assets?: unknown } = raw as {
      readonly route?: unknown;
      readonly assets?: unknown;
    };
    if (typeof entry.route !== 'string' || !Array.isArray(entry.assets)) return null;
    const assets: string[] = [];
    for (const asset of entry.assets) {
      if (typeof asset !== 'string') return null;
      assets.push(asset);
    }
    entries.push({ route: entry.route, assets: [...new Set<string>(assets)] });
  }
  return { version: 1, entries };
}

/** trailing slash の有無を吸収した一致候補。`/` は `/` のまま。空文字は `/` 扱い。 */
function routePathCandidates(pathname: string): readonly string[] {
  const path: string = pathname.length === 0 ? '/' : pathname;
  if (path === '/') return ['/'];
  const stripped: string = path.endsWith('/') ? path.slice(0, -1) : path;
  // 入力そのものを先に試し、次に slash の有無を反転した候補。
  return path === stripped ? [path, `${path}/`] : [path, stripped];
}

/**
 * R1.4: pathname に必要な asset file names (root 相対) を manifest から引く純関数。
 * 完全一致のみ (prefix match はしない — MVP は `options.routes` に正確な path を
 * 書く運用)。trailing slash の有無は吸収する。不一致は空配列。
 */
export function resolveRouteLinks(
  manifest: QstyleRouteManifest,
  pathname: string,
): readonly string[] {
  for (const candidate of routePathCandidates(pathname)) {
    for (const entry of manifest.entries) {
      if (entry.route === candidate) return [...entry.assets];
    }
  }
  return [];
}

/**
 * R1.4: SSG (in-process render) 用 manifest。vite plugin が設定する
 * `globalThis.__QSTYLE_ROUTES__` を同期で読む。未設定・shape 外は null。
 * SSR の component render は同期のため、この経路があれば静的 HTML に焼ける。
 */
export function readSyncRouteManifest(): QstyleRouteManifest | null {
  const raw: unknown = (globalThis as { __QSTYLE_ROUTES__?: unknown }).__QSTYLE_ROUTES__;
  return raw === undefined ? null : parseRouteManifest(raw);
}

/** fetch 済み route manifest の module singleton cache (成功・失敗問わず 1 回だけ fetch)。 */
let routesManifestPromise: Promise<QstyleRouteManifest | null> | null = null;

/** `qstyle.routes.json` の URL。server (document 無し) では相対解決できないため null。 */
function routesManifestUrl(): string | null {
  try {
    return new URL(ROUTES_FILE, clientBaseUrl()).toString();
  } catch {
    return null;
  }
}

/**
 * R1.5: manifest 取得。`globalThis.__QSTYLE_ROUTES__` (SSG in-process) を優先し、
 * なければ `qstyle.routes.json` を 1 回だけ fetch して cache する。
 * fetch 失敗・shape 不正は console.error のみで null を返す (crash しない)。
 */
export function loadRouteManifest(): Promise<QstyleRouteManifest | null> {
  const sync: QstyleRouteManifest | null = readSyncRouteManifest();
  if (sync !== null) return Promise.resolve(sync);
  const url: string | null = routesManifestUrl();
  if (url === null) {
    console.error(`[qstyle] failed to load ${ROUTES_FILE}`);
    return Promise.resolve(null);
  }
  if (routesManifestPromise === null) {
    routesManifestPromise = fetch(url)
      .then((res: Response): Promise<unknown> | null => (res.ok ? res.json() : null))
      .then((value: unknown): QstyleRouteManifest | null => {
        const manifest: QstyleRouteManifest | null = parseRouteManifest(value);
        if (manifest === null) {
          console.error(`[qstyle] failed to load ${ROUTES_FILE}`);
        }
        return manifest;
      })
      .catch((): QstyleRouteManifest | null => {
        console.error(`[qstyle] failed to load ${ROUTES_FILE}`);
        return null;
      });
  }
  return routesManifestPromise;
}

/**
 * R1.5: route (pathname) に必要な assets を manifest から解決し、未読の
 * `<link rel="stylesheet">` を注入する (`./client` ensureStylesheet の
 * `data-qstyle-href` 規則で dedup — route-loader の loadRouteStyles と同じ規則)。
 * 戻り値は注入対象に解決した href の一覧。manifest が取れない場合は空配列。
 */
export async function loadRouteStyles(pathname: string): Promise<readonly string[]> {
  const manifest: QstyleRouteManifest | null = await loadRouteManifest();
  if (manifest === null) return [];
  const assets: readonly string[] = resolveRouteLinks(manifest, pathname);
  let hrefs: readonly string[];
  try {
    hrefs = assets.map((asset: string): string => resolveAssetUrl(asset));
  } catch {
    return [];
  }
  await Promise.all(hrefs.map((href: string): Promise<void> => ensureStylesheet(href)));
  return hrefs;
}

/** SSR/SSG 描画用の href。server 側では絶対 URL を組めないため root 相対で組む。 */
function assetHref(asset: string): string {
  const env: unknown = (import.meta as unknown as { env?: unknown }).env;
  const base: string =
    typeof env === 'object' && env !== null && 'BASE_URL' in env
      ? String((env as { readonly BASE_URL?: unknown }).BASE_URL ?? '/')
      : '/';
  const withLeading: string = base.startsWith('/') ? base : `/${base}`;
  const withTrailing: string = withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
  return `${withTrailing}${asset}`;
}

/**
 * R1.5: client navigation loader。`useLocation().url.pathname` の変更を監視し、
 * 変更先 route の assets を link 注入する。`<QstyleLinks />` が内部で呼ぶため
 * 通常は直接使わない (単体で有効化したい場合のみ export)。
 * dev (import.meta.env.DEV) では per-module CSS pipeline が styles を担うため no-op。
 *
 * useVisibleTask$ の precompiled 相当 (useVisibleTaskQrl) を使う。この component は
 * 視覚要素を持たないため、既定の intersection-observer 戦略だと発火が host element
 * の可視性に依存してしまう。document-idle で発火させ (eager 不要)、発火後は track に
 * より navigation ごとに再実行される。
 */
export function useQstyleRouteStyles(prefetch: RouteStylePrefetch = 'none'): void {
  const loc = useLocation();
  useVisibleTaskQrl(
    inlinedQrl(
      (ctx: TaskCtx): void => {
        const captured: readonly [RouteLocation, RouteStylePrefetch] | null = _captures as
          | readonly [RouteLocation, RouteStylePrefetch]
          | null;
        if (captured === null) return;
        const [capturedLoc, strategy]: readonly [RouteLocation, RouteStylePrefetch] = captured;
        if (isDev) return;
        let disposed: boolean = false;
        let dispose: (() => void) | null = null;
        const activatePrefetch = (): void => {
          if (strategy === 'none') return;
          void loadRouteManifest().then((manifest: QstyleRouteManifest | null): void => {
            if (manifest === null || disposed || typeof document === 'undefined') return;
            dispose?.();
            dispose = prefetchRouteStyles(document, manifest, { strategy });
          });
        };
        const pathname: string = ctx.track((): string => capturedLoc.url.pathname);
        void loadRouteStyles(pathname);
        activatePrefetch();
        ctx.cleanup((): void => {
          disposed = true;
          dispose?.();
          dispose = null;
        });
      },
      'useQstyleRouteStyles_useVisibleTask_qstyle',
      [loc, prefetch],
    ),
    { strategy: 'document-idle' },
  );
}

/** `<QstyleLinks />` の props (componentQrl の Record 制約のため type alias で定義)。 */
export type QstyleLinksProps = {
  /**
   * R1.7: route style の先読み戦略。default 'none'。
   * - 'hover': link hover 時に destination route の assets を先読み
   * - 'load': idle 時に全 route assets を先読み
   */
  readonly prefetch?: RouteStylePrefetch;
};

/**
 * R1.4: 現在 route の style assets を SSR/SSG HTML に `<link rel="stylesheet">` として
 * 描画する component。root layout に置く (R1.5 loader / R1.7 prefetch も内部で有効化)。
 *
 * - SSG (in-process): `globalThis.__QSTYLE_ROUTES__` から同期解決し link を焼き込む
 * - SSR runtime (非 SSG): render が同期のため globalThis がなければ何も描かず、
 *   client 側 (useQstyleRouteStyles) で補完する二段構え
 * - dev または manifest が空: 何も描画しない
 * - href は root 相対 (asset 名に build base を結合)。client 側注入の絶対 URL との
 *   二重適用は `./client` hasStylesheet の base 解決比較で排除される
 */
export const QstyleLinks: Component<QstyleLinksProps> = componentQrl(
  inlinedQrl(
    (props: QstyleLinksProps): JSXOutput => {
      const loc = useLocation();
      useQstyleRouteStyles(props.prefetch ?? 'none');
      if (isDev) return null;
      const manifest: QstyleRouteManifest | null = readSyncRouteManifest();
      if (manifest === null || manifest.entries.length === 0) return null;
      const assets: readonly string[] = resolveRouteLinks(manifest, loc.url.pathname);
      if (assets.length === 0) return null;
      return (
        <>
          {assets.map((asset: string) => (
            <link
              key={asset}
              rel="stylesheet"
              href={assetHref(asset)}
              data-qstyle-href={assetHref(asset)}
            />
          ))}
        </>
      );
    },
    'QstyleLinks_component_qstyle',
  ),
);
