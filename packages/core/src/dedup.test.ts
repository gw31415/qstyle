import { describe, expect, it } from 'vitest';
import { createStaticAtom, hashStaticAtom } from './atom.js';
import { DedupRegistry } from './dedup.js';
import type { StaticAtom } from './ir.js';

function atomAt(source: string, line: number): StaticAtom {
  return createStaticAtom({
    property: 'color',
    value: 'red',
    provenance: [{ source, line, column: 1 }],
  });
}

describe('dedup', () => {
  it('dedups identical declarations in the same module (DED-001)', () => {
    const registry = new DedupRegistry();
    const first = registry.add(atomAt('a.tsx', 1));
    const second = registry.add(atomAt('a.tsx', 2));
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
    expect(registry.size()).toBe(1);
  });

  it('dedups identical declarations across modules and merges provenance (DED-002)', () => {
    const registry = new DedupRegistry();
    registry.add(atomAt('a.tsx', 1));
    const second = registry.add(atomAt('b.tsx', 5));
    expect(second.deduped).toBe(true);
    expect(registry.size()).toBe(1);
    expect(registry.ids()).toHaveLength(1);
  });

  it('treats whitespace differences as identical (DED-004)', () => {
    const registry = new DedupRegistry();
    const a = createStaticAtom({ property: 'display', value: 'flex' });
    const b = createStaticAtom({ property: 'display', value: '  flex  \n ' });
    const first = registry.add(a);
    const second = registry.add(b);
    expect(second.id).toBe(first.id);
    expect(registry.size()).toBe(1);
  });

  it('separates identity on important difference (DED-008)', () => {
    const registry = new DedupRegistry();
    const plain = createStaticAtom({ property: 'color', value: 'red' });
    const important = createStaticAtom({ property: 'color', value: 'red', important: true });
    expect(hashStaticAtom(plain)).not.toBe(hashStaticAtom(important));
    registry.add(plain);
    registry.add(important);
    expect(registry.size()).toBe(2);
  });

  it('keeps hash stable across comment-equivalent whitespace (HASH-005 stub)', () => {
    const a = createStaticAtom({ property: 'boxShadow', value: '0 0 0 2px var(--focus)' });
    const b = createStaticAtom({ property: 'boxShadow', value: '0   0 0  2px   var(--focus)' });
    expect(hashStaticAtom(a)).toBe(hashStaticAtom(b));
  });

  it('caps merged provenance at 16 entries', () => {
    const registry = new DedupRegistry();
    let id = '';
    for (let line = 1; line <= 20; line += 1) {
      id = registry.add(atomAt(`m${line}.tsx`, line)).id;
    }
    expect(registry.size()).toBe(1);
    expect(registry.get(id)?.provenance).toHaveLength(16);
    // 初回 provenance を保持する
    expect(registry.get(id)?.provenance[0]).toEqual({ source: 'm1.tsx', line: 1, column: 1 });
  });

  it('異なる入力が同一 hash になったら衝突 error を投げる (release blocker 1)', () => {
    // 既知の FNV-1a 衝突ペア (birthday search で特定した固定値。hash は不変のため
    // 常に決定的に再現する)。異なる論理入力が黙って dedupe されないことを保証する。
    const registry = new DedupRegistry();
    registry.add(createStaticAtom({ property: 'color', value: 'shade-422789' }));
    expect(() =>
      registry.add(createStaticAtom({ property: 'color', value: 'shade-639192' })),
    ).toThrow(/hash collision/);
    // 衝突 error には生成 id と content fingerprint が載る。
    try {
      registry.add(createStaticAtom({ property: 'color', value: 'shade-639192' }));
      throw new Error('expected collision error');
    } catch (error) {
      const message: string = (error as Error).message;
      expect(message).toContain('atom');
      expect(message).toContain('q_4c05fbff');
    }
  });
});
