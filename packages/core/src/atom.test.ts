import { describe, expect, it } from 'vitest';
import { canonicalProperty, canonicalValue, createStaticAtom, hashStaticAtom } from './atom.js';

describe('atom', () => {
  it('canonicalizes camelCase to kebab-case (OBJ-003)', () => {
    expect(canonicalProperty('backgroundColor')).toBe('background-color');
  });

  it('keeps custom properties as-is (OBJ-005)', () => {
    expect(canonicalProperty('--my-var')).toBe('--my-var');
  });

  it('rejects unsafe custom property names at the public atom boundary (release blocker 2)', () => {
    expect(() =>
      createStaticAtom({ property: '--x}body{color:red', value: 'red' }),
    ).toThrow(/invalid custom property name/);
    expect(() => createStaticAtom({ property: '--qstyle-slot', value: 'red' })).toThrow(
      /invalid custom property name/,
    );
    expect(createStaticAtom({ property: '--brand-color', value: 'red' }).property).toBe(
      '--brand-color',
    );
  });

  it('kebab-cases vendor-prefixed properties with meaning intact (OBJ-004)', () => {
    // 大文字始まりの vendor prefix は通常の camelCase 規則で `-` が付く。
    expect(canonicalProperty('WebkitTransform')).toBe('-webkit-transform');
    expect(canonicalProperty('MozAppearance')).toBe('-moz-appearance');
    expect(canonicalProperty('OTransition')).toBe('-o-transition');
    // `ms` のみ小文字始まりの vendor prefix。専用規則で `-ms-` 化する
    // (React hyphenateStyleName と同一。`ms-transform` は不正な property)。
    expect(canonicalProperty('msTransform')).toBe('-ms-transform');
    expect(canonicalProperty('msFlexAlign')).toBe('-ms-flex-align');
    expect(canonicalProperty('msGridRow')).toBe('-ms-grid-row');
    // すでに kebab-case の vendor prefix は素通し。
    expect(canonicalProperty('-webkit-transform')).toBe('-webkit-transform');
    expect(canonicalProperty('-ms-flex-align')).toBe('-ms-flex-align');
    // `ms-` で始まる通常 property は存在しないため誤変換の心配はない。
    expect(createStaticAtom({ property: 'WebkitTransform', value: 'none' }).property).toBe(
      '-webkit-transform',
    );
  });

  it('separates !important into the flag so priority changes identity (CSS-008)', () => {
    const plain = createStaticAtom({ property: 'color', value: 'red' });
    const important = createStaticAtom({
      property: 'color',
      value: 'red',
      important: true,
    });
    expect(plain.important).toBe(false);
    expect(important.important).toBe(true);
    // priority は value 文字列ではなく flag に入るため、同一 value のまま
    // identity が分離する (serialize 時に `!important` を付けるかが決まる)。
    expect(important.value).toBe('red');
    expect(hashStaticAtom(plain)).not.toBe(hashStaticAtom(important));
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
