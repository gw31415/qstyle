import { describe, expect, it } from 'vitest';
import { assignOrderingGroups, hashStaticAtom, needsOrderingGroup } from '@qstyle/core';
import type { StaticAtom } from '@qstyle/core';
import { lowerStyleObject, parseNestedKey, splitImportant } from './object.js';

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

  it('lowers combinator selectors into suffix context (SEL-016)', () => {
    const out = lowerStyleObject({ '& > svg': { width: 16 } });
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]?.context.suffix).toBe(' > svg');
    expect(out.atoms[0]?.value).toBe('16px');
    expect(out.residuals).toHaveLength(0);
  });

  it('lowers & <simple-selector> into descendant context (SEL-021)', () => {
    const out = lowerStyleObject({ '& svg': { display: 'block' }, '& .tile': { color: 'red' } });
    expect(out.atoms).toHaveLength(2);
    expect(out.atoms[0]?.context.descendant).toBe('svg');
    expect(out.atoms[1]?.context.descendant).toBe('.tile');
  });

  it('lowers multi-level descendants and pseudo on descendant into suffix (SEL-022)', () => {
    expect(lowerStyleObject({ '& a b': { display: 'block' } }).atoms[0]?.context.suffix).toBe(
      ' a b',
    );
    expect(lowerStyleObject({ '& svg:hover': { display: 'block' } }).atoms[0]?.context.suffix).toBe(
      ' svg:hover',
    );
    // `&` の再出現は解決不能のため residual のまま。
    const out = lowerStyleObject({ '&& svg': { display: 'block' } });
    expect(out.atoms).toHaveLength(0);
    expect(out.residuals[0]?.reason).toBe('unsupported-selector');
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

describe('lowerStyleObject value serialization', () => {
  it('kebab-cases vendor-prefixed properties with meaning intact (OBJ-004)', () => {
    const out = lowerStyleObject({
      WebkitTransform: 'translateX(1px)',
      MozAppearance: 'none',
      OTransition: 'none',
      // @ts-expect-error csstype が落とした legacy prop は型で拒否するが、実行時は正規化する
      msFlexAlign: 'center',
    });
    const byProp = Object.fromEntries(out.atoms.map((a) => [a.property, a.value]));
    expect(byProp['-webkit-transform']).toBe('translateX(1px)');
    expect(byProp['-moz-appearance']).toBe('none');
    expect(byProp['-o-transition']).toBe('none');
    // `ms` は小文字始まりの vendor prefix (`ms-flex-align` は不正)。
    expect(byProp['-ms-flex-align']).toBe('center');
    expect(out.residuals).toHaveLength(0);
  });

  it('keeps CSS variable references intact (OBJ-013)', () => {
    const out = lowerStyleObject({ color: 'var(--x)', padding: 'var(--a, 1px)' });
    expect(out.residuals).toHaveLength(0);
    const byProp = Object.fromEntries(out.atoms.map((a) => [a.property, a.value]));
    expect(byProp['color']).toBe('var(--x)');
    expect(byProp['padding']).toBe('var(--a, 1px)');
    // 定義側の custom property も素通しで、参照を壊さない。
    const def = lowerStyleObject({ '--x': '#00f', '--a': '2px' });
    expect(def.atoms.map((a) => [a.property, a.value])).toEqual([
      ['--x', '#00f'],
      ['--a', '2px'],
    ]);
  });

  it('keeps calc/min/clamp values intact (OBJ-014)', () => {
    const out = lowerStyleObject({
      width: 'calc(100% - 8px)',
      fontSize: 'min(1rem, 4vw)',
      padding: 'clamp(1px, 2vw, 8px)',
    });
    expect(out.residuals).toHaveLength(0);
    const byProp = Object.fromEntries(out.atoms.map((a) => [a.property, a.value]));
    expect(byProp['width']).toBe('calc(100% - 8px)');
    expect(byProp['font-size']).toBe('min(1rem, 4vw)');
    expect(byProp['padding']).toBe('clamp(1px, 2vw, 8px)');
  });

  it('keeps comma-separated token boundaries (OBJ-015)', () => {
    const out = lowerStyleObject({
      fontFamily: 'Arial, sans-serif',
      transitionProperty: 'color, background-color',
    });
    expect(out.residuals).toHaveLength(0);
    const fonts = out.atoms.find((a) => a.property === 'font-family')?.value ?? '';
    expect(fonts).toBe('Arial, sans-serif');
    // token 列の境界 (comma) と順序が保たれる。
    expect(fonts.split(',').map((t) => t.trim())).toEqual(['Arial', 'sans-serif']);
  });

  it('keeps quoting and escapes in content values (OBJ-016)', () => {
    const out = lowerStyleObject({
      content: '"quoted"',
      quotes: `'"inner"'`,
      // @ts-expect-error 未知 property は型で拒否するが、実行時は素通しする (OBJ-016)
      escaped: '\\"',
    });
    expect(out.residuals).toHaveLength(0);
    const byProp = Object.fromEntries(out.atoms.map((a) => [a.property, a.value]));
    expect(byProp['content']).toBe('"quoted"');
    expect(byProp['quotes']).toBe(`'"inner"'`);
    expect(byProp['escaped']).toBe('\\"');
  });

  it('keeps data URLs and quoted urls intact (OBJ-017)', () => {
    const svg = 'url(data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27/%3E)';
    const out = lowerStyleObject({
      backgroundImage: svg,
      maskImage: 'url("https://example.com/a.png")',
    });
    expect(out.residuals).toHaveLength(0);
    const byProp = Object.fromEntries(out.atoms.map((a) => [a.property, a.value]));
    expect(byProp['background-image']).toBe(svg);
    expect(byProp['mask-image']).toBe('url("https://example.com/a.png")');
  });

  it('emits unknown property typos as-is (OBJ-022 — 現状固定)', () => {
    // 未知だが well-formed な property は atom として出し、解釈は CSS 自身の
    // 前方互換 error recovery (browser が未知 property を無視する) に委ねる。
    // 既知 property table による明示 diagnostic は R4 (plan.md §6.2) で扱う。
    // @ts-expect-error typo は型で拒否するが、実行時は atom 化する (OBJ-022)
    const out = lowerStyleObject({ displayy: 'flex' });
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]?.property).toBe('displayy');
    expect(out.atoms[0]?.value).toBe('flex');
    expect(out.residuals).toHaveLength(0);
    expect(out.diagnostics).toHaveLength(0);
  });

  it('does not silently emit invalid value syntax (OBJ-023)', () => {
    const out = lowerStyleObject({ display: 'fl<<ex' });
    expect(out.atoms).toHaveLength(0);
    expect(out.residuals).toHaveLength(1);
    expect(out.residuals[0]?.reason).toBe('unsupported-syntax');
    expect(out.diagnostics.some((d) => d.severity === 'warn')).toBe(true);
    // declaration 境界を壊す値も silent emit しない。
    const inject = lowerStyleObject({ color: 'red; background: url(x)' });
    expect(inject.atoms).toHaveLength(0);
    expect(inject.residuals[0]?.reason).toBe('unsupported-syntax');
  });

  it('serializes unicode values intact (OBJ-024)', () => {
    const out = lowerStyleObject({ content: '"日本語と English"' });
    expect(out.residuals).toHaveLength(0);
    expect(out.atoms[0]?.property).toBe('content');
    expect(out.atoms[0]?.value).toBe('"日本語と English"');
  });

  it('passes var() with fallback through serialization (CSS-006/007)', () => {
    const out = lowerStyleObject({ color: 'var(--brand, blue)' });
    expect(out.atoms[0]?.value).toBe('var(--brand, blue)');
    // 等価な空白表現は canonical 化で同一になる (fallback 依存の意味を壊さない)。
    const padded = lowerStyleObject({ color: 'var(--brand,  blue)' });
    expect(padded.atoms[0]?.value).toBe('var(--brand, blue)');
  });

  it('splits trailing !important into the flag (CSS-008)', () => {
    expect(splitImportant('red !important')).toEqual({ value: 'red', important: true });
    expect(splitImportant('red')).toEqual({ value: 'red', important: false });
    const out = lowerStyleObject({ color: 'red !important' });
    expect(out.atoms[0]?.important).toBe(true);
    expect(out.atoms[0]?.value).toBe('red');
    expect(lowerStyleObject({ color: 'red' }).atoms[0]?.important).toBe(false);
    // priority の違いは identity に反映される。
    const important = out.atoms[0]!;
    const plain = lowerStyleObject({ color: 'red' }).atoms[0]!;
    expect(hashStaticAtom(important)).not.toBe(hashStaticAtom(plain));
  });

  it('passes animation values through without misconversion (CSS-013)', () => {
    const out = lowerStyleObject({
      animation: 'slide 1s linear infinite',
      animationDelay: '250ms',
      animationIterationCount: 3,
    });
    expect(out.residuals).toHaveLength(0);
    const byProp = Object.fromEntries(out.atoms.map((a) => [a.property, a.value]));
    // shorthand は token 列がそのまま出る (`1s` が `1spx` 等に化けない)。
    expect(byProp['animation']).toBe('slide 1s linear infinite');
    expect(byProp['animation-delay']).toBe('250ms');
    expect(byProp['animation-iteration-count']).toBe('3');
    // animation shorthand との順序依存は ordering group で保護される。
    expect(needsOrderingGroup('animation', 'animation-duration')).toBe(true);
    const grouped = assignOrderingGroups(
      [...out.atoms, ...lowerStyleObject({ animationDuration: '2s' }).atoms] as StaticAtom[],
    );
    const shorthand = grouped.find((a) => a.property === 'animation');
    const duration = grouped.find((a) => a.property === 'animation-duration');
    expect(shorthand?.ordering.group).toBe(duration?.ordering.group);
  });
});

