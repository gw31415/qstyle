/**
 * Deterministic chunk planner (plan.md Part IX §37-42 / §95 M8)。
 * 第一段階のみを担当する: usage set 完全一致 grouping (§38) と min/max sizing。
 * cost model (§40) / stability penalty (§41) / route weighting は後段で上書きする。
 *
 * 決定性の規律:
 * - 入力はすべて sort してから走査する (Map の挿入順に依存しない)。
 * - pack id は member 集合のみから導出する (source order / proseance を含まない)。
 */

import { fnv1aHex } from './atom.js';
import {
  groupByUsageSignature,
  jaccardSimilarity,
  usageSignature,
  type UsageGraph,
} from './usage.js';

/** chunk 対象 style の配信サイズ。 */
export interface ChunkInput {
  readonly id: string;
  readonly bytes: number;
}

export interface ChunkOptions {
  /** これ未満の pack は類似 pack と merge を試みる。 */
  readonly minChunkBytes: number;
  /** これを超える pack は分割する。 */
  readonly maxChunkBytes: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  minChunkBytes: 1024,
  maxChunkBytes: 32 * 1024,
};

export interface ChunkPlan {
  readonly id: string;
  /** sorted。pack の内容は member 集合だけで決まる。 */
  readonly members: readonly string[];
  readonly bytes: number;
}

interface Pack {
  /** sorted。 */
  readonly members: string[];
  readonly users: Set<string>;
  bytes: number;
}

/**
 * usage graph と style sizes から deterministic な chunk plan を作る。
 *
 * - usage を記録されていない style (graph 外の未知 id を含む) は 1 style = 1 pack の
 *   singleton になる。黙って落とさない (unused-CSS は別途 warning 対象)。
 * - `maxChunkBytes` を超える group は member を (bytes desc, id asc) 順で first-fit する。
 *   単体で max を超える member は単独 pack になり、そこへは追い詰め追加しない。
 * - `minChunkBytes` 未満の pack は、最も類似 (jaccardSimilarity) した partner へ
 *   smallest-first で merge する。similarity が 0 の partner とは merge しない。
 *   merge しても `min` に届かない pack はそのまま残す — request 爆発は pack 粒度で、
 *   unused CSS は warning で扱い、ここで無理に統合しない。
 */
export function planChunks(
  graph: UsageGraph,
  styles: readonly ChunkInput[],
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): ChunkPlan[] {
  validateOptions(opts);

  const bytesOf: Map<string, number> = new Map<string, number>();
  for (const style of styles) bytesOf.set(style.id, style.bytes);
  const styleIds: readonly string[] = [...bytesOf.keys()].sort();

  // §38: usage signature 完全一致 group。member は入力 styles に存在するものだけ採用する。
  const signatureGroups: Map<string, readonly string[]> = groupByUsageSignature(graph);
  const packs: Pack[] = [];
  for (const key of [...signatureGroups.keys()].sort()) {
    const candidates: readonly string[] = signatureGroups.get(key) ?? [];
    const members: string[] = candidates.filter((id) => bytesOf.has(id)).sort();
    if (members.length === 0) continue;
    // key は usageSignature の JSON。member list ではなく署名のほうが usage set になる。
    packs.push({
      members,
      users: new Set<string>(JSON.parse(key) as string[]),
      bytes: sumBytes(members, bytesOf),
    });
  }
  // 未知 / 未使用 style は singleton pack。usage が空なので signature group には現れない。
  for (const id of styleIds) {
    if (usageSignature(graph, id).length > 0) continue;
    packs.push({ members: [id], users: new Set<string>(), bytes: bytesOf.get(id) ?? 0 });
  }

  const sized: Pack[] = [];
  for (const pack of packs) sized.push(...splitPack(pack, opts.maxChunkBytes, bytesOf));
  return toPlans(mergePacks(sized, opts));
}

function validateOptions(opts: ChunkOptions): void {
  if (!Number.isFinite(opts.maxChunkBytes) || opts.maxChunkBytes < 1) {
    throw new Error(
      `maxChunkBytes must be a finite number >= 1, got ${String(opts.maxChunkBytes)}.`,
    );
  }
  if (!Number.isFinite(opts.minChunkBytes) || opts.minChunkBytes < 0) {
    throw new Error(
      `minChunkBytes must be a finite number >= 0, got ${String(opts.minChunkBytes)}.`,
    );
  }
  if (opts.minChunkBytes > opts.maxChunkBytes) {
    throw new Error(
      `minChunkBytes (${String(opts.minChunkBytes)}) must not exceed maxChunkBytes (${String(
        opts.maxChunkBytes,
      )}); a pack could never satisfy both.`,
    );
  }
}

