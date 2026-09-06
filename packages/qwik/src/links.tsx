// @qstyle/qwik/links — route 単位の style 配線 (plan.md §3.3 R1.4 / R1.5 / R1.7)。
//
// R1.4: `<QstyleLinks />` — 現在 route の style assets を `<link rel="stylesheet">`
//   として SSR/SSG の HTML に焼き込む component。root layout に 1 つ置くだけでよい。
// R1.5: client navigation 監視 — 遷移先 route の assets を link 注入する。
//   `qstyleRouteBootstrap` (自己完結 sync QRL) が担う。`<QstyleLinks />` が内部で
//   `useVisibleTaskQrl` 登録するため通常は直接使わない。
// R1.7: `prefetch` prop — bootstrap が meta marker から戦略を読んで先読みする。
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

import { inlinedQrl, isDev, type Component, type JSXOutput } from '@qwik.dev/core';
import { _qrlSync, componentQrl, useVisibleTaskQrl } from '@qwik.dev/core/internal';
import { useLocation } from '@qwik.dev/router';
import { clientBaseUrl, ensureStylesheet, resolveAssetUrl } from './client.js';
import type { RouteStylePrefetch } from './prefetch.js';

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

/** build base (`/` 始まり・`/` 終わり)。SSR 焼き込みと client 解決で共有する。 */
function assetBase(): string {
  const env: unknown = (import.meta as unknown as { env?: unknown }).env;
  const base: string =
    typeof env === 'object' && env !== null && 'BASE_URL' in env
      ? String((env as { readonly BASE_URL?: unknown }).BASE_URL ?? '/')
      : '/';
  const withLeading: string = base.startsWith('/') ? base : `/${base}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

/** SSR/SSG 描画用の href。server 側では絶対 URL を組めないため root 相対で組む。 */
function assetHref(asset: string): string {
  return `${assetBase()}${asset}`;
}

/** bootstrap (sync QRL) への設定伝達用 meta marker の name。 */
const PREFETCH_MARKER = 'qstyle:prefetch';

/**
 * R1.5/R1.7: client navigation 監視 + prefetch の実体。`useVisibleTaskQrl` に
 * `_qrlSync` で登録する自己完結 bootstrap。
 *
 * なぜ sync QRL か: 本 package は qwik optimizer を通らず tsdown で build されるため、
 * `inlinedQrl` タスクは chunk 解決不能で SSR/SSG シリアライズ時に Q14
 * (qrlMissingChunk) で落ちる。sync QRL は fn source が HTML に埋め込まれて
 * resume されるため server serializable。
 *
 * 自己完結の制約 (破ると client で名前解決できず crash する):
 * - module scope の import / closure 変数を参照しない (DOM + 引数 + local のみ)。
 *   下の source-lint test (`qstyleRouteBootstrap` の toString 検査) が保証する。
 * - 設定 (prefetch 戦略) は `<QstyleLinks />` が描画する meta marker から読む。
 *   (sync QRL は capture を持てないため)
 * - manifest 取得・link 注入の規則は `./client` + `./prefetch` と同値に保つ
 *   (data-qstyle-href 規則、失敗時 crash なし)。共通化は import になるため
 *   あえて複製している。
 */
export function qstyleRouteBootstrap(): void {
  // 設定は meta marker から読む。base は marker の data-qstyle-base
  // (build 時 BASE_URL。document.baseURI は nested route でずれるため使わない)。
  const marker: Element | null = document.querySelector('meta[name="qstyle:prefetch"]');
  const getMarkerAttr = (name: string): string | null =>
    marker !== null && typeof marker.getAttribute === 'function'
      ? marker.getAttribute(name)
      : null;
  const rawBase: string | null = getMarkerAttr('data-qstyle-base');
  const basePath: string =
    rawBase !== null && rawBase.startsWith('/')
      ? rawBase.endsWith('/')
        ? rawBase
        : `${rawBase}/`
      : '/';
  const origin: string = location.origin;
  const toUrl = (file: string): string | null => {
    try {
      return new URL(file, origin + basePath).toString();
    } catch {
      return null;
    }
  };
  const base: string = origin + basePath;
  let manifestPromise: Promise<{ entries: readonly unknown[] } | null> | null = null;
  const loadManifest = (): Promise<{ entries: readonly unknown[] } | null> => {
    if (manifestPromise === null) {
      manifestPromise = fetch(new URL('qstyle.routes.json', base).toString())
        .then((res: Response): Promise<unknown> | null => (res.ok ? res.json() : null))
        .then((value: unknown): { entries: readonly unknown[] } | null => {
          if (typeof value !== 'object' || value === null) return null;
          const record = value as { version?: unknown; entries?: unknown };
          if (record.version !== 1 || !Array.isArray(record.entries)) return null;
          return { entries: record.entries };
        })
        .catch((): null => null);
    }
    return manifestPromise;
  };
  /** 読み込み中の href。bootstrap と ensureModuleStyles の競合二重追加を防ぐ。 */
  const pending = new Map<string, Promise<void>>();
  const hasLink = (href: string): boolean => {    if (
      document.querySelector(`link[data-qstyle-href="${href.replace(/"/g, '%22')}"]`) !== null
    ) {
      return true;
    }
    const existing: NodeListOf<HTMLLinkElement> = document.querySelectorAll(
      'link[data-qstyle-href]',
    );
    for (const link of existing) {
      const marked: string | null = link.getAttribute('data-qstyle-href');
      if (marked === null) continue;
      try {
        if (new URL(marked, base).toString() === href) return true;
      } catch {
        // 不正 URL は比較から除外するだけ (crash しない)
      }
    }
    return false;
  };
  const ensure = (href: string): Promise<void> => {
    if (hasLink(href)) return Promise.resolve();
    const ongoing: Promise<void> | undefined = pending.get(href);
    if (ongoing !== undefined) return ongoing;
    const load: Promise<void> = new Promise<void>((resolve: () => void) => {
      // 二重検査: 解決待ちの間に他経路 (ensureModuleStyles 等) が追加済みの可能性。
      if (hasLink(href)) {
        resolve();
        return;
      }
      const link: HTMLLinkElement = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.setAttribute('data-qstyle-href', href);
      link.onload = (): void => resolve();
      link.onerror = (): void => resolve();
      document.head.appendChild(link);
    });
    pending.set(href, load);
    void load.then((): void => {
      pending.delete(href);
    });
    return load;
  };
  const assetsFor = (entries: readonly unknown[], pathname: string): string[] => {
    const path: string = pathname.length === 0 ? '/' : pathname;
    const candidates: readonly string[] =
      path === '/'
        ? ['/']
        : path.endsWith('/')
          ? [path, path.slice(0, -1)]
          : [path, `${path}/`];
    for (const candidate of candidates) {
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) continue;
        const record = entry as { route?: unknown; assets?: unknown };
        if (record.route !== candidate || !Array.isArray(record.assets)) continue;
        return record.assets.filter(
          (asset: unknown): asset is string => typeof asset === 'string',
        );
      }
    }
    return [];
  };
  const applyAssets = (assets: readonly string[]): void => {
    const hrefs: string[] = [];
    for (const asset of assets) {
      const href: string | null = toUrl(asset);
      if (href !== null && !hrefs.includes(href)) hrefs.push(href);
    }
    void Promise.all(hrefs.map((href: string): Promise<void> => ensure(href)));
  };
  const applyRoute = (pathname: string): void => {
    void loadManifest().then((manifest): void => {
      if (manifest === null) return;
      applyAssets(assetsFor(manifest.entries, pathname));
    });
  };
  // navigation 監視: Qwik City の client nav は history API を使う。
  const historyRef = history;
  const origPushState = historyRef.pushState;
  const origReplaceState = historyRef.replaceState;
  historyRef.pushState = function (
    ...args: Parameters<History['pushState']>
  ): ReturnType<History['pushState']> {
    const result: ReturnType<History['pushState']> = origPushState.apply(this, args);
    applyRoute(location.pathname);
    return result;
  };
  historyRef.replaceState = function (
    ...args: Parameters<History['replaceState']>
  ): ReturnType<History['replaceState']> {
    const result: ReturnType<History['replaceState']> = origReplaceState.apply(this, args);
    applyRoute(location.pathname);
    return result;
  };
  window.addEventListener('popstate', (): void => applyRoute(location.pathname));
  // idle 発火時点の route を初回適用する。
  applyRoute(location.pathname);
  const strategy: string = getMarkerAttr('content') ?? 'none';
  if (strategy === 'load') {
    const schedule: (callback: () => void) => void =
      typeof requestIdleCallback === 'function'
        ? (callback: () => void): void => {
            requestIdleCallback((): void => callback());
          }
        : (callback: () => void): void => {
            setTimeout(callback, 200);
          };
    schedule((): void => {
      void loadManifest().then((manifest): void => {
        if (manifest === null) return;
        const all: string[] = [];
        for (const entry of manifest.entries) {
          if (typeof entry !== 'object' || entry === null) continue;
          const assets: unknown = (entry as { assets?: unknown }).assets;
          if (!Array.isArray(assets)) continue;
          for (const asset of assets) {
            if (typeof asset === 'string') all.push(asset);
          }
        }
        applyAssets(all);
      });
    });
  } else if (strategy === 'hover') {
    document.addEventListener('pointerover', (event: Event): void => {
      const target: unknown = event.target;
      if (typeof target !== 'object' || target === null) return;
      const closest: unknown = (target as { closest?: unknown }).closest;
      if (typeof closest !== 'function') return;
      const anchor: unknown = (closest as (selector: string) => unknown).call(target, 'a[href]');
      if (typeof anchor !== 'object' || anchor === null) return;
      const href: unknown = (anchor as { getAttribute?: unknown }).getAttribute;
      if (typeof href !== 'function') return;
      const hrefValue: unknown = (href as (name: string) => unknown).call(anchor, 'href');
      if (typeof hrefValue !== 'string' || hrefValue.length === 0) return;
      let pathname: string | null = null;
      try {
        const url: URL = new URL(hrefValue, base);
        if (url.origin === location.origin) pathname = url.pathname;
      } catch {
        return;
      }
      if (pathname === null) return;
      applyRoute(pathname);
    });
  }
}

