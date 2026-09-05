/**
 * Incremental cache (plan.md §57 / §97 M10)。
 * cache key = H(source content hash + compiler version + config hash
 *               + frontend adapter version + target browsers)。
 *
 * 決定性の規律:
 * - key は fnv1aHex(JSON.stringify([...])) から計算し、同入力なら常に同 key。
 * - HMR-008: source 変更時は graph 全再構築の代わりに局所無効化する。
 *   呼び出し側は key 文字列に sourceHash を埋め込んでおくことで
 *   invalidateBySource が substring match できる。
 * - FLB-007: 破損 cache text は safeParse で null に落とし、caller が捨てて再計算する。
 */

import { fnv1aHex } from './atom.js';

/** computeCacheKey の入力。5 要素すべてが key に入る (§57)。 */
export interface ComputeCacheKeyInput {
  readonly sourceHash: string;
  readonly compilerVersion: string;
  readonly configHash: string;
  readonly frontendVersion: string;
  readonly targetBrowsers: string;
}

/** §57: cache key = H(sourceHash, compilerVersion, configHash, frontendVersion, targetBrowsers)。 */
export function computeCacheKey(input: ComputeCacheKeyInput): string {
  return fnv1aHex(
    JSON.stringify([
      input.sourceHash,
      input.compilerVersion,
      input.configHash,
      input.frontendVersion,
      input.targetBrowsers,
    ]),
  );
}

const DEFAULT_TTL_MS = 300_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * instance ごとの store。invalidateBySource (class 外) からも読むため WeakMap で保持する。
 * MemoryCache の public API は get/set/has/delete/clear/size の 6 個に保つ。
 */
const stores: WeakMap<MemoryCache, Map<string, CacheEntry>> = new WeakMap<
  MemoryCache,
  Map<string, CacheEntry>
>();

/** in-memory incremental cache。TTL 超過 entry は読み出し時に捨てる。 */
export class MemoryCache {
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    stores.set(this, new Map<string, CacheEntry>());
  }

  /** TTL 内の value を返す。期限切れ entry は返さず削除する。 */
  get(key: string): unknown {
    const entry = stores.get(this)?.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() >= entry.expiresAt) {
      stores.get(this)?.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: unknown): void {
    stores.get(this)?.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  has(key: string): boolean {
    const entry = stores.get(this)?.get(key);
    if (entry === undefined) return false;
    if (Date.now() >= entry.expiresAt) {
      stores.get(this)?.delete(key);
      return false;
    }
    return true;
  }

  delete(key: string): void {
    stores.get(this)?.delete(key);
  }

  clear(): void {
    stores.get(this)?.clear();
  }

  size(): number {
    const store = stores.get(this);
    if (store === undefined) return 0;
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now >= entry.expiresAt) store.delete(key);
    }
    return store.size;
  }
}

/**
 * HMR-008: key に sourceHash を含む entry だけを削除し、削除数を返す。
 * 他 source の entry は残る。空文字列は全 key に match するため何もしない。
 */
export function invalidateBySource(cache: MemoryCache, sourceHash: string): number {
  const store = stores.get(cache);
  if (store === undefined || sourceHash === '') return 0;
  let removed = 0;
  for (const key of [...store.keys()]) {
    if (key.includes(sourceHash)) {
      store.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/** FLB-007: 破損 cache text は例外ではなく null。caller は捨てて再計算する。 */
export function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