describe('lowerStyleObject selectors and at-rules', () => {
  it('accepts &:focus and &:focus-visible as pseudo context (SEL-002)', () => {
    const out = lowerStyleObject({
      '&:focus': { outline: 'none' },
      '&:focus-visible': { outline: '2px solid blue' },
    });
    expect(out.residuals).toHaveLength(0);
    expect(out.atoms[0]?.context.pseudo).toEqual([':focus']);
    expect(out.atoms[1]?.context.pseudo).toEqual([':focus-visible']);
  });

  it('accepts &::before and &::after as pseudo elements (SEL-003)', () => {
    const out = lowerStyleObject({
      '&::before': { content: '""' },
      '&::after': { content: '"†"' },
    });
    expect(out.residuals).toHaveLength(0);
    expect(out.atoms[0]?.context.pseudo).toEqual(['::before']);
    expect(out.atoms[1]?.context.pseudo).toEqual(['::after']);
  });

  it('accepts :is() selector-list args and :has() relational args as suffix (SEL-008/009)', () => {
    expect(parseNestedKey('&:is(.a, .b)')).toEqual({ suffix: ':is(.a, .b)' });
    expect(parseNestedKey('&:has(> img)')).toEqual({ suffix: ':has(> img)' });
    for (const key of ['&:is(.a, .b)', '&:has(> img)']) {
      // @ts-expect-error 任意キーの実行時分類を通す (型は closed)
      const out = lowerStyleObject({ [key]: { color: 'red' } });
      expect(out.atoms).toHaveLength(1);
      expect(out.residuals).toHaveLength(0);
    }
    // 単一の simple arg (空白なし) は pseudo として受理される (従来どおり)。
    expect(parseNestedKey('&:not(.foo)')).toEqual({ pseudo: [':not(.foo)'] });
    expect(lowerStyleObject({ '&:not(.foo)': { color: 'red' } }).atoms[0]?.context.pseudo).toEqual(
      [':not(.foo)'],
    );
  });

  it('residualizes re-occurrence of & (SEL-010 — 現状固定)', () => {
    for (const key of ['&:hover &', '& &']) {
      // @ts-expect-error 任意キーの実行時分類を通す (型は closed)
      const out = lowerStyleObject({ [key]: { color: 'red' } });
      expect(out.atoms).toHaveLength(0);
      expect(out.residuals[0]?.reason).toBe('unsupported-selector');
      expect(out.diagnostics.some((d) => d.severity === 'warn')).toBe(true);
    }
  });

  it('combines media and pseudo contexts (SEL-012)', () => {
    const out = lowerStyleObject({
      color: 'black',
      '@media (width >= 768px)': { '&:hover': { color: 'blue' } },
    });
    expect(out.residuals).toHaveLength(0);
    const base = out.atoms.find((a) => a.value === 'black');
    const hover = out.atoms.find((a) => a.value === 'blue');
    expect(base?.context.media).toBeUndefined();
    expect(base?.context.pseudo).toBeUndefined();
    expect(hover?.context.media).toBe('(width >= 768px)');
    expect(hover?.context.pseudo).toEqual([':hover']);
  });

  it('accepts @supports with the condition preserved (SEL-013)', () => {
    const out = lowerStyleObject({ '@supports (display: grid)': { display: 'grid' } });
    expect(out.residuals).toHaveLength(0);
    expect(out.atoms[0]?.context.supports).toBe('(display: grid)');
    expect(out.atoms[0]?.value).toBe('grid');
  });

  it('accepts @container with the condition preserved (SEL-014)', () => {
    const out = lowerStyleObject({ '@container card (min-width: 400px)': { padding: 4 } });
    expect(out.residuals).toHaveLength(0);
    expect(out.atoms[0]?.context.container).toBe('card (min-width: 400px)');
    expect(out.atoms[0]?.value).toBe('4px');
  });

  it('accepts cascade layer at-rules as layer context (SEL-015)', () => {
    const out = lowerStyleObject({ '@layer base': { color: 'red' } });
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]?.context.layer).toBe('base');
    expect(out.residuals).toHaveLength(0);
    // dotted layer 名・anonymous layer も受理する。不正 prelude は residual。
    expect(lowerStyleObject({ '@layer base.components': { color: 'red' } }).atoms[0]?.context.layer).toBe(
      'base.components',
    );
    expect(lowerStyleObject({ '@layer': { color: 'red' } }).atoms[0]?.context.layer).toBe('');
    const bad = lowerStyleObject({ '@layer base; x': { color: 'red' } });
    expect(bad.atoms).toHaveLength(0);
    expect(bad.residuals[0]?.reason).toBe('unsupported-at-rule');
  });
});

