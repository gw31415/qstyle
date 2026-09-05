import { describe, expect, it } from 'vitest';
import { hashParametricAtom, hashStaticAtom } from '@qstyle/core';
import { css, lowerStyleObject } from './index.js';
import { lowerTaggedTemplate } from './template.js';

function tag(strings: TemplateStringsArray, ...values: readonly unknown[]) {
  return lowerTaggedTemplate(strings, values);
}

describe('lowerTaggedTemplate static', () => {
  it('lowers static declarations (TPL-001)', () => {
    const out = tag`display: flex; gap: 8px;`;
    expect(out.atoms).toHaveLength(2);
    expect(out.residuals).toHaveLength(0);
  });

  it('treats whitespace/comments differences as identical (TPL-002)', () => {
    const a = tag`display:flex;gap:8px;`;
    const b = tag`
      display: flex; /* comment */
      gap: 8px;
    `;
    const ha = a.atoms.map((x) => hashStaticAtom(x)).sort();
    const hb = b.atoms.map((x) => hashStaticAtom(x)).sort();
    expect(ha).toEqual(hb);
  });

  it('lowers nested selectors (TPL-003)', () => {
    const out = tag`
      color: black;
      &:hover { color: blue; }
    `;
    expect(out.atoms).toHaveLength(2);
    expect(out.atoms.find((x) => x.value === 'blue')?.context.pseudo).toEqual([
      ':hover',
    ]);
  });

  it('lowers media queries (TPL-004)', () => {
    const out = tag`
      @media (width >= 768px) { padding: 16px; }
    `;
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]?.context.media).toBe('(width >= 768px)');
  });

  it('folds static primitive interpolations (TPL-005)', () => {
    const gap = 8;
    const out = tag`gap: ${gap}px; display: ${'flex'};`;
    expect(out.residuals).toHaveLength(0);
    const byProp = Object.fromEntries(out.atoms.map((x) => [x.property, x.value]));
    expect(byProp).toEqual({ gap: '8px', display: 'flex' });
  });

  it('splices StyleHandle interpolations (TPL-011)', () => {
    const base = css({ display: 'flex' });
    const out = tag`${base}; color: red;`;
    expect(out.atoms).toHaveLength(2);
    expect(out.atoms[0]?.property).toBe('display');
  });

  it('matches object syntax semantically (TPL-017)', () => {
    const fromTemplate = tag`display: flex; gap: 8px;`;
    const fromObject = lowerStyleObject({ display: 'flex', gap: 8 });
    const ht = fromTemplate.atoms.map((x) => hashStaticAtom(x)).sort();
    const ho = fromObject.atoms.map((x) => hashStaticAtom(x)).sort();
    expect(ht).toEqual(ho);
  });
});

describe('lowerTaggedTemplate runtime markers', () => {
  it('residualizes standalone runtime interpolations (TPL-007/008)', () => {
    const dynamicValue = {} as unknown;
    const out = tag`${dynamicValue};`;
    expect(out.atoms).toHaveLength(0);
    expect(out.parametrics).toHaveLength(0);
    expect(out.residuals).toHaveLength(1);
    expect(out.diagnostics.some((d) => d.severity === 'warn')).toBe(true);
  });

  it('diagnoses handle interpolation inside a value', () => {
    const handle = css({ color: 'red' });
    const out = tag`width: ${handle};`;
    expect(out.parametrics).toHaveLength(0);
    expect(out.residuals).toHaveLength(1);
    expect(out.diagnostics.some((d) => d.severity === 'warn')).toBe(true);
  });

  it('diagnoses property-name interpolation (TPL-012)', () => {
    // 文字列は static fold されるため、fold 不能な値で検証する。
    const prop = { toString: () => 'color' } as unknown;
    const out = tag`${prop}: red;`;
    expect(out.atoms).toHaveLength(0);
    expect(out.diagnostics.length).toBeGreaterThan(0);
  });

  it('diagnoses selector interpolation (TPL-013)', () => {
    const sel = { toString: () => '&:hover' } as unknown;
    const out = tag`${sel} { color: red; }`;
    expect(out.atoms).toHaveLength(0);
    expect(out.diagnostics.length).toBeGreaterThan(0);
  });

  it('handles escaped sequences without crashing (TPL-015)', () => {
    const out = tag`content: "\\""; display: flex;`;
    expect(out.atoms.some((x) => x.property === 'display')).toBe(true);
  });
});

