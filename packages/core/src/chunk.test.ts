import { describe, expect, it } from 'vitest';
import { DEFAULT_CHUNK_OPTIONS, planChunks } from './chunk.js';
import { createUsageGraph, recordUsage } from './usage.js';

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
