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

/** `[param]` segment を持つ route pattern か。Qwik City の file 規約に合わせる。 */
function isRoutePattern(route: string): boolean {
  return route.split('/').some((segment) => /^\[[^\]/]+\]$/.test(segment));
}

/** pattern (`/item/[id]`) と pathname (`/item/42`) の照合。segment 数が同じで、
 * `[param]` が任意の非空 segment に一致すれば真 (trailing slash は吸収)。 */
function matchRoutePattern(pattern: string, pathname: string): boolean {
  const trim = (p: string): string => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
  const patternSegments: string[] = trim(pattern).split('/');
  const pathSegments: string[] = trim(pathname).split('/');
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every(
    (segment, i) => /^\[[^\]/]+\]$/.test(segment) || segment === pathSegments[i],
  );
}

/**
 * R1.4: pathname に必要な asset file names (root 相対) を manifest から引く純関数。
 * 完全一致を優先し、次に `[param]` pattern 照合 (RTE-004 dynamic route 用)。
 * prefix match はしない (MVP は `options.routes` に正確な path を書く運用)。
 * trailing slash の有無は吸収する。不一致は空配列。
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
  for (const candidate of routePathCandidates(pathname)) {
    for (const entry of manifest.entries) {
      if (isRoutePattern(entry.route) && matchRoutePattern(entry.route, candidate)) {
        return [...entry.assets];
      }
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
 * R1.5/R1.7 の出荷 artifact: client で実行される bootstrap の source。
 * 手書きの文字列リテラルであり、bundler の変換を一切受けない
 * (template literal・`${` を含まない。test が保証する)。
 *
 * なぜ関数の `.toString()` ではないのか: `_qrlSync(fn)` は fn の source を
 * そのまま HTML に埋め込むが、app build の bundler (esbuild keepNames 等) が
 * fn 本体へ `__name(...)` のような helper 呼び出しを注入すると、定義を伴わず
 * source だけが埋め込まれ、resume 時に `ReferenceError: __name` で落ちる
 * (haven-web preview で実証済み)。文字列なら downstream の変換対象外のため
 * この種の壊れ方が構造的に起きない。
 *
 * 形式の制約 (qwik の sync QRL 仕様): `_qrlSync(fn, serialized)` の
 * serialized は完全な function としてそのまま埋め込まれ、client で式として
 * eval される。文の並びだけでは `{...}` が object literal と解釈され
 * `Unexpected identifier` になるため、全体を `function(){...}` の無名関数式
 * で包む。test が `new Function('return (' + SOURCE + ')')` でこの形式を固定する。
 *
 * 規律: `qstyleRouteBootstrap` (下の TS 実装。型付きの参照実装) と等価に保つ。
 * links.test.ts が同一 scenario を両方に流して等価性を固定する。
 * 変更時は両方を同時に変えること。
 */
