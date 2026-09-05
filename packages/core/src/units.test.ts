import { describe, expect, it } from 'vitest';
import { createStaticAtom } from './atom.js';
import { UNITLESS_PROPERTIES, UNITLESS_VERSION, serializeCssValue } from './units.js';

describe('units', () => {
  it('pins the unitless fixture version', () => {
    expect(UNITLESS_VERSION).toBe('m1.0');
    expect(UNITLESS_PROPERTIES.size).toBeGreaterThanOrEqual(20);
    expect(UNITLESS_PROPERTIES.size).toBeLessThanOrEqual(30);
  });

  it('serializes unitless numbers without a unit (OBJ-006)', () => {
    expect(serializeCssValue('opacity', 0.5)).toBe('0.5');
    expect(serializeCssValue('zIndex', 10)).toBe('10');
    expect(serializeCssValue('fontWeight', 700)).toBe('700');
    expect(serializeCssValue('lineHeight', 1.5)).toBe('1.5');
    expect(serializeCssValue('flex', 1)).toBe('1');
    expect(serializeCssValue('flexGrow', 2)).toBe('2');
    expect(serializeCssValue('flexShrink', 0)).toBe('0');
    expect(serializeCssValue('order', 3)).toBe('3');
    expect(serializeCssValue('gridColumn', 2)).toBe('2');
  });

  it('appends px to length numbers (OBJ-007)', () => {
    expect(serializeCssValue('width', 8)).toBe('8px');
    expect(serializeCssValue('gap', 16)).toBe('16px');
    expect(serializeCssValue('marginTop', 4)).toBe('4px');
    expect(serializeCssValue('width', -4)).toBe('-4px');
    expect(createStaticAtom({ property: 'gap', value: 8 }).value).toBe('8px');
    expect(createStaticAtom({ property: 'opacity', value: 0.5 }).value).toBe('0.5');
  });

  it('serializes zero without a unit (OBJ-008)', () => {
    expect(serializeCssValue('width', 0)).toBe('0');
    expect(serializeCssValue('margin', 0)).toBe('0');
    expect(serializeCssValue('opacity', 0)).toBe('0');
  });

  it('keeps negative signs for numbers (OBJ-009)', () => {
    // length 系は符号を保持したまま px 補完、unitless は単位なしのまま。
    expect(serializeCssValue('margin', -8)).toBe('-8px');
    expect(serializeCssValue('marginTop', -0.25)).toBe('-0.25px');
    expect(serializeCssValue('opacity', -0.5)).toBe('-0.5');
    expect(serializeCssValue('zIndex', -1)).toBe('-1');
    expect(serializeCssValue('top', -4)).toBe('-4px');
    // 負の custom property 数値も単位推測しない。
    expect(serializeCssValue('--x', -8)).toBe('-8');
  });

  it('canonicalizes decimal spellings deterministically (OBJ-010)', () => {
    expect(serializeCssValue('padding', 0.5)).toBe('0.5px');
    // `0.50` / `5e-1` は JS number としては同一値なので同一 canonical 表現になる。
    expect(serializeCssValue('padding', Number('0.50'))).toBe('0.5px');
    expect(serializeCssValue('padding', 5e-1)).toBe('0.5px');
    expect(serializeCssValue('opacity', 0.5)).toBe(serializeCssValue('opacity', 0.50));
    // 文字列値は数値として再解釈しない (意味を変えない)。表現は決定的。
    expect(serializeCssValue('padding', '0.50px')).toBe('0.50px');
    expect(serializeCssValue('padding', ' 0.5px ')).toBe('0.5px');
  });

  it('canonicalizes camelCase property before lookup (OBJ-003)', () => {
    const atom = createStaticAtom({ property: 'backgroundColor', value: 'red' });
    expect(atom.property).toBe('background-color');
    expect(serializeCssValue('zIndex', 1)).toBe('1');
  });

  it('keeps custom properties as-is (OBJ-005)', () => {
    const atom = createStaticAtom({ property: '--my-var', value: ' blue ' });
    expect(atom.property).toBe('--my-var');
    expect(atom.value).toBe('blue');
    // custom property の数値は単位を推測しない
    expect(serializeCssValue('--my-var', 8)).toBe('8');
  });

  it('passes CSS-wide keywords through (OBJ-011/OBJ-012)', () => {
    expect(serializeCssValue('color', 'inherit')).toBe('inherit');
    expect(serializeCssValue('color', 'initial')).toBe('initial');
    expect(serializeCssValue('display', 'unset')).toBe('unset');
    expect(serializeCssValue('color', 'revert')).toBe('revert');
    expect(serializeCssValue('color', 'revert-layer')).toBe('revert-layer');
    expect(createStaticAtom({ property: 'color', value: 'inherit' }).value).toBe('inherit');
  });
});
