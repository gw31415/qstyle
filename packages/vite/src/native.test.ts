import { describe, expect, it } from 'vitest';
import { optimizeStyleProgram, SUBJECT_SELECTOR, type StyleProgramState } from '@qstyle/core';
import { createNativeModules, retainDevelopmentOwners } from './native.js';

function program(color?: string) {
  const state = (id: string, property: string): StyleProgramState => ({
    id, demand: { id, owner: id, styleState: id, renderPath: 'return', lazyBoundary: id, predicate: id },
    rules: [{ selector: SUBJECT_SELECTOR, wrappers: [], dependencies: [], declarations: [
      ...(color ? [{ property: 'color', value: { kind: 'static' as const, css: color }, important: false }] : []),
      { property, value: { kind: 'static', css: '8px' }, important: false },
    ] }],
  });
  return optimizeStyleProgram([state('a', 'width'), state('b', 'padding')], undefined, undefined, true);
}

describe('native development owner lifecycle', () => {
  it('empties removed packs under their existing dev module identities and restores them', () => {
    const before = retainDevelopmentOwners(program('red'));
    const removed = retainDevelopmentOwners(program(), before);
    const restored = retainDevelopmentOwners(program('blue'), removed);
    const modules = (value: typeof before) => createNativeModules(value.packs, true);
    const ids = (value: typeof before) => modules(value).map((module) => module.id);
    expect(ids(removed)).toEqual(ids(before));
    expect(ids(restored)).toEqual(ids(before));
    expect(removed.packs.filter((pack) => pack.css === '')).toHaveLength(1);
    expect(modules(removed).filter((module) => module.source.includes('useStyles$("")'))).toHaveLength(1);
    expect(restored.packs.some((pack) => pack.css.includes('color:blue;'))).toBe(true);
    expect(restored.packs.some((pack) => pack.css === '')).toBe(false);
    for (const demand of ['a', 'b']) expect(removed.packsByDemand.get(demand)).toHaveLength(2);
  });

  it('does not create empty owners when generating a fresh production program', () => {
    const fresh = program();
    expect(createNativeModules(fresh.packs, false)).toHaveLength(2);
    expect(fresh.packs.some((pack) => pack.css === '')).toBe(false);
  });
});