describe('lowerTaggedTemplate parametric (M5b)', () => {
  const dynamicValue = {} as unknown;
  const otherValue = [] as unknown;

  it('lowers a runtime value with a unit suffix into a ParametricAtom (DYN-001)', () => {
    const out = tag`width: ${dynamicValue}px;`;
    expect(out.residuals).toHaveLength(0);
    expect(out.atoms).toHaveLength(0);
    expect(out.parametrics).toHaveLength(1);
    expect(out.parametrics[0]?.property).toBe('width');
    expect(out.parametrics[0]?.valueTemplate).toEqual([
      { kind: 'slot', slotIndex: 0 },
      { kind: 'text', text: 'px' },
    ]);
    expect(out.parametrics[0]?.slots[0]?.valueType).toBe('length');
  });

  it('infers percentage slots (DYN-003)', () => {
    const out = tag`width: ${dynamicValue}%;`;
    expect(out.residuals).toHaveLength(0);
    expect(out.parametrics[0]?.slots[0]?.valueType).toBe('percentage');
  });

  it('keeps a whole-marker value custom typed', () => {
    const out = tag`color: ${dynamicValue};`;
    expect(out.parametrics[0]?.slots[0]?.valueType).toBe('custom');
    expect(out.parametrics[0]?.valueTemplate).toEqual([{ kind: 'slot', slotIndex: 0 }]);
  });

  it('builds independent slots for a compound value (DYN-006)', () => {
    const out = tag`padding: ${dynamicValue}px ${otherValue}%;`;
    const p = out.parametrics[0];
    // 単位は slot の直後に続く静的 text 側に残る。
    expect(p?.valueTemplate).toEqual([
      { kind: 'slot', slotIndex: 0 },
      { kind: 'text', text: 'px ' },
      { kind: 'slot', slotIndex: 1 },
      { kind: 'text', text: '%' },
    ]);
    expect(p?.slots.map((s) => s.valueType)).toEqual(['length', 'percentage']);
    expect(p?.slots[0]?.id).toMatch(/^--qstyle-[0-9a-f]{6}-0$/);
    expect(p?.slots[1]?.id).toMatch(/^--qstyle-[0-9a-f]{6}-1$/);
  });

  it('assigns distinct slot ids to distinct structures (DYN-007)', () => {
    const out = tag`width: ${dynamicValue}px; height: ${otherValue}%;`;
    expect(out.parametrics).toHaveLength(2);
    const ids = out.parametrics.map((p) => p.slots[0]?.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('resolves nested context for runtime declarations (DYN-008)', () => {
    const out = tag`
      color: red;
      &:hover {
        width: ${dynamicValue}px;
        color: blue;
      }
    `;
    expect(out.residuals).toHaveLength(0);
    expect(out.parametrics).toHaveLength(1);
    expect(out.parametrics[0]?.property).toBe('width');
    expect(out.parametrics[0]?.context.pseudo).toEqual([':hover']);
    // 同一 block 内の静的 decl は従来どおり nested record 経由で context を得る。
    expect(out.atoms.find((a) => a.value === 'blue')?.context.pseudo).toEqual([':hover']);
  });

  it('residualizes unsupported nested keys that hold runtime declarations', () => {
    const out = tag`& > div { width: ${dynamicValue}px; }`;
    expect(out.parametrics).toHaveLength(0);
    expect(out.residuals).toHaveLength(1);
    expect(out.diagnostics.some((d) => d.severity === 'warn')).toBe(true);
  });

  it('shares identity across equal structures with different runtime values (DYN-010)', () => {
    const a = tag`width: ${dynamicValue}px;`.parametrics[0];
    const b = tag`width: ${otherValue}px;`.parametrics[0];
    expect(hashParametricAtom(a!)).toBe(hashParametricAtom(b!));
    expect(a?.slots[0]?.id).toBe(b?.slots[0]?.id);
  });

  it('splits trailing !important off runtime declarations', () => {
    const out = tag`width: ${dynamicValue}px !important;`;
    expect(out.parametrics[0]?.important).toBe(true);
    expect(out.parametrics[0]?.valueTemplate.at(-1)).toEqual({ kind: 'text', text: 'px' });
  });
});

describe('css template overload', () => {
  it('returns a handle with atoms (TYP-007)', () => {
    const h = css`
      display: flex;
      gap: 8px;
    `;
    expect(h.__qstyleBrand).toBe('StyleHandle');
    expect(h.atoms).toHaveLength(2);
  });
});
