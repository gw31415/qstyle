import { describe, expect, it } from 'vitest';
import { hashStaticAtom } from '@qstyle/core';
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

describe('lowerTaggedTemplate dynamic stub', () => {
  it('residualizes runtime interpolations (TPL-007/008)', () => {
    const dynamicValue = {} as unknown;
    const out = tag`width: ${dynamicValue};`;
    expect(out.atoms).toHaveLength(0);
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
