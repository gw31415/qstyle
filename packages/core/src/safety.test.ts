import { describe, expect, it } from 'vitest';
import { createStaticAtom } from './atom.js';
import type { StaticAtom } from './ir.js';
import {
  SHORTHAND_MAP,
  assignOrderingGroups,
  classifyDeclaration,
  isShorthand,
  longhandsOf,
  needsOrderingGroup,
} from './safety.js';

function atomsOf(...props: readonly string[]): StaticAtom[] {
  return props.map((p) =>
    createStaticAtom({ property: p, value: `${p === 'color' ? 'red' : '0'}` }),
  );
}

function at(list: readonly StaticAtom[], index: number): StaticAtom {
  const atom: StaticAtom | undefined = list[index];
  if (atom === undefined) throw new Error(`missing atom ${index}`);
  return atom;
}

describe('shorthand map', () => {
  it('covers the documented shorthands in kebab-case', () => {
    expect(SHORTHAND_MAP.size).toBeGreaterThanOrEqual(20);
    for (const [shorthand, longhands] of SHORTHAND_MAP) {
      expect(shorthand).toMatch(/^[a-z-]+$/);
      expect(longhands.length).toBeGreaterThan(0);
      expect(longhands).not.toContain(shorthand);
    }
  });

  it('does not treat gap / grid-gap as shorthands', () => {
    expect(SHORTHAND_MAP.has('gap')).toBe(false);
    expect(SHORTHAND_MAP.has('grid-gap')).toBe(false);
  });

  it('canonicalizes camelCase input (longhandsOf / isShorthand)', () => {
    expect(longhandsOf('background')).toEqual([
      'background-color',
      'background-image',
      'background-position',
      'background-size',
      'background-repeat',
      'background-origin',
      'background-clip',
      'background-attachment',
    ]);
    expect(longhandsOf('placeContent')).toEqual(['align-content', 'justify-content']);
    expect(isShorthand('flexFlow')).toBe(true);
    expect(longhandsOf('backgroundColor')).toEqual([]);
    expect(longhandsOf('color')).toEqual([]);
    expect(longhandsOf('--custom')).toEqual([]);
    expect(isShorthand('color')).toBe(false);
  });
});

describe('needsOrderingGroup', () => {
  it('flags shorthand -> longhand (CSS-001)', () => {
    expect(needsOrderingGroup('margin', 'margin-top')).toBe(true);
    expect(needsOrderingGroup('background', 'background-color')).toBe(true);
  });

  it('flags longhand -> shorthand (CSS-002)', () => {
    expect(needsOrderingGroup('margin-top', 'margin')).toBe(true);
    expect(needsOrderingGroup('background-color', 'background')).toBe(true);
  });

  it('flags logical vs physical interaction (CSS-003)', () => {
    expect(needsOrderingGroup('margin-inline-start', 'margin-left')).toBe(true);
    expect(needsOrderingGroup('padding-inline-end', 'padding-right')).toBe(true);
    expect(needsOrderingGroup('inset-block-start', 'top')).toBe(true);
    expect(needsOrderingGroup('border-inline-start-width', 'border-left-width')).toBe(true);
  });

  it('does not flag independent properties', () => {
    expect(needsOrderingGroup('display', 'color')).toBe(false);
    expect(needsOrderingGroup('margin-left', 'padding-left')).toBe(false);
    expect(needsOrderingGroup('margin-block-start', 'margin-inline-start')).toBe(false);
    // border-left-width / border-left-style は border-left 祖先を共有するため true (保守的)。
    expect(needsOrderingGroup('border-left-width', 'border-left-style')).toBe(true);
    expect(needsOrderingGroup('border-left-width', 'border-top-style')).toBe(false);
  });

  it('flags shared shorthand ancestors and same property', () => {
    expect(needsOrderingGroup('margin-top', 'margin-left')).toBe(true);
    expect(needsOrderingGroup('border-top', 'border-color')).toBe(true);
    expect(needsOrderingGroup('margin', 'margin')).toBe(true);
  });

  it('never groups custom properties (atomic-safe passthrough)', () => {
    expect(needsOrderingGroup('--x', '--x')).toBe(false);
    expect(needsOrderingGroup('--x', 'margin')).toBe(false);
  });
});