/**
 * R1.5: client navigation loader。`<QstyleLinks />` が内部で呼ぶため
 * 通常は直接使わない (単体で有効化したい場合のみ export)。
 */
export function useQstyleRouteStyles(prefetch: RouteStylePrefetch = 'none'): void {
  // Q14 対応: inlinedQrl タスクは SSR/SSG で serialize 不能のため、自己完結な
  // sync QRL (`qstyleRouteBootstrap`) を登録する。prefetch 戦略は DOM marker
  // (`<QstyleLinks />` が描画) 経由で bootstrap が読むため、ここでは引数を使わない。
  void prefetch;
  useVisibleTaskQrl(_qrlSync(qstyleRouteBootstrap), { strategy: 'document-idle' });
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
 * - SSR runtime: entry.ssr が `qstyle.routes.json` を globalThis へ復元するため、
 *   同じく link を焼き込む。復元不能時は marker のみ描き、client bootstrap が
 *   初回適用する二段構え
 * - client navigation 後も SSR 焼き link を維持する: client render では manifest が
 *   同期取得できないため、Qwik 管理下の link (`data-qstyle-vdom` 付き) のみ
 *   描き直す。bootstrap / ensureModuleStyles 追加の orphan を描き直すと
 *   reconciler が対応付けできず重複するため触らない (orphan は有効なまま残る)。
 *   未使用 chunk の残留は許容する (content-hash + immutable のため再訪時は cache hit)。
 *   client では `loc.url` を読まず route 変更を購読しない (再 render が
 *   bootstrap 追加の marker 無し DOM と不整合して重複 link を生むため)。
 *   navigation 後の追加は bootstrap (pushState 監視) が担う
 * - prefetch 戦略と build base は meta marker で client に伝える
 *   (sync QRL は capture を持てないため)
 * - dev: 何も描画しない
 * - href は root 相対 (asset 名に build base を結合)。client 側注入の絶対 URL との
 *   二重適用は base 解決比較で排除される
 */
export const QstyleLinks: Component<QstyleLinksProps> = componentQrl(
  inlinedQrl((props: QstyleLinksProps): JSXOutput => {
    // hook は無条件に呼ぶ (呼び出し順の安定)。loc.url の読み取りは server のみ:
    // client で読むと route 変更の購読になり、navigation 毎に再 render される。
    // 再 render 出力と bootstrap 追加の marker 無し DOM が reconciler で対応
    // 付かず重複 link が増えるため、client では loc に触らない。
    const loc = useLocation();
    useQstyleRouteStyles(props.prefetch ?? 'none');
    if (isDev) return null;
    const marker = (
      <meta
        name={PREFETCH_MARKER}
        content={props.prefetch ?? 'none'}
        data-qstyle-base={assetBase()}
      />
    );
    if (typeof document !== 'undefined') {
      // client render: Qwik 管理下の link (data-qstyle-vdom 付き。SSR 焼き or
      // 過去 render 分) のみ描き直す。bootstrap / ensureModuleStyles が追加した
      // orphan (attr 無し) を描き直すと reconciler が対応付けできず重複するため
      // 触らない (orphan は styles として有効なまま残る)。
      // DOM 読みは縮小方向のみ (同一内容の再出力) のため render の純粋性を壊さない。
      const kept: string[] = [];
      const seen = new Set<string>();
      for (const link of [...document.querySelectorAll('link[data-qstyle-vdom]')]) {
        const href: string | null = link.getAttribute('data-qstyle-href');
        if (href === null || seen.has(href)) continue;
        seen.add(href);
        kept.push(href);
      }
      return (
        <>
          {marker}
          {kept.map((href: string) => (
            <link
              key={href}
              rel="stylesheet"
              href={href}
              data-qstyle-href={href}
              data-qstyle-vdom="1"
            />
          ))}
        </>
      );
    }
    const manifest: QstyleRouteManifest | null = readSyncRouteManifest();
    if (manifest !== null && manifest.entries.length > 0) {
      const assets: readonly string[] = resolveRouteLinks(manifest, loc.url.pathname);
      return (
        <>
          {marker}
          {assets.map((asset: string) => (
            <link
              key={asset}
              rel="stylesheet"
              href={assetHref(asset)}
              data-qstyle-href={assetHref(asset)}
              data-qstyle-vdom="1"
            />
          ))}
        </>
      );
    }
    // manifest が無い SSR (復元不能): marker のみ。client bootstrap が初回適用する。
    return marker;
  }, 'QstyleLinks_component_qstyle'),
);