/** max を超える group を first-fit descending で分割する。 */
function splitPack(pack: Pack, maxChunkBytes: number, bytesOf: Map<string, number>): Pack[] {
  if (pack.bytes <= maxChunkBytes) return [pack];
  const ordered: readonly string[] = [...pack.members].sort(
    (a, b) => (bytesOf.get(b) ?? 0) - (bytesOf.get(a) ?? 0) || compare(a, b),
  );
  const parts: Pack[] = [];
  for (const id of ordered) {
    const bytes: number = bytesOf.get(id) ?? 0;
    if (bytes > maxChunkBytes) {
      // 単体で max 超過。これ以上は分割できないので単独 pack にする (追い詰め追加しない)。
      parts.push({ members: [id], users: pack.users, bytes });
      continue;
    }
    let target: Pack | undefined;
    for (const part of parts) {
      // bytes > max の part は oversized 単独 pack。そこへは追加しない。
      if (part.bytes > maxChunkBytes) continue;
      if (part.bytes + bytes <= maxChunkBytes) {
        target = part;
        break;
      }
    }
    if (target === undefined) {
      target = { members: [], users: pack.users, bytes: 0 };
      parts.push(target);
    }
    target.members.push(id);
    target.bytes += bytes;
  }
  for (const part of parts) part.members.sort();
  return parts;
}

/**
 * min 未満の pack を類似 partner へ merge する。
 * merge 後に max を超えるならその partner は候補から外す (max は hard 制約)。
 */
function mergePacks(packs: Pack[], opts: ChunkOptions): Pack[] {
  const working: Pack[] = packs.slice();
  // partner が見つからず詰みになった pack。選択対象から外して停止させる。
  const stuck: Set<string> = new Set<string>();

  for (;;) {
    const current: Pack | undefined = smallestPack(working, opts.minChunkBytes, stuck);
    if (current === undefined) return working;
    const key: string = packKey(current.members);
    let best: Pack | undefined;
    let bestSimilarity: number = 0;
    for (const candidate of [...working].sort((a, b) => compare(packKey(a.members), packKey(b.members)))) {
      if (candidate === current) continue;
      const similarity: number = jaccardSimilarity(current.users, candidate.users);
      if (similarity <= 0) continue;
      if (current.bytes + candidate.bytes > opts.maxChunkBytes) continue;
      if (similarity <= bestSimilarity) continue;
      best = candidate;
      bestSimilarity = similarity;
    }
    if (best === undefined) {
      stuck.add(key);
      continue;
    }
    working.splice(working.indexOf(best), 1);
    current.members.push(...best.members);
    current.members.sort();
    current.bytes += best.bytes;
    for (const user of best.users) current.users.add(user);
  }
}

/** min 未満で詰みでない最も小さい pack (bytes asc, member key asc)。なければ undefined。 */
function smallestPack(packs: Pack[], minChunkBytes: number, stuck: Set<string>): Pack | undefined {
  let found: Pack | undefined;
  for (const pack of packs) {
    if (pack.bytes >= minChunkBytes) continue;
    const key: string = packKey(pack.members);
    if (stuck.has(key)) continue;
    if (found === undefined) {
      found = pack;
      continue;
    }
    const foundKey: string = packKey(found.members);
    if (pack.bytes < found.bytes || (pack.bytes === found.bytes && compare(key, foundKey) < 0)) {
      found = pack;
    }
  }
  return found;
}

function toPlans(packs: readonly Pack[]): ChunkPlan[] {
  const plans: ChunkPlan[] = packs.map((pack) => ({
    id: packId(pack.members),
    members: [...pack.members].sort(),
    bytes: pack.bytes,
  }));
  return plans.sort((a, b) => compare(a.id, b.id));
}

/** pack_<fnv1aHex(sorted member ids JSON).slice(0,6)> — member 集合のみで決まる。 */
function packId(members: readonly string[]): string {
  return `pack_${fnv1aHex(JSON.stringify([...members].sort())).slice(0, 6)}`;
}

function packKey(members: readonly string[]): string {
  return [...members].sort().join(' ');
}

function sumBytes(members: readonly string[], bytesOf: Map<string, number>): number {
  let total: number = 0;
  for (const id of members) total += bytesOf.get(id) ?? 0;
  return total;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
