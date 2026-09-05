import { describe, expect, it } from 'vitest';
import { canonicalProperty, canonicalValue, createStaticAtom, hashStaticAtom } from './atom.js';

describe('atom', () => {
  it('canonicalizes camelCase to kebab-case (OBJ-003)', () => {
    expect(canonicalProperty('backgroundColor')).toBe('background-color');
  });

  it('keeps custom properties as-is (OBJ-005)', () => {
    expect(canonicalProperty('--my-var')).toBe('--my-var');
  });

  it('creates identical hash for object/template equivalent spelling (DED-003 stub)', () => {
    const a = createStaticAtom({ property: 'display', value: '  flex ' });
    const b = createStaticAtom({ property: 'display', value: 'flex' });
    expect(hashStaticAtom(a)).toBe(hashStaticAtom(b));
  });

  it('separates hover context identity (DED-006)', () => {
    const base = createStaticAtom({ property: 'color', value: 'red' });
    const hover = createStaticAtom({
      property: 'color',
      value: 'red',
      context: { pseudo: ['hover'] },
    });
    expect(hashStaticAtom(base)).not.toBe(hashStaticAtom(hover));
  });

  it('separates descendant context identity (DED-007)', () => {
    const base = createStaticAtom({ property: 'display', value: 'block' });
    const desc = createStaticAtom({
      property: 'display',
      value: 'block',
      context: { descendant: 'svg' },
    });
    expect(hashStaticAtom(base)).not.toBe(hashStaticAtom(desc));
  });

  it('canonicalizes value whitespace (TPL-002 stub)', () => {
    expect(canonicalValue('  flex   \n ')).toBe('flex');
  });
});
