import { describe, expect, it } from 'vitest';
import { createStaticAtom } from './atom.js';
import type { StaticAtom } from './ir.js';
import {
  SHORTHAND_MAP,
  assignOrderingGroups,
  classifyDeclaration,
  isReservedCustomPropertyName,
  isShorthand,
  isValidCustomPropertyName,
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

  it('rejects value syntax that cannot be a single declaration (OBJ-023)', () => {
    // `<` / `>` は quoted string の外では不正な値文字。
    expect(classifyDeclaration('display', 'fl<<ex')).toEqual({
      residual: 'unsupported-syntax',
    });
    // declaration 境界 (`;`) や rule 境界 (`{` `}`) を壊す値。
    expect(classifyDeclaration('color', 'red; background: url(x)')).toEqual({
      residual: 'unsupported-syntax',
    });
    expect(classifyDeclaration('color', 'red } .evil { color: blue')).toEqual({
      residual: 'unsupported-syntax',
    });
    // unterminated quote / url。
    expect(classifyDeclaration('content', '"unterminated')).toEqual({
      residual: 'unsupported-syntax',
    });
    expect(classifyDeclaration('background-image', 'url(data:image/png;base64,AAA')).toEqual({
      residual: 'unsupported-syntax',
    });
    // empty value も silent emit しない。
    expect(classifyDeclaration('display', '')).toEqual({ residual: 'unsupported-syntax' });
  });

  it('accepts values with quoting, urls, functions, commas and unicode (OBJ-013..017/024)', () => {
    expect(classifyDeclaration('color', 'var(--x)')).toBe('atomic');
    expect(classifyDeclaration('color', 'var(--x, blue)')).toBe('atomic');
    expect(classifyDeclaration('width', 'calc(100% - 8px)')).toBe('atomic');
    expect(classifyDeclaration('width', 'min(1rem, 4vw)')).toBe('atomic');
    expect(classifyDeclaration('width', 'clamp(1px, 2vw, 8px)')).toBe('atomic');
    expect(classifyDeclaration('font-family', 'Arial, sans-serif')).toBe('atomic');
    // quoting / escape を含む content 値。
    expect(classifyDeclaration('content', '"quoted"')).toBe('atomic');
    expect(classifyDeclaration('content', '\\"')).toBe('atomic');
    expect(classifyDeclaration('quotes', `"a, b"`)).toBe('atomic');
    // data URL / quoted url。
    expect(
      classifyDeclaration(
        'background-image',
        'url(data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27/%3E)',
      ),
    ).toBe('atomic');
    expect(classifyDeclaration('background-image', 'url("https://example.com/a.png")')).toBe(
      'atomic',
    );
    // unicode。
    expect(classifyDeclaration('content', '"日本語と English"')).toBe('atomic');
  });

  it('accepts case-sensitive custom property names', () => {
    // custom property 名は大文字小文字を区別するためそのまま受理する
    // (property 規則 `^[a-z-]...` は非 custom property のみに適用)。
    expect(classifyDeclaration('--my-Var', 'x')).toBe('atomic');
    expect(classifyDeclaration('--my var', 'x')).toEqual({
      residual: 'unsupported-syntax',
    });
  });
});

describe('isValidCustomPropertyName (release blocker 2: 共有 validator)', () => {
  it('既存の有効名は維持する', () => {
    for (const name of ['--brand-color', '--my-Var', '--a-b_c', '--x', '--_x', '--x1', '--A', '--Q']) {
      expect(isValidCustomPropertyName(name)).toBe(true);
      expect(classifyDeclaration(name, 'red')).toBe('atomic');
    }
  });

  it('declaration / rule 境界を壊す名前を拒否する', () => {
    const dangerous = [
      '--a}body{color:red',
      '--a;b',
      '--a{}',
      '--a}',
      '{--a',
      '--a<b',
      '--a"b',
      "--a'b",
      '--a b',
      '--a\tb',
      '--a\nb',
      '--a\x00b',
      '--a\x07b',
    ];
    for (const name of dangerous) {
      expect(isValidCustomPropertyName(name)).toBe(false);
      expect(classifyDeclaration(name, 'red')).toEqual({ residual: 'unsupported-syntax' });
    }
  });

  it('保守的 ASCII grammar の範囲外 (escape / non-ASCII / 記号 / 数字開始) を拒否する', () => {
    const rejected = [
      '--', // prefix のみ
      '--1a', // 数字開始
      '---a', // 3 つ目の `-` で始まる ident は保守grammar対象外
      '--a.b',
      '--a(b)',
      '--a\\b', // CSS escape
      '--a/b',
      '--a,b',
      '--a=b',
      '--a#b',
      '--日本語',
      '--a🎉',
      '--a%20b',
      'not-custom',
      '',
    ];
    for (const name of rejected) {
      expect(isValidCustomPropertyName(name)).toBe(false);
    }
    // property として classify した場合も residual に落ちる (silent emit しない)。
    for (const name of ['--1a', '--a.b', '--a\\b', '--日本語', '---a']) {
      expect(classifyDeclaration(name, 'red')).toEqual({ residual: 'unsupported-syntax' });
    }
  });

  it('予約 namespace (`--qstyle` / `--qstyle-*`) を user 定義から拒否する (DYN-024)', () => {
    expect(isReservedCustomPropertyName('--qstyle')).toBe(true);
    expect(isReservedCustomPropertyName('--qstyle-abcdef-0')).toBe(true);
    expect(isReservedCustomPropertyName('--qstyle-')).toBe(true);
    expect(isReservedCustomPropertyName('--q-x')).toBe(false);
    expect(isReservedCustomPropertyName('--qstylex')).toBe(false);
    for (const name of ['--qstyle', '--qstyle-abcdef-0']) {
      expect(isValidCustomPropertyName(name)).toBe(false);
      expect(classifyDeclaration(name, 'red')).toEqual({ residual: 'unsupported-syntax' });
    }
  });
});