describe('assignOrderingGroups', () => {
  it('shares one group id across dependent atoms and keeps order (DED-013)', () => {
    const input: StaticAtom[] = atomsOf('margin', 'color', 'margin-top');
    const result: StaticAtom[] = assignOrderingGroups(input);
    const margin: StaticAtom = at(result, 0);
    const color: StaticAtom = at(result, 1);
    const marginTop: StaticAtom = at(result, 2);
    expect(margin.ordering.group).toBeDefined();
    expect(margin.ordering.group).toBe(marginTop.ordering.group);
    expect(marginTop.ordering.group).toMatch(/^og_[0-9a-f]{6}$/);
    expect(color.ordering.group).toBeUndefined();
    expect(marginTop.ordering.after).toBeUndefined();
    expect(result.map((a) => a.property)).toEqual(['margin', 'color', 'margin-top']);
  });

  it('is deterministic across repeated runs', () => {
    const first: StaticAtom[] = assignOrderingGroups(atomsOf('padding', 'padding-top', 'color'));
    const second: StaticAtom[] = assignOrderingGroups(atomsOf('padding', 'padding-top', 'color'));
    expect(second).toEqual(first);
    expect(at(first, 0).ordering.group).toBe(at(first, 1).ordering.group);
  });

  it('keeps independent atoms untouched (same node, no group)', () => {
    const input: StaticAtom[] = atomsOf('display', 'color');
    const output: StaticAtom[] = assignOrderingGroups(input);
    expect(at(output, 0)).toBe(at(input, 0));
    expect(at(output, 1)).toBe(at(input, 1));
  });

  it('preserves existing after/before constraints when adding a group', () => {
    const withAfter: StaticAtom = createStaticAtom({
      property: 'margin-left',
      value: '10px',
      ordering: { after: ['other'] },
    });
    const result: StaticAtom[] = assignOrderingGroups([withAfter, at(atomsOf('margin'), 0)]);
    expect(at(result, 0).ordering.after).toEqual(['other']);
    expect(at(result, 0).ordering.group).toBe(at(result, 1).ordering.group);
  });
});

describe('classifyDeclaration', () => {
  it('accepts normal and custom property declarations', () => {
    expect(classifyDeclaration('color', 'red')).toBe('atomic');
    expect(classifyDeclaration('--brand-color', 'var(--x, blue)')).toBe('atomic');
    expect(classifyDeclaration('background-color', ' url(x.png) ')).toBe('atomic');
  });

  it('rejects empty or malformed properties/values (FLB-010)', () => {
    expect(classifyDeclaration('', 'red')).toEqual({ residual: 'unsupported-syntax' });
    expect(classifyDeclaration('color', '   ')).toEqual({ residual: 'unsupported-syntax' });
    expect(classifyDeclaration('Color', 'red')).toEqual({ residual: 'unsupported-syntax' });
    expect(classifyDeclaration('col or', 'red')).toEqual({ residual: 'unsupported-syntax' });
    expect(classifyDeclaration('--', 'red')).toEqual({ residual: 'unsupported-syntax' });
    expect(classifyDeclaration('margin:', '1px')).toEqual({ residual: 'unsupported-syntax' });
  });

  it('rejects known unsafe properties and values', () => {
    expect(classifyDeclaration('behavior', 'url(x.htc)')).toEqual({
      residual: 'unsupported-syntax',
    });
    expect(classifyDeclaration('-moz-binding', 'url(x.xml)')).toEqual({
      residual: 'unsupported-syntax',
    });
    expect(classifyDeclaration('width', 'expression(alert(1))')).toEqual({
      residual: 'unsupported-syntax',
    });
    expect(classifyDeclaration('background', 'url(javascript:alert(1))')).toEqual({
      residual: 'unsupported-syntax',
    });
    expect(classifyDeclaration('background', 'URL( javascript:alert(1))')).toEqual({
      residual: 'unsupported-syntax',
    });
  });
});
