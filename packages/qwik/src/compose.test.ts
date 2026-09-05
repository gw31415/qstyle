import { describe, expect, it } from 'vitest';
import type { AnyAtom, StaticAtom } from '@qstyle/core';
import { assignOrderingGroups, hashStaticAtom } from '@qstyle/core';
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

  it('keeps object + handle + object source order (CMP-009)', () => {
    const handle = css({ color: 'red' });
    const out = composeCssProp([{ display: 'flex' }, handle, { color: 'blue', gap: 4 }]);
    // object(handle 前) -> handle -> object(handle 後) の順が保たれ、
    // 同一 property の conflict は後勝ちで末尾に置き換わる。
    expect(out.atoms.map((a) => a.property)).toEqual(['display', 'color', 'gap']);
    expect(staticValue(out.atoms.find((a) => a.property === 'color')!)).toBe('blue');
    expect(staticValue(out.atoms.find((a) => a.property === 'display')!)).toBe('flex');
    expect(staticValue(out.atoms.find((a) => a.property === 'gap')!)).toBe('4px');
  });

  it('orders shorthand earlier / longhand later in one ordering group (CMP-012)', () => {
    // shorthand が先: `margin: 8px` の後に `margin-top: 16px` が効く
    // (source order がそのまま CSS 順序になることが保証される)。
    const out = composeCssProp([{ margin: '8px' }, { marginTop: '16px' }]);
    expect(out.atoms.map((a) => [a.property, staticValue(a)])).toEqual([
      ['margin', '8px'],
      ['margin-top', '16px'],
    ]);
    // 衝突検出: safety analysis が同一 ordering group にまとめる。
    const grouped = assignOrderingGroups(out.atoms as readonly StaticAtom[]);
    expect(grouped[0]?.ordering.group).toBe(grouped[1]?.ordering.group);
    expect(grouped.map((a) => a.property)).toEqual(['margin', 'margin-top']);
  });

  it('orders longhand earlier / shorthand later in one ordering group (CMP-013)', () => {
    // longhand が先: `margin-top: 16px` が `margin: 8px` に上書きされる
    // (source 順序どおり。atomic 化で並び替えない)。
    const out = composeCssProp([{ marginTop: '16px' }, { margin: '8px' }]);
    expect(out.atoms.map((a) => [a.property, staticValue(a)])).toEqual([
      ['margin-top', '16px'],
      ['margin', '8px'],
    ]);
    const grouped = assignOrderingGroups(out.atoms as readonly StaticAtom[]);
    expect(grouped[0]?.ordering.group).toBe(grouped[1]?.ordering.group);
  });

  it('resolves nested selector conflicts per context (CMP-015)', () => {
    const base = css({ color: 'black', '&:hover': { color: 'red' } });
    const hover = css({ '&:hover': { color: 'blue' } });
    const out = composeCssProp([base, hover]);
    // :hover 同士は同一 context conflict → 後勝ち。base は無傷。
    expect(out.atoms).toHaveLength(2);
    const hoverAtom = out.atoms.find((a) => a.context.pseudo?.[0] === ':hover');
    const baseAtom = out.atoms.find((a) => a.context.pseudo === undefined);
    expect(staticValue(hoverAtom!)).toBe('blue');
    expect(staticValue(baseAtom!)).toBe('black');
    // context が異なる atom は混ざらない (identity も分離)。
    expect(hashStaticAtom(baseAtom as StaticAtom)).not.toBe(
      hashStaticAtom(hoverAtom as StaticAtom),
    );
  });

  it('resolves equal-specificity conflicts by source order (CSS-009)', () => {
    // 同一 property + 同一 context (= 等詳細度) は後勝ちで 1 atom になる。
    const out = composeCssProp([
      css({ '&:hover': { color: 'red' } }),
      css({ '&:hover': { color: 'blue' } }),
    ]);
    expect(out.atoms).toHaveLength(1);
    expect(staticValue(out.atoms[0]!)).toBe('blue');
    expect(out.atoms[0]?.context.pseudo).toEqual([':hover']);
  });

  it('keeps different-specificity atoms separate in source order (CSS-010)', () => {
    // base (0,1,0) と :hover (0,2,0) は詳細度が異なるため独立に保持され、
    // serialize 順は source order のまま。
    const out = composeCssProp([{ color: 'black' }, { '&:hover': { color: 'blue' } }]);
    expect(out.atoms.map((a) => [a.property, staticValue(a), a.context.pseudo?.[0]])).toEqual([
      ['color', 'black', undefined],
      ['color', 'blue', ':hover'],
    ]);
    const [base, hover] = out.atoms as readonly StaticAtom[];
    expect(hashStaticAtom(base!)).not.toBe(hashStaticAtom(hover!));
  });
});
