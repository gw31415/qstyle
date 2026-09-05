/**
 * Content-hash asset naming と Route Style Manifest (plan.md §42, §45, §50 / §96 M9)。
 * 純関数のみを担当する。Vite への asset emission は @qstyle/vite 側で行う。
 *
 * 決定性の規律:
 * - chunk hash は最終 serialize 済み CSS bytes からのみ計算する (§43: membership を含まない)。
 * - manifest の entry / asset 順は入力 Map の挿入順に依存しない (常に sort)。
 */

import { fnv1aHex } from './atom.js';

/** chunk hash の入力。最終 serialize 済み CSS bytes。 */
export interface ChunkHashInput {
  readonly cssText: string;
}

/** §50: content hash が URL に含まれるため、変更時は URL が変わる。 */
export const IMMUTABLE_CACHE_HEADER: string = 'public, max-age=31536000, immutable';

const MANIFEST_VERSION = 1;

/**
 * §42: ChunkHash = H(finalSerializedCss)。
 * membership / source order ではなく、配信される CSS bytes だけから計算する (§3.3 の分離)。
 */
export function chunkHash(cssText: string): string {
  return `q_${fnv1aHex(cssText)}`;
}

/** §42: content-addressed asset 名。prefix は logical 名 (base / route など)。 */
export function assetFileName(prefix: string, hash: string): string {
  return `${prefix}.${hash}.css`;
}

/** 1 route が必要とする asset 群。sorted / deduped。 */
export interface RouteManifestEntry {
  readonly route: string;
  readonly assets: readonly string[];
}

/** §45: route → required style packs。HASH-011: compiler version を記録する。 */
export interface StyleManifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly compilerVersion: string;
  readonly entries: readonly RouteManifestEntry[];
}

/**
 * routeId -> asset file names から manifest を組む。
 * - entry は route asc。asset は dedupe + sort。
 * - asset を 1 つも持たない route は entry を作らない (RTE-008: 不要な asset link を出さない)。
 */
export function buildRouteManifest(
  routes: ReadonlyMap<string, readonly string[]>,
  opts: { readonly compilerVersion: string },
): StyleManifest {
  const entries: RouteManifestEntry[] = [];
  for (const route of [...routes.keys()].sort()) {
    const assets: readonly string[] | undefined = toAssets(routes.get(route) ?? []);
    if (assets === undefined || assets.length === 0) continue;
    entries.push({ route, assets });
  }
  return { version: MANIFEST_VERSION, compilerVersion: opts.compilerVersion, entries };
}

/**
 * manifest を stable JSON へ。2-space indent, key order は構成順で固定。
 * parse -> serialize を繰り返しても byte 等価になる。
 */
export function serializeManifest(manifest: StyleManifest): string {
  return JSON.stringify(
    {
      version: manifest.version,
      compilerVersion: manifest.compilerVersion,
      entries: manifest.entries.map((entry) => ({
        route: entry.route,
        assets: [...entry.assets],
      })),
    },
    null,
    2,
  );
}

/**
 * route が必要とする asset file names を返す。未知 route は空配列。
 * css-asset backend の route-loader が利用する純関数 (§45)。
 */
export function resolveRouteAssets(manifest: StyleManifest, route: string): readonly string[] {
  for (const entry of manifest.entries) {
    if (entry.route === route) return [...entry.assets];
  }
  return [];
}

/**
 * manifest text を検証して読み込む。shape 外は null (FLB-007: corrupt cache は caller が捨てる)。
 * 読み込んだ manifest も sorted / deduped 不変を保つ。
 */
export function parseManifest(text: string): StyleManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record: Record<string, unknown> = parsed as Record<string, unknown>;
  if (record['version'] !== MANIFEST_VERSION) return null;
  if (typeof record['compilerVersion'] !== 'string') return null;
  if (!Array.isArray(record['entries'])) return null;

  const entries: RouteManifestEntry[] = [];
  for (const raw of record['entries']) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const entry: Record<string, unknown> = raw as Record<string, unknown>;
    if (typeof entry['route'] !== 'string' || !Array.isArray(entry['assets'])) return null;
    const assets: readonly string[] | undefined = toAssets(entry['assets']);
    if (assets === undefined) return null;
    entries.push({ route: entry['route'], assets });
  }
  return { version: MANIFEST_VERSION, compilerVersion: record['compilerVersion'], entries };
}

/** 文字列のみの配列を dedupe + sort へ。文字列以外が混ざれば undefined。 */
function toAssets(assets: readonly unknown[]): readonly string[] | undefined {
  for (const asset of assets) {
    if (typeof asset !== 'string') return undefined;
  }
  return [...new Set<string>(assets as readonly string[])].sort();
}
