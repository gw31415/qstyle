import { describe, expect, it } from 'vitest';
import {
  createUsageGraph,
  groupByUsageSignature,
  jaccardSimilarity,
  recordComponentBoundary,
  recordComponentRoute,
  recordSource,
  recordUsage,
  routeSignature,
  sourceSignature,
  usageSignature,
} from './usage.js';

describe('usage graph', () => {
  it('records usage and returns a sorted signature', () => {
    const graph = createUsageGraph();
    recordUsage(graph, 's1', 'Card');
    recordUsage(graph, 's1', 'Button');
    recordUsage(graph, 's2', 'Header');
    expect(usageSignature(graph, 's1')).toEqual(['Button', 'Card']);
    expect(usageSignature(graph, 's2')).toEqual(['Header']);
  });

  it('returns an empty signature for an unknown style', () => {
    const graph = createUsageGraph();
    expect(usageSignature(graph, 'nope')).toEqual([]);
    expect(routeSignature(graph, 'nope')).toEqual([]);
  });

  it('is idempotent for repeated records of the same pair', () => {
    const graph = createUsageGraph();
    recordUsage(graph, 's1', 'Button');
    recordUsage(graph, 's1', 'Button');
    expect(usageSignature(graph, 's1')).toEqual(['Button']);
    recordComponentRoute(graph, 'Button', '/');
    recordComponentRoute(graph, 'Button', '/');
    recordComponentBoundary(graph, 'Button', 'b1');
    recordComponentBoundary(graph, 'Button', 'b1');
    expect(graph.componentToRoutes.get('Button')).toEqual(new Set(['/']));
    expect(graph.componentToLazyBoundaries.get('Button')).toEqual(new Set(['b1']));
  });

  it('unions routes across all components using the style', () => {
    const graph = createUsageGraph();
    recordUsage(graph, 's1', 'Button');
    recordUsage(graph, 's1', 'Card');
    recordComponentRoute(graph, 'Button', '/settings');
    recordComponentRoute(graph, 'Button', '/about');
    recordComponentRoute(graph, 'Card', '/about');
    recordComponentRoute(graph, 'Card', '/');
    expect(routeSignature(graph, 's1')).toEqual(['/', '/about', '/settings']);
  });

  it('unions lazy boundaries and routes independently', () => {
    const graph = createUsageGraph();
    recordUsage(graph, 's1', 'Card');
    recordComponentBoundary(graph, 'Card', 'route-lazy');
    expect(graph.componentToLazyBoundaries.get('Card')).toEqual(new Set(['route-lazy']));
    expect(routeSignature(graph, 's1')).toEqual([]);
  });

  it('groups styles whose usage signatures match exactly (§38)', () => {
    const graph = createUsageGraph();
    recordUsage(graph, 'sB', 'Button');
    recordUsage(graph, 'sA', 'Button');
    recordUsage(graph, 'sC', 'Button');
    recordUsage(graph, 'sC', 'Card');
    recordUsage(graph, 'sD', 'Card');
    const groups = groupByUsageSignature(graph);
    expect(groups.get(JSON.stringify(['Button']))).toEqual(['sA', 'sB']);
    expect(groups.get(JSON.stringify(['Button', 'Card']))).toEqual(['sC']);
    expect(groups.get(JSON.stringify(['Card']))).toEqual(['sD']);
    expect(groups.size).toBe(3);
  });

  it('excludes styles without usage from grouping', () => {
    const graph = createUsageGraph();
    recordComponentRoute(graph, 'Orphan', '/');
    const groups = groupByUsageSignature(graph);
    expect(groups.size).toBe(0);
  });

  it('computes jaccard similarity edge cases', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0);
    // |{b}| / |{a,b,c}| = 1/3
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['b', 'c']))).toBe(1 / 3);
    // |{b}| / |{a,b}| = 1/2
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['b']))).toBe(0.5);
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
    expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0);
  });

  it('tracks provenance sources sorted and idempotently', () => {
    const graph = createUsageGraph();
    recordSource(graph, 's1', '/src/card.tsx');
    recordSource(graph, 's1', '/src/button.tsx');
    recordSource(graph, 's1', '/src/button.tsx');
    expect(sourceSignature(graph, 's1')).toEqual(['/src/button.tsx', '/src/card.tsx']);
    expect(sourceSignature(graph, 'nope')).toEqual([]);
  });
});
