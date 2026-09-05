import { describe, expect, it } from 'vitest';
import { lowerStyleObject } from './object.js';

describe('lowerStyleObject', () => {
  it('lowers a single declaration (OBJ-001)', () => {
    const out = lowerStyleObject({ display: 'flex' });
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]?.property).toBe('display');
    expect(out.atoms[0]?.value).toBe('flex');
    expect(out.residuals).toHaveLength(0);
  });

  it('keeps all declarations (OBJ-002)', () => {
    const out = lowerStyleObject({ display: 'flex', gap: 8 });
    expect(out.atoms).toHaveLength(2);
    expect(out.atoms.map((a) => a.property).sort()).toEqual(['display', 'gap']);
  });

  it('converts camelCase to kebab-case (OBJ-003)', () => {
    const out = lowerStyleObject({ backgroundColor: 'red' });
    expect(out.atoms[0]?.property).toBe('background-color');
  });

  it('keeps custom properties as-is (OBJ-005)', () => {
    const out = lowerStyleObject({ '--my-var': '1px' });
    expect(out.atoms[0]?.property).toBe('--my-var');
  });

  it('handles unitless / length / zero numbers (OBJ-006/007/008)', () => {
    const out = lowerStyleObject({ opacity: 0.5, gap: 8, margin: 0 });
    const byProp = Object.fromEntries(out.atoms.map((a) => [a.property, a.value]));
    expect(byProp['opacity']).toBe('0.5');
    expect(byProp['gap']).toBe('8px');
    expect(byProp['margin']).toBe('0');
  });

  it('passes CSS-wide keywords through (OBJ-011/012)', () => {
    const out = lowerStyleObject({ color: 'inherit', display: 'unset' });
    expect(out.atoms.map((a) => a.value).sort()).toEqual(['inherit', 'unset']);
  });

  it('lowers &:hover into pseudo context (SEL-001)', () => {
    const out = lowerStyleObject({ color: 'black', '&:hover': { color: 'blue' } });
    expect(out.atoms).toHaveLength(2);
    const hover = out.atoms.find((a) => a.value === 'blue');
    expect(hover?.context.pseudo).toEqual([':hover']);
    expect(out.atoms.find((a) => a.value === 'black')?.context.pseudo).toBeUndefined();
  });

  it('lowers @media into media context (SEL-011)', () => {
    const out = lowerStyleObject({ '@media (width >= 768px)': { padding: 16 } });
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]?.context.media).toBe('(width >= 768px)');
    expect(out.atoms[0]?.value).toBe('16px');
  });

  it('residualizes combinator selectors instead of rewriting (SEL-016)', () => {
    const out = lowerStyleObject({ '& > svg': { width: 16 } });
    expect(out.atoms).toHaveLength(0);
    expect(out.residuals).toHaveLength(1);
    expect(out.residuals[0]?.reason).toBe('unsupported-selector');
    expect(out.diagnostics.some((d) => d.severity === 'warn')).toBe(true);
  });

  it('ignores prototype-like keys (SEC-008)', () => {
    const out = lowerStyleObject(JSON.parse('{"__proto__":{"polluted":true},"display":"flex"}'));
    expect(out.atoms).toHaveLength(1);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('emits nothing for empty objects (OBJ-018)', () => {
    const out = lowerStyleObject({});
    expect(out.atoms).toHaveLength(0);
    expect(out.residuals).toHaveLength(0);
  });
});