describe('lowerStyleObject SCSS-like nesting (suffix)', () => {
  it('lowers &-concatenation and attribute selectors into suffix', () => {
    expect(lowerStyleObject({ '&--mod': { color: 'red' } }).atoms[0]?.context.suffix).toBe('--mod');
    expect(lowerStyleObject({ '&.active': { color: 'red' } }).atoms[0]?.context.suffix).toBe(
      '.active',
    );
    expect(
      lowerStyleObject({ '&[type="text"]': { color: 'red' } }).atoms[0]?.context.suffix,
    ).toBe('[type="text"]');
    expect(lowerStyleObject({ '& + sib': { color: 'red' } }).atoms[0]?.context.suffix).toBe(
      ' + sib',
    );
    expect(lowerStyleObject({ '& ~ sib': { color: 'red' } }).atoms[0]?.context.suffix).toBe(
      ' ~ sib',
    );
  });

  it('expands comma selector lists with class on each item', () => {
    const out = lowerStyleObject({ '&:hover, &:focus': { color: 'red' } });
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]?.context.suffix).toBe(':hover,:focus');
    // `&` 付き継続も受理する。descendant 継続は各要素に space を付与する。
    expect(lowerStyleObject({ '&:hover, &:focus': { color: 'red' } }).atoms).toHaveLength(1);
    expect(lowerStyleObject({ '& .a, & .b': { color: 'red' } }).atoms[0]?.context.suffix).toBe(
      ' .a, .b',
    );
    expect(lowerStyleObject({ '& .a, .b': { color: 'red' } }).atoms[0]?.context.suffix).toBe(
      ' .a, .b',
    );
  });

  it('combines nested contexts (media > pseudo > suffix, layer merge)', () => {
    const out = lowerStyleObject({
      '@media (width >= 768px)': { '&:hover': { '& .x': { color: 'blue' } } },
    });
    expect(out.residuals).toHaveLength(0);
    const atom = out.atoms[0];
    expect(atom?.context.media).toBe('(width >= 768px)');
    expect(atom?.context.pseudo).toEqual([':hover']);
    expect(atom?.context.descendant).toBe('.x');
    // suffix 同士は直積で結合する (外側×内側の順序を保つ)。
    const cross = lowerStyleObject({ '&:hover, &:focus': { '& .x': { color: 'red' } } });
    expect(cross.atoms[0]?.context.suffix).toBe(':hover .x,:focus .x');
    // nested layer は dotted 結合する。
    const layered = lowerStyleObject({ '@layer a': { '@layer b': { color: 'red' } } });
    expect(layered.atoms[0]?.context.layer).toBe('a.b');
  });

  it('still residualizes & re-occurrence and breaking characters', () => {
    for (const key of ['&:hover &', '& &', '& <div', '&;x', '&{x']) {
      // @ts-expect-error 任意キーの実行時分類を通す (型は closed)
      const out = lowerStyleObject({ [key]: { color: 'red' } });
      expect(out.atoms).toHaveLength(0);
      expect(out.residuals).toHaveLength(1);
    }
  });
});

