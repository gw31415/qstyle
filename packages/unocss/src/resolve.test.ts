import { describe, expect, it } from 'vitest';
import presetWind4 from '@unocss/preset-wind4';
import { createUnoResolver } from './resolve.js';

async function resolver() {
  return createUnoResolver({ presets: [presetWind4()] });
}

describe('resolve', () => {
  it('resolves a plain utility to one atom', async () => {
    const uno = await resolver();
    const out = await uno.resolve(['flex']);
    expect(out.unmatched).toEqual([]);
    expect(out.verbatimCss).toBe('');
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]).toMatchObject({
      kind: 'static-atom',
      property: 'display',
      value: 'flex',
      important: false,
      context: {},
    });
  });

  it('keeps only the enhancement of a supports pair', async () => {
    const uno = await resolver();
    const out = await uno.resolve(['hover:bg-red-500']);
    expect(out.unmatched).toEqual([]);
    expect(out.verbatimCss).toBe('');
    // color-mix fallback は捨て、@supports enhancement のみ残す。
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]).toMatchObject({
      property: 'background-color',
      context: { pseudo: [':hover'], supports: '(color: color-mix(in lab, red, red))' },
    });
  });

  it('maps md: to a media context', async () => {
    const uno = await resolver();
    const out = await uno.resolve(['md:grid']);
    expect(out.unmatched).toEqual([]);
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]).toMatchObject({ property: 'display', value: 'grid' });
    expect(out.atoms[0]?.context.media).toMatch(/min-width/);
  });

  it('resolves arbitrary values', async () => {
    const uno = await resolver();
    const out = await uno.resolve(['w-[123px]']);
    expect(out.unmatched).toEqual([]);
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]).toMatchObject({ property: 'width', value: '123px' });
  });

  it('converts themed utilities via var forms', async () => {
    const uno = await resolver();
    const out = await uno.resolve(['p-4', 'bg-red-500']);
    expect(out.unmatched).toEqual([]);
    expect(out.verbatimCss).toBe('');
    const padding = out.atoms.filter((a) => a.property === 'padding');
    expect(padding).toHaveLength(1);
    expect(padding[0]?.value).toContain('var(--spacing)');
    const bg = out.atoms.filter((a) => a.property === 'background-color');
    expect(bg).toHaveLength(1);
    expect(bg[0]?.value).toContain('var(--colors-red-500)');
  });

  it('reports unmatched tokens without blocking conversion', async () => {
    const uno = await resolver();
    const out = await uno.resolve(['flex', 'no-such-class']);
    expect(out.unmatched).toEqual(['no-such-class']);
    expect(out.verbatimCss).toBe('');
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]?.property).toBe('display');
  });

  it('emits theme globals for var() references', async () => {
    const uno = await resolver();
    const out = await uno.resolve(['p-4']);
    expect(out.globals.theme).toContain('--spacing');
    expect(out.globals.base).toContain('box-sizing');
  });

  it('emits keyframes globals for opaque rules', async () => {
    const uno = await resolver();
    const out = await uno.resolve(['animate-spin']);
    expect(out.globals.keyframes).toContain('@keyframes spin');
    expect(out.atoms.map((a) => a.property)).toContain('animation');
  });

  it('falls back to verbatim for ancestor selectors', async () => {
    const uno = await resolver();
    const out = await uno.resolve(['group-hover:flex']);
    expect(out.unmatched).toEqual([]);
    expect(out.atoms).toEqual([]);
    expect(out.verbatimCss).toContain('.group');
  });

  it('falls back to verbatim for nested rules', async () => {
    const uno = await resolver();
    const out = await uno.resolve(['divide-x']);
    expect(out.atoms).toEqual([]);
    expect(out.verbatimCss).toContain(':where');
  });

  it('resolves same-property conflicts by output order, not class order', async () => {
    const uno = await resolver();
    for (const tokens of [['p-4', 'p-2'], ['p-2', 'p-4']] as const) {
      const out = await uno.resolve([...tokens]);
      expect(out.unmatched).toEqual([]);
      expect(out.verbatimCss).toBe('');
      const padding = out.atoms.filter((a) => a.property === 'padding');
      expect(padding).toHaveLength(1);
      expect(padding[0]?.value).toContain('* 4');
    }
  });

  it('falls back to verbatim for shorthand/longhand pairs', async () => {
    const uno = await resolver();
    const out = await uno.resolve(['m-4', 'mt-2']);
    expect(out.atoms).toEqual([]);
    expect(out.verbatimCss).toContain('.m-4');
    expect(out.verbatimCss).toContain('.mt-2');
  });

  it('keeps independent longhands of one shorthand', async () => {
    const uno = await resolver();
    const out = await uno.resolve(['mt-2', 'ml-4']);
    expect(out.unmatched).toEqual([]);
    expect(out.verbatimCss).toBe('');
    expect(out.atoms.map((a) => a.property).sort()).toEqual([
      'margin-left',
      'margin-top',
    ]);
  });

  it('falls back to verbatim for same-property cross-context pairs', async () => {
    const uno = await resolver();
    for (const tokens of [['p-4', 'md:p-4'], ['hover:p-4', 'focus:p-4']] as const) {
      const out = await uno.resolve([...tokens]);
      expect(out.atoms).toEqual([]);
      expect(out.verbatimCss).not.toBe('');
    }
  });

  it('keeps base/pseudo pairs (specificity decides)', async () => {
    const uno = await resolver();
    const out = await uno.resolve(['p-4', 'hover:p-4']);
    expect(out.unmatched).toEqual([]);
    expect(out.verbatimCss).toBe('');
    expect(out.atoms).toHaveLength(2);
  });

  it('composes filter chains via carried vars', async () => {
    const uno = await resolver();
    const out = await uno.resolve(['blur-sm', 'brightness-110']);
    expect(out.verbatimCss).toBe('');
    const filters = out.atoms.filter((a) => a.property === 'filter');
    expect(filters).toHaveLength(1);
    expect(out.atoms.map((a) => a.property)).toContain('--un-blur');
    expect(out.atoms.map((a) => a.property)).toContain('--un-brightness');
  });

  it('composes text size with leading override', async () => {
    const uno = await resolver();
    const out = await uno.resolve(['text-sm', 'leading-4']);
    expect(out.verbatimCss).toBe('');
    expect(out.atoms.map((a) => a.property)).toContain('font-size');
    expect(out.atoms.filter((a) => a.property === 'line-height')).toHaveLength(1);
  });
});

