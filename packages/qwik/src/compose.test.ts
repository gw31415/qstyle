import { describe, expect, it } from 'vitest';
import type { AnyAtom } from '@qstyle/core';
import { composeCssProp, flattenCssProp } from './compose.js';
import { css } from './index.js';

// atoms は static / parametric が混在するため、value を持つのは static のみ。
function staticValue(atom: AnyAtom): string {
  return atom.kind === 'static-atom' ? atom.value : '(parametric)';
}

describe('flattenCssProp', () => {
  it('flattens nested arrays and drops falsy (CMP-005/006)', () => {
    const a = { display: 'flex' };
    const b = { color: 'red' };
    const flat = flattenCssProp([a, [b, false, null, undefined, [a]]]);
    expect(flat).toEqual([a, b, a]);
  });
});

describe('composeCssProp', () => {
  it('single handle equals inline object (CMP-001)', () => {
    const handle = css({ display: 'flex' });
    const fromHandle = composeCssProp([handle]);
    const fromInline = composeCssProp([{ display: 'flex' }]);
    expect(fromHandle.atoms.map((a) => [a.property, staticValue(a)])).toEqual(
      fromInline.atoms.map((a) => [a.property, staticValue(a)]),
    );
  });

  it('applies non-conflicting handles (CMP-002)', () => {
    const out = composeCssProp([css({ display: 'flex' }), css({ color: 'red' })]);
    expect(out.atoms).toHaveLength(2);
  });

  it('later handle wins on same property (CMP-003)', () => {
    const out = composeCssProp([css({ color: 'red' }), css({ color: 'blue' })]);
    expect(out.atoms).toHaveLength(1);
    expect(staticValue(out.atoms[0]!)).toBe('blue');
  });

  it('keeps left-to-right semantics across three (CMP-004)', () => {
    const out = composeCssProp([
      css({ color: 'red', display: 'flex' }),
      css({ color: 'green' }),
      css({ color: 'blue' }),
    ]);
    const color = out.atoms.filter((a) => a.property === 'color');
    expect(color).toHaveLength(1);
    expect(staticValue(color[0]!)).toBe('blue');
    expect(out.atoms.some((a) => a.property === 'display')).toBe(true);
  });

  it('supports conditional handles (CMP-007)', () => {
    const active = css({ color: 'red' });
    const out = composeCssProp([css({ display: 'flex' }), false && active]);
    expect(out.atoms).toHaveLength(1);
    const out2 = composeCssProp([css({ display: 'flex' }), true && active]);
    expect(out2.atoms).toHaveLength(2);
  });

  it('mixes handles and inline objects (CMP-008)', () => {
    const out = composeCssProp([css({ display: 'flex' }), { gap: 8 }]);
    expect(out.atoms).toHaveLength(2);
  });

  it('dedupes repeated handles without CSS duplication (CMP-010)', () => {
    const h = css({ display: 'flex' });
    const out = composeCssProp([h, h, h]);
    expect(out.atoms).toHaveLength(1);
  });

  it('dedupes semantically identical handles (CMP-011)', () => {
    const out = composeCssProp([css({ display: 'flex' }), css({ display: 'flex' })]);
    expect(out.atoms).toHaveLength(1);
  });

  it('keeps !important separate from normal priority (CMP-014)', () => {
    const out = composeCssProp([{ color: 'red' }, { color: 'blue !important' }]);
    // important flag が立つため conflict key が分かれ、両方保持される。
    expect(out.atoms).toHaveLength(2);
    const important = out.atoms.find((a) => a.important);
    expect(staticValue(important!)).toBe('blue');
    expect(staticValue(out.atoms.find((a) => !a.important)!)).toBe('red');
  });

  it('keeps a static later-wins over an earlier parametric (CMP-020)', () => {
    const dynamicValue = {} as unknown;
    const parametric = css`width: ${dynamicValue}px;`;
    const out = composeCssProp([parametric, { width: '10px' }]);
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]?.kind).toBe('static-atom');
    expect(staticValue(out.atoms[0]!)).toBe('10px');
    // 後勝ちで parametric が除去されたため parametrics からも消える。
    expect(out.parametrics).toHaveLength(0);
  });

  it('keeps a parametric later-wins over an earlier static (CMP-021)', () => {
    const dynamicValue = {} as unknown;
    const parametric = css`width: ${dynamicValue}px;`;
    const out = composeCssProp([{ width: '10px' }, parametric]);
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]?.kind).toBe('parametric-atom');
    expect(out.parametrics).toEqual([out.atoms[0]]);
    expect(out.residuals).toHaveLength(0);
  });

  it('dedupes identical parametric contributions (CMP-022)', () => {
    const dynamicValue = {} as unknown;
    const out = composeCssProp([css`gap: ${dynamicValue}px;`, css`gap: ${dynamicValue}px;`]);
    expect(out.atoms).toHaveLength(1);
    expect(out.parametrics).toHaveLength(1);
  });

  it('later !important wins over earlier !important', () => {
    const out = composeCssProp([
      { color: 'red !important' },
      { color: 'blue !important' },
    ]);
    expect(out.atoms).toHaveLength(1);
    expect(staticValue(out.atoms[0]!)).toBe('blue');
  });
});