export const QSTYLE_ROUTE_BOOTSTRAP_SOURCE: string = [
  'function(){',
  'var marker = document.querySelector(\'meta[name="qstyle:prefetch"]\');',
  'if (marker === null) return;',
  'function markerAttr(name) {',
  '  return typeof marker.getAttribute === \'function\' ? marker.getAttribute(name) : null;',
  '}',
  'var rawBase = markerAttr(\'data-qstyle-base\');',
  'var basePath = (rawBase !== null && rawBase.charAt(0) === \'/\') ? ((rawBase.charAt(rawBase.length - 1) === \'/\') ? rawBase : rawBase + \'/\') : \'/\';',
  'var origin = location.origin;',
  'var base = origin + basePath;',
  'function toUrl(file) {',
  '  try { return new URL(file, base).toString(); } catch (e) { return null; }',
  '}',
  'var manifestPromise = null;',
  'function loadManifest() {',
  '  if (manifestPromise === null) {',
  '    manifestPromise = fetch(new URL(\'qstyle.routes.json\', base).toString()).then(function (res) { return res.ok ? res.json() : null; }).then(function (value) {',
  '      if (typeof value !== \'object\' || value === null) return null;',
  '      if (value.version !== 1 || !Array.isArray(value.entries)) return null;',
  '      return { entries: value.entries };',
  '    }).catch(function () { return null; });',
  '  }',
  '  return manifestPromise;',
  '}',
  'var pending = new Map();',
  'function hasLink(href) {',
  '  if (document.querySelector(\'link[data-qstyle-href="\' + href.replace(/"/g, \'%22\') + \'"]\') !== null) return true;',
  '  var existing = document.querySelectorAll(\'link[data-qstyle-href]\');',
  '  for (var i = 0; i < existing.length; i++) {',
  '    var marked = existing[i].getAttribute(\'data-qstyle-href\');',
  '    if (marked === null) continue;',
  '    try { if (new URL(marked, base).toString() === href) return true; } catch (e) {}',
  '  }',
  '  return false;',
  '}',
  'function ensure(href) {',
  '  if (hasLink(href)) return Promise.resolve();',
  '  var ongoing = pending.get(href);',
  '  if (ongoing !== undefined) return ongoing;',
  '  var load = new Promise(function (resolve) {',
  '    if (hasLink(href)) { resolve(); return; }',
  '    var link = document.createElement(\'link\');',
  '    link.rel = \'stylesheet\';',
  '    link.href = href;',
  '    link.setAttribute(\'data-qstyle-href\', href);',
  '    link.onload = function () { resolve(); };',
  '    link.onerror = function () { resolve(); };',
  '    document.head.appendChild(link);',
  '  });',
  '  pending.set(href, load);',
  '  load.then(function () { pending.delete(href); });',
  '  return load;',
  '}',
  'function isPattern(route) {',
  '  var segs = route.split(\'/\');',
  '  for (var i = 0; i < segs.length; i++) { if (/^\\[[^\\]/]+\\]$/.test(segs[i])) return true; }',
  '  return false;',
  '}',
  'function trimSlash(p) { return (p.length > 1 && p.charAt(p.length - 1) === \'/\') ? p.slice(0, -1) : p; }',
  'function matchPattern(pattern, pathname) {',
  '  var a = trimSlash(pattern).split(\'/\');',
  '  var b = trimSlash(pathname).split(\'/\');',
  '  if (a.length !== b.length) return false;',
  '  for (var i = 0; i < a.length; i++) {',
  '    if (/^\\[[^\\]/]+\\]$/.test(a[i])) continue;',
  '    if (a[i] !== b[i]) return false;',
  '  }',
  '  return true;',
  '}',
  'function assetsFor(entries, pathname) {',
  '  var path = pathname.length === 0 ? \'/\' : pathname;',
  '  var candidates = (path === \'/\') ? [\'/\'] : (path.charAt(path.length - 1) === \'/\' ? [path, path.slice(0, -1)] : [path, path + \'/\']);',
  '  var i, j, entry, assets, out;',
  '  for (i = 0; i < candidates.length; i++) {',
  '    for (j = 0; j < entries.length; j++) {',
  '      entry = entries[j];',
  '      if (typeof entry !== \'object\' || entry === null) continue;',
  '      if (entry.route !== candidates[i] || !Array.isArray(entry.assets)) continue;',
  '      out = [];',
  '      for (var k = 0; k < entry.assets.length; k++) { if (typeof entry.assets[k] === \'string\') out.push(entry.assets[k]); }',
  '      return out;',
  '    }',
  '  }',
  '  for (i = 0; i < candidates.length; i++) {',
  '    for (j = 0; j < entries.length; j++) {',
  '      entry = entries[j];',
  '      if (typeof entry !== \'object\' || entry === null) continue;',
  '      if (typeof entry.route !== \'string\' || !isPattern(entry.route)) continue;',
  '      if (!Array.isArray(entry.assets)) continue;',
  '      if (!matchPattern(entry.route, candidates[i])) continue;',
  '      out = [];',
  '      for (var k = 0; k < entry.assets.length; k++) { if (typeof entry.assets[k] === \'string\') out.push(entry.assets[k]); }',
  '      return out;',
  '    }',
  '  }',
  '  return [];',
  '}',
  'function applyAssets(assets) {',
  '  var hrefs = [];',
  '  for (var i = 0; i < assets.length; i++) {',
  '    var href = toUrl(assets[i]);',
  '    if (href !== null && hrefs.indexOf(href) < 0) hrefs.push(href);',
  '  }',
  '  Promise.all(hrefs.map(function (h) { return ensure(h); }));',
  '}',
  'function applyRoute(pathname) {',
  '  loadManifest().then(function (manifest) {',
  '    if (manifest === null) return;',
  '    applyAssets(assetsFor(manifest.entries, pathname));',
  '  });',
  '}',
  'var historyRef = history;',
  'var origPushState = historyRef.pushState;',
  'var origReplaceState = historyRef.replaceState;',
  'historyRef.pushState = function () {',
  '  var result = origPushState.apply(this, arguments);',
  '  applyRoute(location.pathname);',
  '  return result;',
  '};',
  'historyRef.replaceState = function () {',
  '  var result = origReplaceState.apply(this, arguments);',
  '  applyRoute(location.pathname);',
  '  return result;',
  '};',
  'window.addEventListener(\'popstate\', function () { applyRoute(location.pathname); });',
  'applyRoute(location.pathname);',
  'var strategy = markerAttr(\'content\');',
  'if (strategy === null) strategy = \'none\';',
  'if (strategy === \'load\') {',
  '  var schedule = (typeof requestIdleCallback === \'function\') ? function (cb) { requestIdleCallback(function () { cb(); }); } : function (cb) { setTimeout(cb, 200); };',
  '  schedule(function () {',
  '    loadManifest().then(function (manifest) {',
  '      if (manifest === null) return;',
  '      var all = [];',
  '      for (var i = 0; i < manifest.entries.length; i++) {',
  '        var entry = manifest.entries[i];',
  '        if (typeof entry !== \'object\' || entry === null) continue;',
  '        if (!Array.isArray(entry.assets)) continue;',
  '        for (var j = 0; j < entry.assets.length; j++) { if (typeof entry.assets[j] === \'string\') all.push(entry.assets[j]); }',
  '      }',
  '      applyAssets(all);',
  '    });',
  '  });',
  '} else if (strategy === \'hover\') {',
  '  document.addEventListener(\'pointerover\', function (event) {',
  '    var target = event.target;',
  '    if (typeof target !== \'object\' || target === null) return;',
  '    if (typeof target.closest !== \'function\') return;',
  '    var anchor = target.closest(\'a[href]\');',
  '    if (typeof anchor !== \'object\' || anchor === null) return;',
  '    if (typeof anchor.getAttribute !== \'function\') return;',
  '    var hrefValue = anchor.getAttribute(\'href\');',
  '    if (typeof hrefValue !== \'string\' || hrefValue.length === 0) return;',
  '    var pathname = null;',
  '    try {',
  '      var url = new URL(hrefValue, base);',
  '      if (url.origin === location.origin) pathname = url.pathname;',
  '    } catch (e) { return; }',
  '    if (pathname === null) return;',
  '    applyRoute(pathname);',
  '  });',
  '}',
  '}',
].join('\n');

