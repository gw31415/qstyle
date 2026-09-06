import { describe, expect, it } from 'vitest';
import { DEFAULT_CHUNK_OPTIONS, planChunks } from './chunk.js';
import {
  createUsageGraph,
  recordComponentRoute,
  recordUsage,
  routeSignature,
} from './usage.js';

const ROOMY = { minChunkBytes: 0, maxChunkBytes: 4096 };

function input(id: string, bytes: number) {
  return { id, bytes };
}

/** plans は pack id 順で返るので、member 比較用に並べ替える。 */
function memberSets(plans: readonly { members: readonly string[] }[]): string[][] {
  return plans.map((plan) => [...plan.members]).sort();
}

describe('planChunks', () => {
  it('groups styles with an identical usage set into one pack (§38)', () => {
    const graph = createUsageGraph();
    recordUsage(graph, 's2', 'Button');
    recordUsage(graph, 's1', 'Button');
    recordUsage(graph, 's3', 'Card');
    const plans = planChunks(graph, [input('s1', 10), input('s2', 10), input('s3', 10)], ROOMY);
    expect(plans).toHaveLength(2);
    const shared: string[] = plans.flatMap((plan) => plan.members).filter((id) => id !== 's3');
    expect(shared).toEqual(['s1', 's2']);
    expect(plans.map((plan) => plan.bytes).sort((a, b) => a - b)).toEqual([10, 20]);
  });

  it('keeps styles with different usage sets in separate packs', () => {
    const graph = createUsageGraph();
    recordUsage(graph, 'a', 'Button');
    recordUsage(graph, 'b', 'Card');
    const plans = planChunks(graph, [input('a', 10), input('b', 10)], ROOMY);
    expect(plans).toHaveLength(2);
    expect(memberSets(plans)).toEqual([['a'], ['b']]);
  });

  it('is deterministic under shuffled input order', () => {
    const graph = createUsageGraph();
    for (const style of ['s1', 's2', 's3', 's4']) {
      recordUsage(graph, style, 'Button');
      recordUsage(graph, style, 'Card');
    }
    recordUsage(graph, 's5', 'Card');
    const styles = [
      input('s1', 500),
      input('s2', 300),
      input('s3', 400),
      input('s4', 200),
      input('s5', 100),
    ];
    const shuffled = [styles[3]!, styles[0]!, styles[4]!, styles[2]!, styles[1]!];
    expect(planChunks(graph, shuffled, ROOMY)).toEqual(planChunks(graph, styles, ROOMY));
  });

  it('splits a group exceeding maxChunkBytes into packs within the limit', () => {
    const graph = createUsageGraph();
    for (let i = 0; i < 10; i += 1) recordUsage(graph, `s${i}`, 'Button');
    const styles = Array.from({ length: 10 }, (_, i) => input(`s${i}`, 30));
    const plans = planChunks(graph, styles, { minChunkBytes: 0, maxChunkBytes: 100 });
    expect(plans.length).toBeGreaterThan(1);
    for (const plan of plans) expect(plan.bytes).toBeLessThanOrEqual(100);
    expect(plans.flatMap((plan) => plan.members).sort()).toEqual(styles.map((style) => style.id));
    // (bytes desc, id asc) first-fit: 3 members x 30 bytes per pack + the remainder.
    expect(memberSets(plans)).toEqual([
      ['s0', 's1', 's2'],
      ['s3', 's4', 's5'],
      ['s6', 's7', 's8'],
      ['s9'],
    ]);
  });

  it('gives a member larger than maxChunkBytes its own pack', () => {
    const graph = createUsageGraph();
    recordUsage(graph, 'huge', 'Button');
    recordUsage(graph, 'small', 'Button');
    const plans = planChunks(graph, [input('huge', 250), input('small', 10)], {
      minChunkBytes: 0,
      maxChunkBytes: 100,
    });
    expect(memberSets(plans)).toEqual([['huge'], ['small']]);
  });

  it('merges two tiny packs that share usage until minChunkBytes is reached', () => {
    const graph = createUsageGraph();
    recordUsage(graph, 'a', 'Button');
    recordUsage(graph, 'b', 'Button');
    recordUsage(graph, 'b', 'Card');
    const plans = planChunks(
      graph,
      [input('a', 600), input('b', 600)],
      { minChunkBytes: 1024, maxChunkBytes: 4096 },
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]!.members).toEqual(['a', 'b']);
    expect(plans[0]!.bytes).toBe(1200);
  });

  it('does not merge tiny packs with no usage overlap', () => {
    const graph = createUsageGraph();
    recordUsage(graph, 'a', 'Button');
    recordUsage(graph, 'b', 'Card');
    const plans = planChunks(
      graph,
      [input('a', 600), input('b', 600)],
      { minChunkBytes: 1024, maxChunkBytes: 4096 },
    );
    expect(plans).toHaveLength(2);
    expect(memberSets(plans)).toEqual([['a'], ['b']]);
  });

  it('never drops unknown or unused styles', () => {
    const graph = createUsageGraph();
    recordUsage(graph, 'used', 'Button');
    const styles = [input('used', 10), input('unknown-a', 10), input('unknown-b', 10)];
    const plans = planChunks(graph, styles, { minChunkBytes: 0, maxChunkBytes: 4096 });
    expect(plans.flatMap((plan) => plan.members).sort()).toEqual([
      'unknown-a',
      'unknown-b',
      'used',
    ]);
    expect(plans.filter((plan) => plan.members.length === 1)).toHaveLength(3);
  });

  it('throws on invalid options', () => {
    const graph = createUsageGraph();
    expect(() => planChunks(graph, [], { minChunkBytes: 10, maxChunkBytes: 5 })).toThrow(
      /minChunkBytes \(10\) must not exceed maxChunkBytes \(5\)/,
    );
    expect(() => planChunks(graph, [], { minChunkBytes: 0, maxChunkBytes: 0 })).toThrow(
      /maxChunkBytes/,
    );
    expect(() => planChunks(graph, [], { minChunkBytes: -1, maxChunkBytes: 100 })).toThrow(
      /minChunkBytes/,
    );
  });

  it('keeps a large identical-usage set in a single pack (PERF-006)', () => {
    const graph = createUsageGraph();
    const styles = Array.from({ length: 100 }, (_, i) => {
      recordUsage(graph, `atom${i}`, 'Button');
      return input(`atom${i}`, 8);
    });
    const plans = planChunks(graph, styles, { ...DEFAULT_CHUNK_OPTIONS, maxChunkBytes: 4096 });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.members).toHaveLength(100);
    expect(plans[0]!.bytes).toBe(800);
    expect(plans[0]!.id).toMatch(/^pack_[0-9a-f]{6}$/);
  });
});