describe('resolve aliases', () => {
  it('rewrites verbatim selectors without changing declarations', async () => {
    const uno = await resolver();
    const plain = await uno.resolve(['divide-y']);
    expect(plain.verbatimCss).toContain('.divide-y');
    const aliased = await uno.resolve(['divide-y'], {
      verbatimOnly: true,
      aliases: new Map([['divide-y', 'qu_12345678']]),
    });
    expect(aliased.unmatched).toEqual([]);
    expect(aliased.verbatimCss).not.toContain('.divide-y');
    expect(aliased.verbatimCss).toContain('.qu_12345678');
    // 宣言内容は同一 (border 幅の指定が残る)。
    expect(aliased.verbatimCss).toContain('border-top-width');
  });

  it('keeps unmapped and unmatched refs as-is', async () => {
    const uno = await resolver();
    // group-hover は祖先 `.group` (unmatched) と対象 token の複合 selector。
    // alias 表に `group` が含まれていても、当該解決集合に無いため書換えない。
    const out = await uno.resolve(['group-hover:flex'], {
      verbatimOnly: true,
      aliases: new Map([
        ['group-hover:flex', 'qu_aaaaaaaa'],
        ['group', 'qu_bbbbbbbb'],
      ]),
    });
    expect(out.unmatched).toEqual([]);
    expect(out.verbatimCss).toContain('.qu_aaaaaaaa');
    expect(out.verbatimCss).not.toContain('.qu_bbbbbbbb');
    // marker の `.group` は unmatched のため原文維持。
    expect(out.verbatimCss).toContain('.group');
  });

  it('does not touch unmatched tokens even when aliased', async () => {
    const uno = await resolver();
    const out = await uno.resolve(['flex', 'my-card'], {
      verbatimOnly: true,
      aliases: new Map([
        ['flex', 'qu_bbbbbbbb'],
        ['my-card', 'qu_cccccccc'],
      ]),
    });
    expect(out.unmatched).toEqual(['my-card']);
    expect(out.verbatimCss).toContain('.qu_bbbbbbbb');
    expect(out.verbatimCss).not.toContain('.flex');
  });
});