/**
 * R1.5/R1.7: client navigation 監視 + prefetch の実体 (参照実装)。
 * 実行時には `QSTYLE_ROUTE_BOOTSTRAP_SOURCE` (上の手書き文字列) が
 * `_qrlSync` の serialize source として HTML に埋め込まれる。
 * この TS 関数は型付きの参照実装であり、unit test (`links.test.ts`) と
 * dev での直接実行に使う。両者の等価性は同一 scenario の test で固定する。
 *
 * なぜ sync QRL か: `inlinedQrl` タスクは chunk 解決不能で SSR/SSG シリアライズ
 * 時に Q14 (qrlMissingChunk) で落ちる。sync QRL は source が HTML に埋め込まれて
 * resume されるため server serializable。
 *
 * 自己完結の制約 (破ると client で名前解決できず crash する):
 * - module scope の import / closure 変数を参照しない (DOM + 引数 + local のみ)。
 *   下の source-lint test が関数と文字列の両方に適用される。
 * - 設定 (prefetch 戦略) は `<QstyleLinks />` が描画する meta marker から読む。
 *   (sync QRL は capture を持てないため)
 * - manifest 取得・link 注入の規則は `./client` + `./prefetch` と同値に保つ
 *   (data-qstyle-href 規則、失敗時 crash なし)。共通化は import になるため
 *   あえて複製している。
 */
export function qstyleRouteBootstrap(): void {
  // 設定は meta marker から読む。base は marker の data-qstyle-base
  // (build 時 BASE_URL。document.baseURI は nested route でずれるため使わない)。
  // marker は本番 build でのみ描画される (dev では QstyleLinks が null を返す)。
  // dev は per-module CSS pipeline が styles を担うため、marker 不在なら
  // 何もせず抜ける (routes.json は存在しないため fetch すると 404 になる)。
  const marker: Element | null = document.querySelector('meta[name="qstyle:prefetch"]');
  if (marker === null) return;
  // 以降 marker は非 null (上の early return で保証)。
  const getMarkerAttr = (name: string): string | null =>
    typeof marker.getAttribute === 'function' ? marker.getAttribute(name) : null;
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
    const pick = (assets: unknown): string[] =>
      Array.isArray(assets)
        ? assets.filter((asset: unknown): asset is string => typeof asset === 'string')
        : [];
    for (const candidate of candidates) {
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) continue;
        const record = entry as { route?: unknown; assets?: unknown };
        if (record.route !== candidate || !Array.isArray(record.assets)) continue;
        return pick(record.assets);
      }
    }
    // RTE-004: `[param]` pattern 照合 (QSTYLE_ROUTE_BOOTSTRAP_SOURCE と等価に保つ)。
    for (const candidate of candidates) {
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) continue;
        const record = entry as { route?: unknown; assets?: unknown };
        if (typeof record.route !== 'string' || !isRoutePattern(record.route)) continue;
        if (!Array.isArray(record.assets)) continue;
        if (!matchRoutePattern(record.route, candidate)) continue;
        return pick(record.assets);
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
  // Q14 対応: inlinedQrl タスクは SSR/SSG で serialize 不能のため sync QRL を
  // 登録する。serialize される source は `QSTYLE_ROUTE_BOOTSTRAP_SOURCE`
  // (手書き文字列) を明示指定する — `_qrlSync(fn)` の既定 (`fn.toString()`) は
  // app build の bundler が helper (`__name` 等) を注入すると壊れる。
  // prefetch 戦略は DOM marker 経由で bootstrap が読むため、ここでは引数を使わない。
  void prefetch;
  useVisibleTaskQrl(_qrlSync(qstyleRouteBootstrap, QSTYLE_ROUTE_BOOTSTRAP_SOURCE), {
    strategy: 'document-idle',
  });
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
