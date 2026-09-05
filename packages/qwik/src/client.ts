// @qstyle/qwik/client — css-asset backend の lazy module 直前読み込み (plan.md §3.4 R1.6 案 B)。
//
// transform 時点では chunk の fileName (content hash) が確定しないため、JS bundle 側には
// unit id のみを埋め、unit id -> fileName の解決は build が emit する `qstyle.units.json`
// (fetch 1 回、module singleton で cache) で行う。JS 側への後付け編集は行わないため
// chunk hash の完全性は壊れない (§3.3 データフロー)。
//
// SSR / SSG (`typeof document === 'undefined'`) では何もしない。style の HEAD link は
// R1.4 `<QstyleLinks />` (未実装) が SSR 時に描画する想定で、ここは client (browser) 専用。

/** `qstyle.units.json` の shape (vite plugin `qstyle:css-asset` が emit する)。 */
interface UnitsIndex {
  readonly version: number;
  readonly units: Readonly<Record<string, readonly string[]>>;
}

const UNITS_FILE = 'qstyle.units.json';

/** route-loader (ROUTE_LOADER_SOURCE) の loaderBaseUrl() と同じ base URL 規則。 */
function clientBaseUrl(): string {
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

function ensureStylesheet(href: string): Promise<void> {
  const pending: Promise<void> | undefined = pendingStylesheets.get(href);
  if (pending !== undefined) return pending;
  if (document.querySelector(`link[data-qstyle-href="${href.replace(/"/g, '%22')}"]`) !== null) {
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
        hrefs.add(new URL(fileName, clientBaseUrl()).toString());
      }
    }
    return Promise.all([...hrefs].map((href: string): Promise<void> => ensureStylesheet(href))).then(
      (): void => undefined,
    );
  });
}