/**
 * CHUNK-001..006 (plan.md §5.3)。§4.1 の usage 配線 (style id = unit id) を前提に、
 * chunk planner の決定性・分離・分割・route 分離を ID 付きで固定する。
 */
describe('planChunks CHUNK suite (plan.md §5.3)', () => {
  it('CHUNK-001: produces an identical plan (incl. pack ids) from repeated runs', () => {
    const graph = createUsageGraph();
    recordUsage(graph, 'u1', 'home.tsx');
    recordUsage(graph, 'u2', 'home.tsx');
    recordUsage(graph, 'u3', 'about.tsx');
    recordUsage(graph, 'u3', 'home.tsx');
    const styles = [input('u1', 1200), input('u2', 300), input('u3', 2400)];
    const first = planChunks(graph, styles, DEFAULT_CHUNK_OPTIONS);
    const second = planChunks(graph, styles, DEFAULT_CHUNK_OPTIONS);
    // 同一入力から 2 回: 構成・pack id (hash) 完全一致。
    expect(second).toEqual(first);
    for (const plan of first) expect(plan.id).toMatch(/^pack_[0-9a-f]{6}$/);
  });

  it('CHUNK-002: units with identical usage sets land in one chunk', () => {
    const graph = createUsageGraph();
    // 同一 module (component) で使われる unit 群 = usage signature 完全一致。
    for (const id of ['u-a', 'u-b', 'u-c']) {
      recordUsage(graph, id, 'home.tsx');
      recordUsage(graph, id, 'nav.tsx');
    }
    const styles = [input('u-a', 700), input('u-b', 800), input('u-c', 900)];
    const plans = planChunks(graph, styles, DEFAULT_CHUNK_OPTIONS);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.members).toEqual(['u-a', 'u-b', 'u-c']);
    expect(plans[0]!.bytes).toBe(2400);
  });

  it('CHUNK-003: packs with disjoint users never merge even below minChunkBytes', () => {
    const graph = createUsageGraph();
    recordUsage(graph, 'a1', 'home.tsx');
    recordUsage(graph, 'a2', 'home.tsx');
    recordUsage(graph, 'b1', 'about.tsx');
    recordUsage(graph, 'b2', 'about.tsx');
    // 全 pack が min 未満でも users が完全不一致 (jaccard = 0) なら merge しない。
    const styles = [input('a1', 100), input('a2', 150), input('b1', 120), input('b2', 180)];
    const plans = planChunks(graph, styles, DEFAULT_CHUNK_OPTIONS);
    expect(memberSets(plans)).toEqual([['a1', 'a2'], ['b1', 'b2']]);
  });

  it('CHUNK-004: splits an over-max group deterministically (bytes desc, id asc first-fit)', () => {
    const graph = createUsageGraph();
    for (const id of ['b500', 'b400', 'b300', 'b200', 'b100', 'b50']) {
      recordUsage(graph, id, 'home.tsx');
    }
    const styles = [
      input('b50', 50),
      input('b400', 400),
      input('b100', 100),
      input('b500', 500),
      input('b200', 200),
      input('b300', 300),
    ];
    const opts = { minChunkBytes: 0, maxChunkBytes: 1000 };
    const first = planChunks(graph, styles, opts);
    const second = planChunks(graph, styles, opts);
    // 2 回の run で byte-for-byte 同一 (pack id 含む)。
    expect(second).toEqual(first);
    // first-fit descending: b500+b400+b100 = 1000, b300+b200+b50 = 550。
    expect(memberSets(first)).toEqual([['b100', 'b400', 'b500'], ['b200', 'b300', 'b50']]);
    for (const plan of first) expect(plan.bytes).toBeLessThanOrEqual(1000);
  });

  it('CHUNK-005: separates route-local units and keeps shared units in one chunk (§4.1)', () => {
    const graph = createUsageGraph();
    // §4.1 修正後の ingestUnit 相当: unit id で usage を記録する。
    recordUsage(graph, 'u-home', 'home.tsx');
    recordUsage(graph, 'u-about', 'about.tsx');
    recordUsage(graph, 'u-shared', 'shared.tsx');
    // wireRoutes 相当 (§45): module basename -> route の逆引き。
    recordComponentRoute(graph, 'home.tsx', '/');
    recordComponentRoute(graph, 'about.tsx', '/about');
    recordComponentRoute(graph, 'shared.tsx', '/');
    recordComponentRoute(graph, 'shared.tsx', '/about');
    // min を超えるサイズ: 3 pack とも merge 対象外。
    const big = [input('u-home', 2000), input('u-about', 2000), input('u-shared', 2000)];
    const plans = planChunks(graph, big, DEFAULT_CHUNK_OPTIONS);
    expect(memberSets(plans)).toEqual([['u-about'], ['u-home'], ['u-shared']]);
    // shared unit は route 経由で両 route に、local unit は単一 route に解決できる
    // (修正前は unit id の usage が空で routeSignature も空になった)。
    expect(routeSignature(graph, 'u-shared')).toEqual(['/', '/about']);
    expect(routeSignature(graph, 'u-home')).toEqual(['/']);
    expect(routeSignature(graph, 'u-about')).toEqual(['/about']);
    // min 未満でも 3 chunk のまま。修正前は全 unit が usage なし (users=∅) 扱いで
    // jaccard(∅,∅)=1 により min 到達まで全 unit が merge され 1 chunk になった。
    const tiny = [input('u-home', 100), input('u-about', 100), input('u-shared', 100)];
    expect(planChunks(graph, tiny, DEFAULT_CHUNK_OPTIONS)).toHaveLength(3);
  });

  it('CHUNK-006: completes on 1000 synthetic units with a deterministic layout', () => {
    const graph = createUsageGraph();
    // 40 module × 25 unit。usage signature は module 組で分散させる。
    const styles = Array.from({ length: 1000 }, (_, i) => {
      const id = `u${String(i).padStart(4, '0')}`;
      recordUsage(graph, id, `mod${i % 40}.tsx`);
      if (i % 3 === 0) recordUsage(graph, id, 'shared.tsx');
      return input(id, 40 + (i % 17));
    });
    const opts = { minChunkBytes: 0, maxChunkBytes: 4096 };
    const first = planChunks(graph, styles, opts);
    const second = planChunks(graph, styles, opts);
    // 完了すること + 構成決定性 (時間 assert はしない — 実行環境依存を避ける)。
    expect(second).toEqual(first);
    // unit を落とさない。
    expect(first.reduce((count, plan) => count + plan.members.length, 0)).toBe(1000);
    for (const plan of first) expect(plan.bytes).toBeLessThanOrEqual(4096);
  });
});