describe('lowerStyleObject @keyframes and globals', () => {
  it('lowers @keyframes and rewrites animation references to the hashed name', () => {
    const out = lowerStyleObject({
      '@keyframes fade': { from: { opacity: 0 }, to: { opacity: 1 } },
      animation: 'fade 1s ease',
      animationName: 'fade',
    });
    expect(out.residuals).toHaveLength(0);
    expect(out.keyframes).toHaveLength(1);
    const name: string = out.keyframes[0]?.name ?? '';
    expect(name).toMatch(/^qkf_[0-9a-f]{8}$/);
    const byProp = Object.fromEntries(out.atoms.map((a) => [a.property, a.value]));
    expect(byProp['animation']).toBe(`${name} 1s ease`);
    expect(byProp['animation-name']).toBe(name);
  });

  it('dedups identical keyframes across different names (content identity)', () => {
    const a = lowerStyleObject({ '@keyframes one': { from: { opacity: 0 } } });
    const b = lowerStyleObject({ '@keyframes two': { from: { opacity: 0 } } });
    expect(a.keyframes[0]?.name).toBe(b.keyframes[0]?.name);
  });

  it('does not rewrite CSS-wide keywords or partial matches', () => {
    const out = lowerStyleObject({
      '@keyframes fade': { from: { opacity: 0 } },
      animation: 'none',
      animationName: 'fadein',
    });
    const byProp = Object.fromEntries(out.atoms.map((a) => [a.property, a.value]));
    expect(byProp['animation']).toBe('none');
    expect(byProp['animation-name']).toBe('fadein');
  });

  it('residualizes nested @keyframes and invalid frames (no silent emit)', () => {
    const nested = lowerStyleObject({ '@media (x)': { '@keyframes fade': { from: { opacity: 0 } } } });
    expect(nested.keyframes).toHaveLength(0);
    expect(nested.residuals.some((r) => r.reason === 'unsupported-at-rule')).toBe(true);
    const bad = lowerStyleObject({ '@keyframes fade': { middle: { opacity: 0 } } });
    expect(bad.keyframes).toHaveLength(0);
    expect(bad.residuals.length).toBeGreaterThan(0);
    expect(bad.diagnostics.some((d) => d.severity === 'warn')).toBe(true);
  });

  it('lowers @font-face and @property into globals', () => {
    const out = lowerStyleObject({
      '@font-face': { fontFamily: 'MyFont', src: 'url(/a.woff2)' },
      '@property --brand': { syntax: '"<color>"', inherits: 'false', initialValue: 'red' },
    });
    expect(out.residuals).toHaveLength(0);
    expect(out.globals).toHaveLength(2);
    expect(out.globals[0]?.at).toBe('font-face');
    expect(out.globals[1]?.prelude).toBe('--brand');
  });

  it('rewrites references via the external module table (local wins)', () => {
    const external = new Map([['fade', 'qkf_external']]);
    const out = lowerStyleObject({ animationName: 'fade' }, { keyframes: external });
    expect(out.atoms[0]?.value).toBe('qkf_external');
    const local = lowerStyleObject(
      { '@keyframes fade': { from: { opacity: 0 } }, animationName: 'fade' },
      { keyframes: external },
    );
    expect(local.atoms[0]?.value).toBe(local.keyframes[0]?.name);
    expect(local.atoms[0]?.value).not.toBe('qkf_external');
  });
});
