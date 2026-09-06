// @qstyle/qwik/client — css-asset backend の lazy module 直前読み込み (plan.md §3.4 R1.6 案 B)。
//
// transform 時点では chunk の fileName (content hash) が確定しないため、JS bundle 側には
// unit id のみを埋め、unit id -> fileName の解決は build が emit する `qstyle.units.json`
// (fetch 1 回、module singleton で cache) で行う。JS 側への後付け編集は行わないため
// chunk hash の完全性は壊れない (§3.3 データフロー)。
//
// SSR / SSG (`typeof document === 'undefined'`) では何もしない。style の HEAD link は
// R1.4 `<QstyleLinks />` (`./links`) が SSR 時に描画し、R1.5 の client navigation loader
// (`useQstyleRouteStyles`) と R1.7 の prefetch (`./prefetch`) がここで export する
// `ensureStylesheet` / `resolveAssetUrl` を link 注入の実体として使う。

/** `qstyle.units.json` の shape (vite plugin `qstyle:css-asset` が emit する)。 */
interface UnitsIndex {
  readonly version: number;
  readonly units: Readonly<Record<string, readonly string[]>>;
}

const UNITS_FILE = 'qstyle.units.json';

/** route-loader (ROUTE_LOADER_SOURCE) の loaderBaseUrl() と同じ base URL 規則。 */
export function clientBaseUrl(): string {
  try {
    // import.meta.env は vite 系 bundler でのみ定義される。node/cjs では undefined。
    const env: unknown = (import.meta as unknown as { env?: unknown }).env;
    const base: string =
      typeof env === 'object' && env !== null && 'BASE_URL' in env
        ? String((env as { readonly BASE_URL?: unknown }).BASE_URL ?? '/')
        : '/';
    return new URL(base, document.baseURI).toString();
  } catch {
    return '/';
  }
}

/** fetch 済み units index の module singleton cache (成功・失敗を問わず 1 回だけ fetch する)。 */
let unitsIndexPromise: Promise<UnitsIndex | null> | null = null;

function loadUnitsIndex(): Promise<UnitsIndex | null> {
  if (unitsIndexPromise === null) {
    unitsIndexPromise = fetch(new URL(UNITS_FILE, clientBaseUrl()).toString())
      .then(
        (res: Response): Promise<UnitsIndex | null> | null =>
          res.ok ? (res.json() as Promise<UnitsIndex>) : null,
      )
      .catch((): UnitsIndex | null => null);
  }
  return unitsIndexPromise;
}

/** 読み込み中の <link> promise。同一 href の二重追加 (競合 race) を防ぐ。 */
const pendingStylesheets = new Map<string, Promise<void>>();

/**
 * asset の root 相対 file name (`assets/qstyle.<hash>.css`) を現在の base で解決した
 * 絶対 URL へ変換する (R1.5 useQstyleRouteStyles / R1.7 prefetch が利用)。
 */
export function resolveAssetUrl(fileName: string): string {
  return new URL(fileName, clientBaseUrl()).toString();
}

/**
 * 既に適用済み (or 読み込み中) の stylesheet link かどうか。
 * R1.4 の `<QstyleLinks />` が SSR/SSG で焼く link は root 相対の `data-qstyle-href`
 * (絶対 URL を server 側では組めないため) のため、文字列一致に加えて base 解決後の
 * URL 比較でも既存 link を判定する (client 側注入との二重適用防止)。
 */
function hasStylesheet(href: string): boolean {
  if (document.querySelector(`link[data-qstyle-href="${href.replace(/"/g, '%22')}"]`) !== null) {
    return true;
  }
  const base: string = clientBaseUrl();
  const existing: NodeListOf<HTMLLinkElement> = document.querySelectorAll('link[data-qstyle-href]');
  for (const link of existing) {
    const marked: string | null = link.getAttribute('data-qstyle-href');
    if (marked === null) continue;
    try {
      if (new URL(marked, base).toString() === href) return true;
    } catch {
      // 不正な URL 文字列が入っていた場合は比較から除外するだけ (crash しない)
    }
  }
  return false;
}

/**
 * (未読なら) `<link rel="stylesheet">` を head に追加する。R1.5 の client navigation
 * loader と R1.7 の prefetch が使う link 注入の実体。同一 href (data-qstyle-href 規則、
 * SSR 焼き込みの root 相対 href も base 解決で一致判定) の二重追加を排除する。
 */
export function ensureStylesheet(href: string): Promise<void> {
  // SSR / server 環境では即 resolve (ensureModuleStyles と同規則)。client 側の
  // useQstyleRouteStyles / prefetch は browser でしか呼ばないが、export API として
  // 安全にしておく。
  if (typeof document === 'undefined') return Promise.resolve();
  const pending: Promise<void> | undefined = pendingStylesheets.get(href);
  if (pending !== undefined) return pending;
  if (hasStylesheet(href)) {
    return Promise.resolve();
  }
  const load: Promise<void> = new Promise<void>((resolve: () => void) => {
    // load 失敗 (404 等) でも crash しない: link 欠落で続行 (FOUC は許容、§3.4 R1.5 と同規則)。
    const link: HTMLLinkElement = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.qstyleHref = href;
    link.onload = (): void => resolve();
    link.onerror = (): void => resolve();
    document.head.appendChild(link);
  });
  pendingStylesheets.set(href, load);
  void load.then((): void => {
    pendingStylesheets.delete(href);
  });
  return load;
}

/**
 * module の unit 群に必要な CSS asset を (未読なら) `<link rel="stylesheet">` として
 * head に追加する。transform が module 先頭に `ensureModuleStyles([...unitIds])` を注入する。
 * - SSR/server 環境では即 resolve (no-op)
 * - `qstyle.units.json` の fetch に失敗したら console.error して resolve (crash しない)
 * - 同一 href の link は 1 回だけ追加する
 */
export function ensureModuleStyles(unitIds: readonly string[]): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  return loadUnitsIndex().then((index: UnitsIndex | null): Promise<void> => {
    if (index === null || typeof index !== 'object' || typeof index.units !== 'object' || index.units === null) {
      console.error(`[qstyle] failed to load ${UNITS_FILE}`);
      return Promise.resolve();
    }
    // 追加順 = unitIds の確定順。同一 href の二重追加は ensureStylesheet が排除する。
    const hrefs = new Set<string>();
    for (const unitId of unitIds) {
      for (const fileName of index.units[unitId] ?? []) {
        hrefs.add(resolveAssetUrl(fileName));
      }
    }
    return Promise.all([...hrefs].map((href: string): Promise<void> => ensureStylesheet(href))).then(
      (): void => undefined,
    );
  });
}
