// @qstyle/qwik/prefetch — route style の prefetch option (plan.md §3.3 R1.7)。
//
// `<QstyleLinks prefetch={...}>` prop (default 'none') 経由で useQstyleRouteStyles
// から有効化される。vite 側 QstyleOptions との対応は README の css-asset 節に記載
// (vite 側の option とは独立に、qwik 側 component prop だけで制御できる)。
//
// - 'hover': `<a href>` の pointerover で、href が manifest の route に一致すれば
//   その assets を `<link rel="stylesheet">` で先読みする。rel=stylesheet での先読み
//   のため事前に適用され、遷移時の FOUC を防ぐ
// - 'load': idle 時 (requestIdleCallback、無ければ setTimeout fallback) に manifest の
//   全 assets を先読みする
//
// FOUC 解消の end-to-end 検証は RTE-006 として C0.1/C0.2 Playwright 基盤で行う
// (unit test は純粋な委譲/スケジューリング境界のみ)。

import { ensureStylesheet, resolveAssetUrl } from './client.js';
import { resolveRouteLinks, type QstyleRouteManifest } from './links.js';

/** R1.7: prefetch 戦略。 */
export type RouteStylePrefetch = 'none' | 'hover' | 'load';

export interface RouteStylePrefetchOptions {
  /** prefetch 戦略。default 'none' (何もしない)。 */
  readonly strategy?: RouteStylePrefetch;
  /**
   * 先読みの実体。default は `./client` の `ensureStylesheet`。
   * unit test で差し替えて注入対象を観測するために公開している。
   */
  readonly ensure?: (href: string) => Promise<void> | void;
}

/** pointerover 委譲で捕捉する event 名。 */
const PREFETCH_EVENT = 'pointerover';

/** requestIdleCallback が無い環境での fallback 遅延 (ms)。 */
const PREFETCH_IDLE_FALLBACK_MS = 200;

function noop(): void {}

/** href attribute を読める anchor 相当 (DOM の HTMLAnchorElement と test mock の両方)。 */
interface AnchorLike {
  getAttribute(name: 'href'): string | null;
}

/** pointerover target から anchor を引く。DOM は closest で遡り、mock は target 自身。 */
function anchorFromTarget(target: unknown): AnchorLike | null {
  if (typeof target !== 'object' || target === null) return null;
  const el: {
    closest?: (selector: string) => unknown;
    getAttribute?: (name: string) => unknown;
  } = target as { closest?: (selector: string) => unknown; getAttribute?: (name: string) => unknown };
  if (typeof el.closest === 'function') {
    const anchor: unknown = el.closest('a[href]');
    if (typeof anchor !== 'object' || anchor === null) return null;
    const a: { getAttribute?: (name: string) => unknown } = anchor as {
      getAttribute?: (name: string) => unknown;
    };
    return typeof a.getAttribute === 'function' ? (a as AnchorLike) : null;
  }
  return typeof el.getAttribute === 'function' ? (el as AnchorLike) : null;
}

/** href を pathname に解決。解決不能・他 origin は null。 */
function hrefPathname(href: string): string | null {
  const base: string =
    typeof document !== 'undefined' && typeof document.baseURI === 'string'
      ? document.baseURI
      : '/';
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (typeof location !== 'undefined' && url.origin !== location.origin) return null;
  return url.pathname;
}

/** idle callback を schedule し、取消関数を返す。 */
function scheduleIdle(callback: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id: number = requestIdleCallback((): void => callback());
    return (): void => {
      cancelIdleCallback(id);
    };
  }
  const id: ReturnType<typeof setTimeout> = setTimeout((): void => callback(), PREFETCH_IDLE_FALLBACK_MS);
  return (): void => {
    clearTimeout(id);
  };
}

/** scope に pointerover listener を付け、全解除する関数を返す。 */
function bindPointerover(
  scope: Document | readonly HTMLAnchorElement[],
  handler: (event: Event) => void,
): () => void {
  if (Array.isArray(scope)) {
    for (const anchor of scope) {
      anchor.addEventListener(PREFETCH_EVENT, handler);
    }
    return (): void => {
      for (const anchor of scope) {
        anchor.removeEventListener(PREFETCH_EVENT, handler);
      }
    };
  }
  // Array.isArray false は実運用では Document (readonly array は TS 上 narrow から
  // 除外されないため明示的に扱う)。
  const doc: Document = scope as Document;
  doc.addEventListener(PREFETCH_EVENT, handler);
  return (): void => {
    doc.removeEventListener(PREFETCH_EVENT, handler);
  };
}

/**
 * R1.7: route style の prefetch を setup し、解除関数を返す。
 *
 * @param scope 'hover' の監視対象。`Document` なら document 上の pointerover を委譲
 *   捕捉し、anchor 配列なら各 anchor に直接 listener を付ける (unit test 用)
 * @param manifest build が emit する `qstyle.routes.json` 相当
 * @param options 戦略と先読み関数の差し替え
 */
export function prefetchRouteStyles(
  scope: Document | readonly HTMLAnchorElement[],
  manifest: QstyleRouteManifest,
  options: RouteStylePrefetchOptions = {},
): () => void {
  const strategy: RouteStylePrefetch = options.strategy ?? 'none';
  if (strategy === 'none') return noop;
  const ensure: (href: string) => Promise<void> | void =
    options.ensure ?? ((href: string): Promise<void> => ensureStylesheet(href));
  const prefetchAssets = (assets: readonly string[]): void => {
    for (const asset of new Set<string>(assets)) {
      void ensure(resolveAssetUrl(asset));
    }
  };

  if (strategy === 'hover') {
    const onPointerOver = (event: Event): void => {
      const target: unknown = event.target;
      const anchor: AnchorLike | null = anchorFromTarget(target);
      if (anchor === null) return;
      const href: string | null = anchor.getAttribute('href');
      if (href === null || href.length === 0) return;
      const pathname: string | null = hrefPathname(href);
      if (pathname === null) return;
      prefetchAssets(resolveRouteLinks(manifest, pathname));
    };
    return bindPointerover(scope, onPointerOver);
  }

  // 'load': manifest の全 entry の assets を idle 時に一括先読み。
  const allAssets: string[] = [];
  for (const entry of manifest.entries) {
    for (const asset of entry.assets) {
      allAssets.push(asset);
    }
  }
  return scheduleIdle((): void => prefetchAssets(allAssets));
}
