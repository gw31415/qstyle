import { describe, expect, it, vi } from 'vitest';
import { MemoryCache, computeCacheKey, invalidateBySource, safeParse } from './cache.js';

const baseInput = {
  sourceHash: 'hash-a',
  compilerVersion: '0.1.0-m1',
  configHash: 'cfg-1',
  frontendVersion: 'fe-1',
  targetBrowsers: 'chrome>=120',
} as const;

/** 実運用の key 規約: fnv1a digest + sourceHash を埋め込む (invalidateBySource が match するように)。 */
function keyFor(sourceHash: string, kind: string): string {
  return `${computeCacheKey({ ...baseInput, sourceHash })}|${sourceHash}|${kind}`;
}

describe('computeCacheKey', () => {
  it('is deterministic for identical inputs (§57)', () => {
    expect(computeCacheKey(baseInput)).toBe(computeCacheKey({ ...baseInput }));
    expect(computeCacheKey(baseInput)).toBe(computeCacheKey(baseInput));
  });

  it('is an 8-hex fnv1a digest', () => {
    expect(computeCacheKey(baseInput)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('changes when any component of the key changes', () => {
    const base = computeCacheKey(baseInput);
    expect(computeCacheKey({ ...baseInput, sourceHash: 'hash-b' })).not.toBe(base);
    expect(computeCacheKey({ ...baseInput, compilerVersion: '9.9.9' })).not.toBe(base);
    expect(computeCacheKey({ ...baseInput, configHash: 'cfg-2' })).not.toBe(base);
    expect(computeCacheKey({ ...baseInput, frontendVersion: 'fe-2' })).not.toBe(base);
    expect(computeCacheKey({ ...baseInput, targetBrowsers: 'firefox>=120' })).not.toBe(base);
  });
});

describe('MemoryCache', () => {
  it('stores, reads and reports values (set/get/has/size)', () => {
    const cache = new MemoryCache();
    expect(cache.has('k')).toBe(false);
    expect(cache.get('k')).toBeUndefined();
    cache.set('k', { ir: 'a' });
    expect(cache.get('k')).toEqual({ ir: 'a' });
    expect(cache.has('k')).toBe(true);
    expect(cache.size()).toBe(1);
  });

  it('overwrites in place and supports delete / clear', () => {
    const cache = new MemoryCache();
    cache.set('k', 1);
    cache.set('k', 2);
    expect(cache.get('k')).toBe(2);
    expect(cache.size()).toBe(1);
    cache.delete('k');
    expect(cache.has('k')).toBe(false);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });

  it('does not return entries past the TTL and deletes them on get', () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoryCache(100);
      cache.set('k', 'v');
      expect(cache.get('k')).toBe('v');
      vi.advanceTimersByTime(100);
      expect(cache.get('k')).toBeUndefined();
      expect(cache.has('k')).toBe(false);
      expect(cache.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the default TTL of 300_000ms', () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoryCache();
      cache.set('k', 'v');
      vi.advanceTimersByTime(299_999);
      expect(cache.get('k')).toBe('v');
      vi.advanceTimersByTime(1);
      expect(cache.get('k')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires per entry from its own write time', () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoryCache(100);
      cache.set('old', 1);
      vi.advanceTimersByTime(60);
      cache.set('fresh', 2);
      vi.advanceTimersByTime(60);
      expect(cache.get('old')).toBeUndefined();
      expect(cache.get('fresh')).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('invalidateBySource', () => {
  it('removes only entries of the touched source and keeps others (HMR-008)', () => {
    const cache = new MemoryCache();
    cache.set(keyFor('hash-a', 'parsed'), 'a-ir');
    cache.set(keyFor('hash-a', 'graph'), 'a-graph');
    cache.set(keyFor('hash-b', 'parsed'), 'b-ir');
    cache.set(keyFor('hash-c', 'graph'), 'c-graph');

    expect(invalidateBySource(cache, 'hash-a')).toBe(2);
    expect(cache.has(keyFor('hash-a', 'parsed'))).toBe(false);
    expect(cache.has(keyFor('hash-a', 'graph'))).toBe(false);
    expect(cache.get(keyFor('hash-b', 'parsed'))).toBe('b-ir');
    expect(cache.get(keyFor('hash-c', 'graph'))).toBe('c-graph');
    expect(cache.size()).toBe(2);
  });

  it('returns the number of removed entries and 0 when nothing matches', () => {
    const cache = new MemoryCache();
    cache.set('x:hash-a', 1);
    expect(invalidateBySource(cache, 'hash-a')).toBe(1);
    expect(invalidateBySource(cache, 'hash-a')).toBe(0);
    expect(invalidateBySource(cache, 'missing')).toBe(0);
  });

  it('treats an empty sourceHash as no-op (it would match every key)', () => {
    const cache = new MemoryCache();
    cache.set('k', 1);
    expect(invalidateBySource(cache, '')).toBe(0);
    expect(cache.has('k')).toBe(true);
  });
});

describe('safeParse', () => {
  it('parses valid JSON (FLB-007)', () => {
    expect(safeParse<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(safeParse<readonly number[]>('[1,2]')).toEqual([1, 2]);
    expect(safeParse<string>('"x"')).toBe('x');
    expect(safeParse<boolean>('true')).toBe(true);
  });

  it('returns null on corrupt text instead of throwing (FLB-007)', () => {
    for (const text of ['', 'not json', '{', 'undefined', '{"a":}', "{'a':1}"]) {
      expect(safeParse(text)).toBeNull();
    }
  });
});
