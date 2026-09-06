import { describe, expect, it, vi } from 'vitest';
import { hashStaticAtom } from '@qstyle/core';
import { lowerStyleObject } from '@qstyle/qwik';
import {
  parseStyleObjectLiteral,
  parseStyleObjectLiteralWithDynamics,
  qstyle as qstyleFactory,
  serializeAtomCss,
} from './index.js';

// qstyle() は [main, dedup] の配列を返す。テストは main プラグインを対象にする。
const qstyle = (
  options: Parameters<typeof qstyleFactory>[0],
): { name?: string } => {
  const plugins = qstyleFactory(options) as unknown as readonly { name?: string }[];
  return plugins.find((p) => p.name === 'qstyle') as { name?: string };
};

/** 出力 code の pack import (`virtual:qstyle/pack/<id>.css`) から pack css を取る。 */
function packCssOf(p: { load: (id: string) => string | null }, code: string): string {
  const m: RegExpMatchArray | null = /import "virtual:qstyle\/pack\/(q_[0-9a-f]+)\.css"/.exec(code);
  return m === null ? '' : (p.load(`virtual:qstyle/pack/${m[1]}.css`) ?? '');
}

describe('qstyle vite plugin (M0)', () => {
  it('exposes vite plugin name', () => {
    const p = qstyle({});
    expect(p.name).toBe('qstyle');
  });

  it('rewrites single string-literal css prop to atom class', () => {
    const p = qstyle({ debug: false }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
      load: (id: string) => string | null;
    };
    const code = `export const A = () => <div css={{ display: 'flex' }} />;`;
    const out = p.transform(code, '/src/a.tsx');
    expect(out).not.toBeNull();
    expect(out?.code).toContain('class="q_');
    expect(out?.code).toContain('import "virtual:qstyle/pack/q_');
    expect(out?.code).not.toContain('css={{');
    const registry = p.load('virtual:qstyle/registry');
    expect(registry).toContain('display');
    expect(registry).toContain('flex');
  });

  it('leaves complex css props untouched', () => {
    const p = qstyle({ debug: false }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
    };
    // spread / call / ternary / bare handle は parse 不能または residual のため untouched。
    expect(
      p.transform(`export const A = () => <div css={{ ...base }} />;`, '/src/c.tsx'),
    ).toBeNull();
    // call 式は動的値として受理しない (M5c)。
    expect(
      p.transform(`export const A = () => <div css={{ display: getWidth() }} />;`, '/src/d2.tsx'),
    ).toBeNull();
    expect(p.transform(`export const A = () => <div css={handle} />;`, '/src/e.tsx')).toBeNull();
    // combinator selector は residual のため untouched。
    expect(
      p.transform(`export const A = () => <div css={{ '& > svg': { width: 16 } }} />;`, '/src/f.tsx'),
    ).toBeNull();
  });

  it('rewrites multi-declaration css props', () => {
    const p = qstyle({ debug: false }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
      load: (id: string) => string | null;
    };
    const code = `export const A = () => <div css={{ display: 'flex', gap: 8 }} />;`;
    const out = p.transform(code, '/src/g.tsx');
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={{');
    // §38: 適用単位で 1 class に merge される。
    expect(out?.code).toMatch(/class="q_[0-9a-f]{8}"/);
    expect(packCssOf(p, out?.code ?? '')).toMatch(
      /\.q_[0-9a-f]{8}\{display:flex;gap:8px\}/,
    );
    const registry = p.load('virtual:qstyle/registry') ?? '';
    expect(registry).toContain('display');
    expect(registry).toContain('8px');
  });

  it('rewrites &:hover nested styles with pseudo context', () => {
    const p = qstyle({ debug: false }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
      load: (id: string) => string | null;
    };
    const code = `export const A = () => <div css={{ color: 'black', '&:hover': { color: 'blue' } }} />;`;
    const out = p.transform(code, '/src/h.tsx');
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={{');
    const registry = p.load('virtual:qstyle/registry') ?? '';
    expect(registry).toContain(':hover');
  });

  it('emits descendant selector atoms for & svg (SEL-021)', () => {
    const p = qstyle({ debug: false }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
      load: (id: string) => string | null;
    };
    const code = `export const A = () => <span css={{ '& svg': { display: 'block' } }} />;`;
    const out = p.transform(code, '/src/desc.tsx');
    expect(out).not.toBeNull();
    const registry = p.load('virtual:qstyle/registry') ?? '';
    expect(registry).toMatch(/\.q_[0-9a-f]{8} svg\{display:block\}/);
  });

  it('merges with a pre-existing class attribute', () => {
    const p = qstyle({ debug: false }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
    };
    const code = `export const A = () => <div class="legacy" css={{ display: 'flex' }} />;`;
    const out = p.transform(code, '/src/i.tsx');
    expect(out).not.toBeNull();
    expect(out?.code).toContain('legacy q_');
    expect(out?.code).not.toContain('css={{');
  });

  it('merges into a pre-existing className attribute without dropping it', () => {
    const p = qstyle({ debug: false }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
    };
    // className 値を落とすと :where(.g-on) 等の既存 class 依存が壊れる (実バグ回帰)。
    const out = p.transform(
      `export const A = () => <p className="g-on" css={{ '&:where(.g-on)': { color: 'teal' } }} />;`,
      '/src/clsname.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).toMatch(/className="g-on q_[0-9a-f]{8}"/);
    expect(out?.code).not.toContain('css={{');
  });

  it('merges into an existing class={...} expression via array wrap', () => {
    const p = qstyle({ debug: false }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
    };
    const out = p.transform(
      `export const A = () => <div class={["a", cond && "b"]} css={{ display: 'flex' }} />;`,
      '/src/cls-expr.tsx',
    );
    expect(out).not.toBeNull();
    // class 属性は 1 つのまま (重複なし)。
    expect((out?.code.match(/class=/g) ?? []).length).toBe(1);
    expect(out?.code).toMatch(/class=\{\[\["a", cond && "b"\], "q_[0-9a-f]{8}"\]\}/);
    expect(out?.code).not.toContain('css={{');
  });

  it('merges with a static class attribute written after the css prop', () => {
    const p = qstyle({ debug: false }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
    };
    const out = p.transform(
      `export const A = () => <div css={{ display: 'flex' }} class="legacy" />;`,
      '/src/cls-after-css.tsx',
    );
    expect(out).not.toBeNull();
    // class 属性は 1 つのまま (重複キーを出さない)。
    expect((out?.code.match(/class=/g) ?? []).length).toBe(1);
    expect(out?.code).toMatch(/class="legacy q_[0-9a-f]{8}"/);
    expect(out?.code).not.toContain('css={{');
  });

  it('merges with a class expression written after the css prop', () => {
    const p = qstyle({ debug: false }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
    };
    const out = p.transform(
      `export const A = () => <div css={{ display: 'flex' }} class={className} />;`,
      '/src/cls-expr-after-css.tsx',
    );
    expect(out).not.toBeNull();
    expect((out?.code.match(/class=/g) ?? []).length).toBe(1);
    expect(out?.code).toMatch(/class=\{\[className, "q_[0-9a-f]{8}"\]\}/);
    expect(out?.code).not.toContain('css={{');
  });

  it('keeps the tag end scan safe when a later attribute contains >', () => {
    const p = qstyle({ debug: false }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
    };
    const out = p.transform(
      `export const A = () => <div css={{ display: 'flex' }} title="a>b">x</div>;`,
      '/src/gt-in-attr.tsx',
    );
    expect(out).not.toBeNull();
    expect((out?.code.match(/class=/g) ?? []).length).toBe(1);
    expect(out?.code).toContain('title="a>b"');
    expect(out?.code).toMatch(/class="q_[0-9a-f]{8}"/);
  });

  it('only merges css when an explicit class follows all spread props', () => {
    const p = qstyle({ debug: false }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
    };
    expect(
      p.transform(
        `export const A = (props) => <div {...props} css={{ display: 'flex' }} />;`,
        '/src/spread.tsx',
      ),
    ).toBeNull();
    expect(
      p.transform(
        `export const A = (props) => <div class="local" {...props} css={{ display: 'flex' }} />;`,
        '/src/spread-after-class.tsx',
      ),
    ).toBeNull();
    expect(
      p.transform(
        `export const A = (props) => <div {...props} title="class=" css={{ display: 'flex' }} />;`,
        '/src/class-text-after-spread.tsx',
      ),
    ).toBeNull();

    const out = p.transform(
      `export const A = (props) => <div {...props} class="local" css={{ display: 'flex' }} />;`,
      '/src/class-after-spread.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).toMatch(/class="local q_[0-9a-f]{8}"/);
    expect(out?.code).not.toContain('css={{');

    const expressionOut = p.transform(
      `export const A = (props) => <div {...props} class={{ ...classes }} css={{ display: 'flex' }} />;`,
      '/src/class-expression-after-spread.tsx',
    );
    expect(expressionOut).not.toBeNull();
    expect(expressionOut?.code).toMatch(
      /class=\{\[\{ \.\.\.classes \}, "q_[0-9a-f]{8}"\]\}/,
    );
  });

  it('ignores files without css prop', () => {
    const p = qstyle({}) as unknown as {
      transform: (code: string, id: string) => unknown;
    };
    expect(p.transform(`export const x = 1;`, '/src/b.tsx')).toBeNull();
  });
});

describe('parseStyleObjectLiteral', () => {
  it('parses flat and nested literals', () => {
    expect(parseStyleObjectLiteral(`{ display: 'flex', gap: 8 }`)).toEqual({
      display: 'flex',
      gap: 8,
    });
    expect(
      parseStyleObjectLiteral(`{ '&:hover': { opacity: 0.8, }, flag: true, v: null }`),
    ).toEqual({ '&:hover': { opacity: 0.8 }, flag: true, v: null });
  });

  it('rejects unsafe syntax', () => {
    expect(parseStyleObjectLiteral(`{ ...base }`)).toBeNull();
    expect(parseStyleObjectLiteral(`{ display: value }`)).toBeNull();
    expect(parseStyleObjectLiteral(`{ display: \`flex\` }`)).toBeNull();
    expect(parseStyleObjectLiteral(`{ a: 1 } // comment`)).toBeNull();
    expect(parseStyleObjectLiteral(`{ display: 'flex'`)).toBeNull();
  });
});

describe('serializeAtomCss', () => {
  it('serializes context wrappers deterministically', () => {
    const lowered = lowerStyleObject({ '&:hover': { color: 'blue' } });
    const atom = lowered.atoms[0];
    if (atom === undefined) throw new Error('expected atom');
    const id: string = hashStaticAtom(atom);
    expect(serializeAtomCss(atom, id)).toBe(`.${id}:hover{color:blue}`);
    const media = lowerStyleObject({ '@media (width >= 768px)': { padding: 16 } });
    const mAtom = media.atoms[0];
    if (mAtom === undefined) throw new Error('expected media atom');
    const mId: string = hashStaticAtom(mAtom);
    expect(serializeAtomCss(mAtom, mId)).toBe(
      `@media (width >= 768px){.${mId}{padding:16px}}`,
    );
  });
});

describe('parseStyleObjectLiteralWithDynamics (M5c)', () => {
  it('splits static declarations from dynamic member expressions', () => {
    const parsed = parseStyleObjectLiteralWithDynamics(
      `{ display: 'flex', width: props.width, x: a?.b, y: items[0].h }`,
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.record).toEqual({ display: 'flex' });
    expect(parsed?.dynamics).toEqual([
      { propPath: 'width', exprSource: 'props.width' },
      { propPath: 'x', exprSource: 'a?.b' },
      { propPath: 'y', exprSource: 'items[0].h' },
    ]);
  });

  it('keeps a nested object with dynamics out of the static record', () => {
    const parsed = parseStyleObjectLiteralWithDynamics(
      `{ display: 'flex', '&:hover': { width: w } }`,
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.record).toEqual({ display: 'flex' });
    expect(parsed?.dynamics).toEqual([{ propPath: '&:hover.width', exprSource: 'w' }]);
  });

  it('rejects calls and spreads (ternary values split to conditionals)', () => {
    expect(parseStyleObjectLiteralWithDynamics(`{ width: getWidth() }`)).toBeNull();
    expect(parseStyleObjectLiteralWithDynamics(`{ ...base }`)).toBeNull();
    expect(parseStyleObjectLiteralWithDynamics(`{ width: '1px'`)).toBeNull();
  });

  it('parses static template values as static text', () => {
    expect(parseStyleObjectLiteralWithDynamics('{ width: `1px` }')?.record).toEqual({
      width: '1px',
    });
  });

  it('splits compound template values into multi-slot compounds (DYN-006)', () => {
    const parsed = parseStyleObjectLiteralWithDynamics('{ transform: `translateX(${x}px)` }');
    expect(parsed).not.toBeNull();
    expect(parsed?.record).toEqual({});
    expect(parsed?.compounds).toEqual([
      {
        propPath: 'transform',
        segments: [
          { kind: 'text', text: 'translateX(' },
          { kind: 'expr', expr: 'x' },
          { kind: 'text', text: 'px)' },
        ],
      },
    ]);
    const multi = parseStyleObjectLiteralWithDynamics(
      '{ transform: `translate(${x}px, ${y}px) scale(${s})` }',
    );
    expect(multi?.compounds[0]?.segments.filter((s) => s.kind === 'expr')).toHaveLength(3);
    // 不正な補間・閉じなしは不受理。
    expect(parseStyleObjectLiteralWithDynamics('{ width: `1${get()}px` }')).toBeNull();
    expect(parseStyleObjectLiteralWithDynamics('{ width: `1px }')).toBeNull();
  });

  it('splits finite ternary values into conditionals (DYN-016)', () => {
    const parsed = parseStyleObjectLiteralWithDynamics(`{ color: flag ? 'red' : 'gray' }`);
    expect(parsed).not.toBeNull();
    expect(parsed?.record).toEqual({});
    expect(parsed?.dynamics).toEqual([]);
    expect(parsed?.conditionals).toEqual([
      { propPath: 'color', condSource: 'flag', whenTrue: 'red', whenFalse: 'gray' },
    ]);
    // number/null 枝も受理する。
    expect(
      parseStyleObjectLiteralWithDynamics(`{ opacity: c ? 1 : null }`)?.conditionals,
    ).toEqual([{ propPath: 'opacity', condSource: 'c', whenTrue: 1, whenFalse: null }]);
    // ネスト ternary・call 枝は不受理。
    expect(parseStyleObjectLiteralWithDynamics(`{ color: a ? b ? 'x' : 'y' : 'z' }`)).toBeNull();
    expect(parseStyleObjectLiteralWithDynamics(`{ color: c ? get() : 'y' }`)).toBeNull();
  });
});

describe('qstyle vite plugin dynamics (M5c)', () => {
  interface Transformable {
    transform: (code: string, id: string) => { code: string; map: null } | null;
    load: (id: string) => string | null;
  }
  // parametric 機構の検証のため promotion:'always' を明示する (default cost-based は単発を inline 化する)。
  const plugin = (): Transformable =>
    qstyle({ debug: false, runtimeStyles: { promotion: 'always' } }) as unknown as Transformable;

  /** 出力 code 内の class 属性から atom id 一覧を取る。 */
  function classIds(code: string): string[] {
    const m: RegExpMatchArray | null = /class="([^"]*)"/.exec(code);
    return m === null ? [] : (m[1] ?? '').split(/\s+/).filter(Boolean);
  }

  it('lowers a dynamic length to a parametric class + style var', () => {
    const p = plugin();
    const out = p.transform(
      `export const A = () => <div css={{ width: props.width }} />;`,
      '/src/m5c-a.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={{');
    const ids: string[] = classIds(out?.code ?? '');
    expect(ids).toHaveLength(1);
    // static + parametric も同一 unit に merge される (§38)。
    const pack: string = packCssOf(p, out?.code ?? '');
    expect(pack).toContain(`.${ids[0]}{`);
    expect(pack).toContain('width:var(--qstyle-');
    expect(out?.code).toMatch(/'--qstyle-[0-9a-f]{6}-0': props\.width/);
  });

  it('lowers a static + dynamic mix in one css prop', () => {
    const p = plugin();
    const out = p.transform(
      `export const A = () => <div css={{ display: 'flex', width: props.w, height: 10 }} />;`,
      '/src/m5c-b.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={{');
    // display:flex + width:var + height:10px が 1 unit 1 class に merge される。
    expect(classIds(out?.code ?? '')).toHaveLength(1);
    expect(out?.code).toMatch(/'--qstyle-[0-9a-f]{6}-0': props\.w/);
    const registry: string = p.load('virtual:qstyle/registry') ?? '';
    expect(registry).toContain('display');
    expect(registry).toContain('10px');
    expect(packCssOf(p, out?.code ?? '')).toContain('width:var(--qstyle-');
  });

  it('merges slot vars into an existing style prop', () => {
    const p = plugin();
    const out = p.transform(
      `export const A = () => <div style={{ color: 'red' }} css={{ width: w }} />;`,
      '/src/m5c-c.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).toMatch(/style=\{\{ color: 'red', '--qstyle-[0-9a-f]{6}-0': w \}\}/);
    expect((out?.code.match(/style=\{\{/g) ?? []).length).toBe(1);
    expect(out?.code).not.toContain('css={{');
  });

  it('merges into a style prop with a trailing comma without doubling separators', () => {
    const p = plugin();
    const out = p.transform(
      `export const A = () => <div style={{ color: 'red', }} css={{ width: w }} />;`,
      '/src/m5c-e.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).toMatch(/style=\{\{ color: 'red', '--qstyle-[0-9a-f]{6}-0': w, \}\}/);
    expect(out?.code).not.toContain(',,');
  });

  it('never derives style var names from source identifiers (SEC-005)', () => {
    const p = plugin();
    const out = p.transform(
      `export const A = () => <div css={{ width: props.width, height: props.height }} />;`,
      '/src/m5c-d.tsx',
    );
    expect(out).not.toBeNull();
    const code: string = out?.code ?? '';
    const varNames: string[] = [...code.matchAll(/'(--qstyle[^']*)'/g)].map((m) => m[0]);
    expect(varNames).toHaveLength(2);
    for (const name of varNames) {
      expect(name).toMatch(/^'--qstyle-[0-9a-f]{6}-\d+'$/);
      expect(name).not.toContain('props');
      expect(name).not.toContain('width');
      expect(name).not.toContain('height');
    }
    // source 式は style value としてのみ保持される。
    expect(code).toContain(`: props.width`);
    expect(code).toContain(`: props.height`);
  });
});

describe('qstyle css() handles + composition (M3)', () => {
  interface Transformable {
    transform: (code: string, id: string) => { code: string; map: null } | null;
    load: (id: string) => string | null;
  }
  // parametric 機構の検証のため promotion:'always' を明示する。
  const plugin = (): Transformable =>
    qstyle({ debug: false, runtimeStyles: { promotion: 'always' } }) as unknown as Transformable;
  const withImport = (body: string): string => `import { css } from '@qstyle/qwik';\n${body}`;

  /** 出力 code 内の class 属性から atom id 一覧を取る。 */
  function classIds(code: string): string[] {
    const m: RegExpMatchArray | null = /class="([^"]*)"/.exec(code);
    return m === null ? [] : (m[1] ?? '').split(/\s+/).filter(Boolean);
  }

  it('rewrites a single handle reference (CMP-001)', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        `const base = css({ display: 'flex' });\nexport const A = () => <div css={base} />;`,
      ),
      '/src/m3-a.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={base}');
    expect(classIds(out?.code ?? '')).toHaveLength(1);
    expect(out?.code).toContain('import "virtual:qstyle/pack/q_');
    const registry: string = p.load('virtual:qstyle/registry') ?? '';
    expect(registry).toContain('display');
  });

  it('merges [a,b] and resolves same-property conflicts last-wins (CMP-002/003)', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        `const base = css({ display: 'flex', color: 'blue' });\n` +
          `const sel = css({ color: 'red' });\n` +
          `export const A = () => <div css={[base, sel]} />;`,
      ),
      '/src/m3-b.tsx',
    );
    expect(out).not.toBeNull();
    // display:flex + color:red が 1 unit に merge。敗北した color:blue は出力されない。
    expect(classIds(out?.code ?? '')).toHaveLength(1);
    const packs: string = packCssOf(p, out?.code ?? '');
    expect(packs).toContain('display:flex');
    expect(packs).toContain('color:red');
    expect(packs).not.toContain('color:blue');
  });

  it('flattens nested arrays and ignores falsy entries (CMP-005/006)', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        `const a = css({ display: 'flex' });\n` +
          `const b = css({ gap: 8 });\n` +
          `export const A = () => <div css={[a, [b, false], null, undefined]} />;`,
      ),
      '/src/m3-c.tsx',
    );
    expect(out).not.toBeNull();
    expect(classIds(out?.code ?? '')).toHaveLength(1);
    expect(packCssOf(p, out?.code ?? '')).toContain('gap:8px');
    expect(out?.code).not.toContain('css={');
  });

  it('mixes handle + inline static object (CMP-008)', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        `const base = css({ display: 'flex' });\n` +
          `export const A = () => <div css={[base, { gap: 8 }]} />;`,
      ),
      '/src/m3-d.tsx',
    );
    expect(out).not.toBeNull();
    expect(classIds(out?.code ?? '')).toHaveLength(1);
    expect(packCssOf(p, out?.code ?? '')).toContain('display:flex;gap:8px');
    const registry: string = p.load('virtual:qstyle/registry') ?? '';
    expect(registry).toContain('8px');
  });

  it('dedups semantically identical handles (CMP-011)', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        `const a = css({ display: 'flex' });\n` +
          `const b = css({ display: 'flex' });\n` +
          `export const A = () => <div css={[a, b]} />;`,
      ),
      '/src/m3-e.tsx',
    );
    expect(out).not.toBeNull();
    // 同一 semantic は 1 atom に dedup される。
    expect(classIds(out?.code ?? '')).toHaveLength(1);
  });

  it('lowers handle + inline dynamic via parametric slot (21.2)', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        `const base = css({ display: 'flex' });\n` +
          `export const A = () => <div css={[base, { width: props.width }]} />;`,
      ),
      '/src/m3-f.tsx',
    );
    expect(out).not.toBeNull();
    expect(classIds(out?.code ?? '')).toHaveLength(1);
    expect(out?.code).toMatch(/'--qstyle-[0-9a-f]{6}-0': props\.width/);
  });

  it('resolves conditional composition to runtime class choice (CMP-007)', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        `const base = css({ display: 'flex' });\n` +
          `const sel = css({ color: 'red' });\n` +
          `export const A = () => <div css={[base, cond && sel]} />;`,
      ),
      '/src/m3-g.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={');
    // 無条件 class + 条件付き segment の合成式になる。
    expect(out?.code).toMatch(/class=\{".*?" \+ \(cond \? "q_[0-9a-f]{8}" : ""\)\}/);
    const packs: string = packCssOf(p, out?.code ?? '');
    expect(packs).toContain('display:flex');
    expect(packs).toContain('color:red');
  });

  it('resolves ternary branches with negation (CMP-007)', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        `const a = css({ display: 'flex' });\n` +
          `const b = css({ display: 'block' });\n` +
          `export const A = () => <div css={ok ? a : b} />;`,
      ),
      '/src/m3-g2.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).toMatch(/\(ok \? "q_[0-9a-f]{8}" : ""\)/);
    expect(out?.code).toMatch(/\(!\(ok\) \? "q_[0-9a-f]{8}" : ""\)/);
  });

  it('collapses identical ternary branches to unconditional', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        `const base = css({ display: 'flex' });\n` +
          `export const A = () => <div css={ok ? base : base} />;`,
      ),
      '/src/m3-g3.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).toMatch(/class="q_[0-9a-f]{8}"/);
    expect(out?.code).not.toContain('?');
  });

  it('merges conditional segments with an existing class literal', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        `const sel = css({ color: 'red' });\n` +
          `export const A = () => <div class="legacy" css={cond && sel} />;`,
      ),
      '/src/m3-g4.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).toMatch(/class=\{"legacy .*?" \+ \(cond \? "q_[0-9a-f]{8}" : ""\)\}/);
  });

  it('resolves conditional dynamics to conditional spreads', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        `const base = css({ display: 'flex' });\n` +
          `export const A = () => <div css={[base, cond && { width: w }]} />;`,
      ),
      '/src/m3-cd.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={');
    // 無条件 class + 条件付き parametric class + 条件スプレッド。
    expect(out?.code).toMatch(/class=\{".*?" \+ \(cond \? "q_[0-9a-f]{8}" : ""\)\}/);
    expect(out?.code).toMatch(/style=\{\{ \.\.\.\(cond && \{'--qstyle-[0-9a-f]{6}-0': w\}\) \}\}/);
    const packs: string = packCssOf(p, out?.code ?? '');
    expect(packs).toContain('display:flex');
    expect(packs).toContain('width:var(');
  });

  it('resolves ternary branches with dynamics', () => {
    const p = plugin();
    const out = p.transform(
      withImport(`export const A = () => <div css={ok ? { width: a } : { width: b }} />;`),
      '/src/m3-cd2.tsx',
    );
    expect(out).not.toBeNull();
    // 同一構造は共有され、両枝の値が条件スプレッドで切り替わる。
    expect(out?.code).toMatch(/\(ok \? "q_[0-9a-f]{8}" : ""\)/);
    expect(out?.code).toMatch(/\(!\(ok\) \? "q_[0-9a-f]{8}" : ""\)/);
    expect(out?.code).toContain(`...(ok && {`);
    expect(out?.code).toContain(`...(!(ok) && {`);
  });

  it('merges conditional spreads into an existing style prop', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        `export const A = () => <div style={{ color: 'red' }} css={cond && { width: w }} />;`,
      ),
      '/src/m3-cd3.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).toMatch(/style=\{\{ color: 'red', \.\.\.\(cond && \{'--qstyle-/);
    expect((out?.code.match(/style=\{\{/g) ?? []).length).toBe(1);
  });

  it('leaves conflicting conditional declarations untouched', () => {
    const p = plugin();
    // 同一 part 内の static/dynamic 同一 property。
    expect(
      p.transform(
        withImport(`export const A = () => <div css={cond && { color: 'red', color: w }} />;`),
        '/src/m3-cd4.tsx',
      ),
    ).toBeNull();
    // 条件付き dynamic と無条件 ternary 値の同一 property。
    expect(
      p.transform(
        withImport(
          `export const A = () => <div css={[{ width: k ? 1 : 2 }, cond && { width: w }]} />;`,
        ),
        '/src/m3-cd5.tsx',
      ),
    ).toBeNull();
    // call 式の dynamic は依然として不可。
    expect(
      p.transform(
        withImport(`export const A = () => <div css={cond && { width: get() }} />;`),
        '/src/m3-cd6.tsx',
      ),
    ).toBeNull();
  });

  it('leaves unresolvable conditionals untouched', () => {
    const p = plugin();
    // 未知 handle。
    expect(
      p.transform(
        withImport(`export const A = () => <div css={[base, cond && missing]} />;`),
        '/src/m3-g5.tsx',
      ),
    ).toBeNull();
    // 既存 class={...} 式とは配列ラップで合成する (Qwik ClassList 意味論)。
    expect(
      p.transform(
        withImport(
          `const sel = css({ color: 'red' });\n` +
            `export const A = () => <div class={cls} css={cond && sel} />;`,
        ),
        '/src/m3-g7.tsx',
      )?.code,
    ).toMatch(/class=\{\[cls, \(cond \? "q_[0-9a-f]{8}" : ""\)\]\}/);
  });

  it('leaves unknown identifiers and non-qwik css() untouched', () => {
    const p = plugin();
    // 未登録 identifier。
    expect(
      p.transform(
        withImport(`export const A = () => <div css={missing} />;`),
        '/src/m3-h.tsx',
      ),
    ).toBeNull();
    // @qstyle/qwik import がなければ他 lib の css() として触らない。
    expect(
      p.transform(
        `const base = css({ display: 'flex' });\nexport const A = () => <div css={base} />;`,
        '/src/m3-h2.tsx',
      ),
    ).toBeNull();
  });

  it('reports an actionable reason for cross-module handles (CMP-017 boundary)', () => {
    const errPlugin = qstyle({
      diagnostics: 'error',
      runtimeStyles: { promotion: 'always' },
    }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
    };
    // named import。
    expect(() =>
      errPlugin.transform(
        `import { base } from './styles';\n` +
          `import { css } from '@qstyle/qwik';\n` +
          `export const A = () => <div css={base} />;`,
        '/src/cm-a.tsx',
      ),
    ).toThrow(/imported from '\.\/styles'.*across modules/);
    // namespace import。
    expect(() =>
      errPlugin.transform(
        `import * as s from './styles';\n` +
          `import { css } from '@qstyle/qwik';\n` +
          `export const A = () => <div css={s.base} />;`,
        '/src/cm-b.tsx',
      ),
    ).toThrow(/across modules/);
    // safe mode では untouched のまま。
    const p = plugin();
    expect(
      p.transform(
        `import { base } from './styles';\n` +
          `import { css } from '@qstyle/qwik';\n` +
          `export const A = () => <div css={base} />;`,
        '/src/cm-c.tsx',
      ),
    ).toBeNull();
  });

  it('leaves static/dynamic same-property conflicts untouched', () => {
    const p = plugin();
    expect(
      p.transform(
        withImport(
          `const base = css({ color: 'red' });\n` +
            `export const A = () => <div css={[base, { color: props.color }]} />;`,
        ),
        '/src/m3-i.tsx',
      ),
    ).toBeNull();
  });
});

describe('qstyle static template handles (M4)', () => {
  interface Transformable {
    transform: (code: string, id: string) => { code: string; map: null } | null;
    load: (id: string) => string | null;
  }
  const plugin = (): Transformable => qstyle({ debug: false }) as unknown as Transformable;
  const withImport = (body: string): string => `import { css } from '@qstyle/qwik';\n${body}`;

  function classIds(code: string): string[] {
    const m: RegExpMatchArray | null = /class="([^"]*)"/.exec(code);
    return m === null ? [] : (m[1] ?? '').split(/\s+/).filter(Boolean);
  }

  it('rewrites a static template handle (TPL-001)', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        'const card = css`\n  display: flex;\n  gap: 8px;\n`;\n' +
          'export const A = () => <div css={card} />;',
      ),
      '/src/m4-a.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={card}');
    expect(classIds(out?.code ?? '')).toHaveLength(1);
    const packs: string = packCssOf(p, out?.code ?? '');
    expect(packs).toContain('display:flex');
    expect(packs).toContain('gap:8px');
  });

  it('dedups object and template spellings of the same declarations (TPL-017)', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        `const a = css({ display: 'flex' });\n` +
          'const b = css`display:flex;`;\n' +
          'export const A = () => <div css={[a, b]} />;',
      ),
      '/src/m4-b.tsx',
    );
    expect(out).not.toBeNull();
    expect(classIds(out?.code ?? '')).toHaveLength(1);
  });

  it('rewrites an inline css tag without a handle (static)', () => {
    const p = plugin();
    const out = p.transform(
      withImport('export const A = () => <div css={css`display: flex; gap: 8px;`} />;'),
      '/src/m4-inline-a.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={');
    expect(classIds(out?.code ?? '')).toHaveLength(1);
  });

  it('rewrites an inline css tag with interpolation', () => {
    const p = plugin();
    const out = p.transform(
      withImport('export const A = () => <div css={css`display: flex; width: ${w}px;`} />;'),
      '/src/m4-inline-b.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={');
    // static + parametric も 1 unit に merge。
    expect(classIds(out?.code ?? '')).toHaveLength(1);
    expect(out?.code).toMatch(/'--qstyle-[0-9a-f]{6}-0': w/);
  });

  it('leaves an inline css tag with unsafe interpolation untouched', () => {
    const p = plugin();
    expect(
      p.transform(
        withImport('export const A = () => <div css={css`width: ${get()}px;`} />;'),
        '/src/m4-inline-c.tsx',
      ),
    ).toBeNull();
  });

  it('keeps static declarations of mixed template handles in composition', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        'const m = css`display: flex; width: ${w}px;`;\n' +
          'export const A = () => <div css={[m, { gap: 8 }]} />;',
      ),
      '/src/m4-inline-d.tsx',
    );
    expect(out).not.toBeNull();
    // display:flex + gap:8px + width parametric が 1 unit に merge。
    expect(classIds(out?.code ?? '')).toHaveLength(1);
    const packs: string = packCssOf(p, out?.code ?? '');
    expect(packs).toContain('display:flex');
    expect(packs).toContain('gap:8px');
    expect(packs).toContain('width:var(');
  });

  it('supports pseudo blocks in template handles and cross-kind conflicts', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        'const base = css`\n  color: black;\n  &:hover {\n    color: blue;\n  }\n`;\n' +
          `const sel = css({ color: 'red' });\n` +
          'export const A = () => <div css={[base, sel]} />;',
      ),
      '/src/m4-c.tsx',
    );
    expect(out).not.toBeNull();
    // color:black は sel に上書きされ、hover のみ残る: color:red + hover:blue。
    expect(classIds(out?.code ?? '')).toHaveLength(1);
    const packs: string = packCssOf(p, out?.code ?? '');
    expect(packs).toContain('color:red');
    expect(packs).toContain(':hover');
    expect(packs).not.toContain('color:black');
  });

  it('lowers interpolated templates to parametric slots (M5b end-to-end)', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        'const dyn = css`\n  width: ${w}px;\n`;\n' +
          'export const A = () => <div css={dyn} />;',
      ),
      '/src/m4-d.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={dyn}');
    expect(classIds(out?.code ?? '')).toHaveLength(1);
    const pack: string = packCssOf(p, out?.code ?? '');
    expect(pack).toContain('width:var(--qstyle-');
    expect(out?.code).toMatch(/'--qstyle-[0-9a-f]{6}-0': w/);
  });

  it('shares parametric structure across usages with element-local values', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        'const dyn = css`\n  width: ${w}px;\n`;\n' +
          'export const A = () => <><div css={dyn} /><span css={[dyn]} /></>;',
      ),
      '/src/m4-d2.tsx',
    );
    expect(out).not.toBeNull();
    // 同一構造は同一 unit/class を共有する。
    const ids: string[] = (out?.code.match(/class="[^"]*"/g) ?? []).sort();
    expect(new Set(ids).size).toBe(1);
  });

  it('rejects parametric conflicts that break cascade order', () => {
    const p = plugin();
    // static + parametric の同一 property は順序保証できない。
    expect(
      p.transform(
        withImport(
          `const base = css({ width: '10px' });\n` +
            'const dyn = css`\n  width: ${w}px;\n`;\n' +
            'export const A = () => <div css={[base, dyn]} />;',
        ),
        '/src/m4-e.tsx',
      ),
    ).toBeNull();
    // 構造の異なる parametric 同士の同一 property も同様。
    expect(
      p.transform(
        withImport(
          'const d1 = css`\n  width: ${a}px;\n`;\n' +
            'const d2 = css`\n  width: ${b}%;\n`;\n' +
            'export const A = () => <div css={[d1, d2]} />;',
        ),
        '/src/m4-e2.tsx',
      ),
    ).toBeNull();
    // conditional 値との競合も同様。
    expect(
      p.transform(
        withImport(
          'const dyn = css`\n  width: ${w}px;\n`;\n' +
            'export const A = () => <div css={[dyn, { width: c ? 1 : 2 }]} />;',
        ),
        '/src/m4-e3.tsx',
      ),
    ).toBeNull();
  });

  it('leaves non-slot interpolations unregistered', () => {
    const p = plugin();
    // call 式の補間は slot 化できない。
    expect(
      p.transform(
        withImport(
          'const dyn = css`\n  width: ${get()}px;\n`;\n' +
            'export const A = () => <div css={dyn} />;',
        ),
        '/src/m4-d3.tsx',
      ),
    ).toBeNull();
    // 条件付き parametric は style var の条件分岐が必要なため未対応。
    expect(
      p.transform(
        withImport(
          'const dyn = css`\n  width: ${w}px;\n`;\n' +
            'export const A = () => <div css={cond && dyn} />;',
        ),
        '/src/m4-d4.tsx',
      ),
    ).toBeNull();
  });
});

describe('qstyle finite ternary values (DYN-016)', () => {
  interface Transformable {
    transform: (code: string, id: string) => { code: string; map: null } | null;
    load: (id: string) => string | null;
  }
  const plugin = (): Transformable => qstyle({ debug: false }) as unknown as Transformable;

  it('expands static ternary values to runtime class choice without CSS vars', () => {
    const p = plugin();
    const out = p.transform(
      `export const A = () => <div css={{ display: flag ? 'flex' : 'block' }} />;`,
      '/src/dyn16-a.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={{');
    expect(out?.code).toMatch(/class=\{\(flag \? "q_[0-9a-f]{8}" : "q_[0-9a-f]{8}"\)\}/);
    // CSS variable 化しない (style prop を出さない)。
    expect(out?.code).not.toContain('style={{');
    const packs: string = packCssOf(p, out?.code ?? '');
    expect(packs).toContain('display:flex');
    expect(packs).toContain('display:block');
  });

  it('supports null branches and number values', () => {
    const p = plugin();
    const out = p.transform(
      `export const A = () => <div css={{ opacity: c ? 1 : null, width: k ? 8 : 4 }} />;`,
      '/src/dyn16-b.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).toMatch(/\(c \? "q_[0-9a-f]{8}" : ""\)/);
    const packs: string = packCssOf(p, out?.code ?? '');
    expect(packs).toContain('opacity:1');
    expect(packs).toContain('width:8px');
    expect(packs).toContain('width:4px');
  });

  it('leaves static/conditional same-property conflicts untouched', () => {
    const p = plugin();
    // 同一 property の static + conditional は cascade 順を保証できない。
    expect(
      p.transform(
        `export const A = () => <div css={{ color: 'black', color: flag ? 'red' : 'gray' }} />;`,
        '/src/dyn16-c.tsx',
      ),
    ).toBeNull();
    // dynamic との競合も同様。
    expect(
      p.transform(
        `export const A = () => <div css={{ color: props.c, color: k ? 'red' : 'gray' }} />;`,
        '/src/dyn16-c2.tsx',
      ),
    ).toBeNull();
  });
});

describe('qstyle legacy hooks coexistence (§24)', () => {
  it('tracks useStyles/useStylesScoped provenance without rewriting', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
      readonly __legacyStyles: readonly {
        module: string;
        hook: string;
        local: string;
        cssPath: string | null;
      }[];
    };
    const code = [
      `import { component$ } from '@qwik.dev/core';`,
      `import legacy from './button.css?inline';`,
      `import { css } from '@qstyle/qwik';`,
      `const base = css({ display: 'flex' });`,
      `export const Button = component$(() => {`,
      `  useStylesScoped$(legacy);`,
      `  return <button class="button" css={base}>OK</button>;`,
      `});`,
    ].join('\n');
    const out = p.transform(code, '/src/button.tsx');
    // css prop は通常通り rewrite される。
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={base}');
    // legacy hook は untouched のまま provenance のみ記録される。
    expect(out?.code).toContain('useStylesScoped$(legacy)');
    expect(p.__legacyStyles).toEqual([
      { module: '/src/button.tsx', hook: 'scoped', local: 'legacy', cssPath: './button.css?inline' },
    ]);
    // 冪等: 同一 module の再 transform で重複しない。
    p.transform(code, '/src/button.tsx');
    expect(p.__legacyStyles).toHaveLength(1);
  });

  it('records global hooks and unresolvable css paths', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
      readonly __legacyStyles: readonly { hook: string; local: string; cssPath: string | null }[];
    };
    expect(
      p.transform(`export const A = () => { useStyles$(theme); return <div />; };`, '/src/a.tsx'),
    ).toBeNull();
    expect(p.__legacyStyles).toEqual([{ module: '/src/a.tsx', hook: 'global', local: 'theme', cssPath: null }]);
  });
});

describe('qstyle compound template values (§23/DYN-006)', () => {
  interface Transformable {
    transform: (code: string, id: string) => { code: string; map: null } | null;
    load: (id: string) => string | null;
  }
  // parametric 機構の検証のため promotion:'always' を明示する。
  const plugin = (): Transformable =>
    qstyle({ debug: false, runtimeStyles: { promotion: 'always' } }) as unknown as Transformable;

  function classIds(code: string): string[] {
    const m: RegExpMatchArray | null = /class="([^"]*)"/.exec(code);
    return m === null ? [] : (m[1] ?? '').split(/\s+/).filter(Boolean);
  }

  it('lowers a single-slot template value to a parametric class (DYN-006)', () => {
    const p = plugin();
    const out = p.transform(
      'export const A = () => <div css={{ transform: `translateX(${x.value}px)` }} />;',
      '/src/cmp-a.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={{');
    expect(out?.code).toMatch(/class="q_[0-9a-f]{8}"/);
    const id: string = (out?.code.match(/q_[0-9a-f]{8}/) ?? [])[0] ?? '';
    const pack: string = p.load(`virtual:qstyle/pack/${id}`) ?? '';
    expect(pack).toMatch(/transform:translateX\(var\(--qstyle-[0-9a-f]{6}-0\)px\)/);
    expect(out?.code).toMatch(/'--qstyle-[0-9a-f]{6}-0': x\.value/);
  });

  it('splits multi-slot values into independent slots (DYN-007)', () => {
    const p = plugin();
    const out = p.transform(
      'export const A = () => <div css={{ transform: `translate(${x}px, ${y}px) scale(${s})` }} />;',
      '/src/cmp-b.tsx',
    );
    expect(out).not.toBeNull();
    // 3 slots に対して 1 class。
    expect((out?.code.match(/class="q_[0-9a-f]{8}"/) ?? []).length).toBe(1);
    expect(out?.code).toContain(`'--qstyle-`);
    const vars: string[] = [...(out?.code.matchAll(/'--qstyle-[0-9a-f]{6}-\d+'/g) ?? [])].map(
      (m) => m[0],
    );
    expect(new Set(vars).size).toBe(3);
  });

  it('resolves inline compounds inside composition arrays', () => {
    const p = plugin();
    const out = p.transform(
      `import { css } from '@qstyle/qwik';\n` +
        `const base = css({ display: 'flex' });\n` +
        'export const A = () => <div css={[base, { transform: `translateX(${x}px)` }]} />;',
      '/src/cmp-d.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={');
    // static + parametric が 1 unit に merge。
    expect(classIds(out?.code ?? '')).toHaveLength(1);
    expect(out?.code).toMatch(/'--qstyle-[0-9a-f]{6}-0': x/);
  });

  it('leaves same-property conflicts untouched', () => {    const p = plugin();
    // static + compound の同一 property は cascade 順を保証できない。
    expect(
      p.transform(
        'export const A = () => <div css={{ transform: `none`, width: `1${u}` }} />;',
        '/src/cmp-c.tsx',
      ),
    ).not.toBeNull();
    expect(
      p.transform(
        'export const A = () => <div css={{ width: `10px`, width: `1${u}` }} />;',
        '/src/cmp-c2.tsx',
      ),
    ).toBeNull();
    // dynamic と compound の同一 property も同様。
    expect(
      p.transform(
        'export const A = () => <div css={{ width: props.w, width: `1${u}` }} />;',
        '/src/cmp-c3.tsx',
      ),
    ).toBeNull();
  });
});

describe('qstyle scale bounds (PERF-001/003 unit)', () => {
  interface Transformable {
    transform: (code: string, id: string) => { code: string; map: null } | null;
    load: (id: string) => string | null;
  }

  it('dedups 100 identical static styles to one atom', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as Transformable;
    for (let i = 0; i < 100; i += 1) {
      const out = p.transform(
        `export const A${i} = () => <div css={{ display: 'flex', gap: 8 }} />;`,
        `/src/scale-${i}.tsx`,
      );
      expect(out).not.toBeNull();
    }
    const registry: string = p.load('virtual:qstyle/registry') ?? '';
    // 1 unit (display:flex;gap:8px) のみ。occurrence 比例しない。
    expect(registry.split('\n').filter((line) => line.includes('q_'))).toHaveLength(1);
  });

  it('shares one parametric structure across 1000 dynamic widths', () => {
    const p = qstyle({
      diagnostics: 'silent',
      runtimeStyles: { promotion: 'always' },
    }) as unknown as Transformable;
    for (let i = 0; i < 1000; i += 1) {
      const out = p.transform(
        `export const A${i} = () => <div css={{ width: props.w${i} }} />;`,
        `/src/wscale-${i}.tsx`,
      );
      expect(out).not.toBeNull();
    }
    const registry: string = p.load('virtual:qstyle/registry') ?? '';
    expect(registry.split('\n').filter((line) => line.includes('q_'))).toHaveLength(1);
  });

  it('keeps singleton dynamics inline under default cost-based promotion', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as Transformable;
    const out = p.transform(
      `export const A = () => <div css={{ display: 'flex', width: props.w }} />;`,
      '/src/cb-single.tsx',
    );
    expect(out).not.toBeNull();
    // width は inline のまま (class なし、var なし)。
    expect(out?.code).toContain(`'width': props.w`);
    expect(out?.code).not.toContain('--qstyle-');
    const registry: string = p.load('virtual:qstyle/registry') ?? '';
    expect(registry).toContain('display');
    expect(registry).not.toContain('width');
  });
});

describe('qstyle promotion modes (§32)', () => {
  interface Transformable {
    transform: (code: string, id: string) => { code: string; map: null } | null;
    load: (id: string) => string | null;
  }
  const never = (): Transformable =>
    qstyle({
      diagnostics: 'silent',
      runtimeStyles: { promotion: 'never' },
    }) as unknown as Transformable;

  it('inlines dynamics without classes in never mode', () => {
    const p = never();
    const out = p.transform(
      `export const A = () => <div css={{ display: 'flex', width: props.w }} />;`,
      '/src/pm-a.tsx',
    );
    expect(out).not.toBeNull();
    // display の class のみ。width は生の inline。
    expect(out?.code).toMatch(/class="q_[0-9a-f]{8}"/);
    expect(out?.code).toContain(`'width': props.w`);
    expect(out?.code).not.toContain('--qstyle-');
    // pack import は static (display) の 1 件のみ。
    expect((out?.code.match(/virtual:qstyle\/pack\/q_/g) ?? []).length).toBe(1);
  });

  it('emits no class or import for pure-dynamic props in never mode', () => {
    const p = never();
    const out = p.transform(
      `export const A = () => <div css={{ width: props.w }} />;`,
      '/src/pm-b.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('class=');
    expect(out?.code).toContain('style={{');
    expect(out?.code).not.toContain('virtual:qstyle');
  });

  it('inlines compound values as template literals in never mode', () => {
    const p = never();
    const out = p.transform(
      'export const A = () => <div css={{ transform: `translateX(${x}px)` }} />;',
      '/src/pm-c.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).toContain(`'transform': \`translateX(\${x}px)\``);
    expect(out?.code).not.toContain('--qstyle-');
  });

  it('leaves context-bound template handles untouched in never mode', () => {
    const p = never();
    expect(
      p.transform(
        `import { css } from '@qstyle/qwik';\n` +
          'const dyn = css`\n  &:hover {\n    color: ${c};\n  }\n`;\n' +
          'export const A = () => <div css={dyn} />;',
        '/src/pm-d.tsx',
      ),
    ).toBeNull();
  });

  it('promotes module-shared structures under default cost-based', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as Transformable;
    const out = p.transform(
      `export const A = () => <div css={{ display: 'flex', width: props.a }} />;\n` +
        `export const B = () => <div css={{ display: 'block', width: props.b }} />;`,
      '/src/cb-ab.tsx',
    );
    expect(out).not.toBeNull();
    // width 構造が同一 module 内で 2 回出現するため両方とも class 化される。
    expect(out?.code).toMatch(/'--qstyle-[0-9a-f]{6}-0': props\.a/);
    expect(out?.code).toMatch(/'--qstyle-[0-9a-f]{6}-0': props\.b/);
    const registry: string = p.load('virtual:qstyle/registry') ?? '';
    expect(registry).toContain('display');
    expect(registry).toContain('width');
  });
});

describe('qstyle route-loader virtual module (css-asset)', () => {
  it('serves a loader that fetches the manifest and injects links', () => {
    const p = qstyle({ backend: 'css-asset', diagnostics: 'silent' }) as unknown as {
      load: (id: string) => string | null;
    };
    const code: string | null = p.load('virtual:qstyle/route-loader');
    expect(code).not.toBeNull();
    expect(code).toContain('loadRouteStyles');
    expect(code).toContain('qstyle.routes.json');
    expect(code).toContain('resolveRouteAssets');
    expect(code).toContain('rel');
    expect(code).toContain('stylesheet');
  });
});

describe('qstyle source maps (VLQ + edit tracking)', () => {
  interface Transformable {
    transform: (
      code: string,
      id: string,
    ) => { code: string; map: import('./index.js').QstyleSourceMap } | null;
    load: (id: string) => string | null;
  }

  /** テスト用 VLQ デコーダ (1 セグメント = [genCol, srcIdx, srcLine, srcCol])。 */
  function decodeSegment(segment: string): number[] {
    const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const values: number[] = [];
    let current = 0;
    let shift = 0;
    for (const ch of segment) {
      const digit: number = BASE64.indexOf(ch);
      current |= (digit & 31) << shift;
      if ((digit & 32) === 0) {
        const negative: boolean = (current & 1) === 1;
        const value: number = current >> 1;
        values.push(negative ? -value : value);
        current = 0;
        shift = 0;
      } else {
        shift += 5;
      }
    }
    return values;
  }

  function decodeMappings(mappings: string): number[][][] {
    return mappings.split(';').map((line) =>
      line === '' ? [] : line.split(',').map((segment) => decodeSegment(segment)),
    );
  }

  /** mapping から各出力行の絶対 source 行を取り出す (1 行 1 セグメント前提で delta 累積)。 */
  function absoluteSrcLines(mappings: string): number[] {
    let srcLine = 0;
    return decodeMappings(mappings).map((segments) => {
      srcLine += segments[0]?.[2] ?? 0;
      return srcLine;
    });
  }

  it('encodes known VLQ vectors', async () => {
    const { encodeVlq } = await import('./index.js');
    expect(encodeVlq(0)).toBe('A');
    expect(encodeVlq(1)).toBe('C');
    expect(encodeVlq(-1)).toBe('D');
    expect(encodeVlq(16)).toBe('gB');
    // round-trip
    for (const value of [0, 1, -1, 15, 16, -16, 100, -1000, 123456]) {
      expect(decodeSegment(encodeVlq(value))).toEqual([value]);
    }
  });

  it('applies edits with precise gap mappings', async () => {
    const { applyEditsWithMap } = await import('./index.js');
    const original: string = 'line0\nline1\nline2\n';
    const { code, map } = applyEditsWithMap(original, '/src/a.tsx', [
      { start: 6, end: 11, newText: 'CHANGED', srcLine: 1 },
    ]);
    expect(code).toBe('line0\nCHANGED\nline2\n');
    expect(map.version).toBe(3);
    expect(map.sources).toEqual(['/src/a.tsx']);
    expect(map.sourcesContent).toEqual([original]);
    const decoded = absoluteSrcLines(map.mappings);
    expect(decoded.length).toBe(4);
    // gap 行は同一行、編集行は srcLine を指す (末尾空行は最終行)。
    expect(decoded.slice(0, 3)).toEqual([0, 1, 2]);
  });

  it('maps generated class attributes to the original css prop line', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as Transformable;
    const code = [
      `export const A = () => (`,
      `  <div`,
      `    css={{ display: 'flex' }}>`,
      `    hello`,
      `  </div>`,
      `);`,
    ].join('\n');
    const out = p.transform(code, '/src/map-a.tsx');
    expect(out).not.toBeNull();
    const map = out?.map;
    expect(map).toBeDefined();
    expect(map?.sources).toEqual(['/src/map-a.tsx']);
    expect(map?.sourcesContent).toEqual([code]);
    const outLines: string[] = (out?.code ?? '').split('\n');
    const decoded = absoluteSrcLines(map?.mappings ?? '');
    // 出力行数と mapping 行数が一致する。
    expect(decoded.length).toBe(outLines.length);
    // class を含む出力行は css prop のあった 2 行目 (0-based) を指す。
    const classLine: number = outLines.findIndex((line) => line.includes('class="q_'));
    expect(classLine).toBeGreaterThanOrEqual(0);
    expect(decoded[classLine]).toBe(2);
    // header import 行は先頭行を指す。
    expect(decoded[0]).toBe(0);
  });
});

describe('qstyle dev mode + CSS HMR', () => {
  interface Transformable {
    transform: (
      code: string,
      id: string,
    ) => { code: string; map: import('./index.js').QstyleSourceMap } | null;
    load: (id: string) => string | null;
  }
  interface DevPlugin extends Transformable {
    configResolved: (config: { command: string; mode: string }) => void;
    handleHotUpdate: (ctx: {
      file: string;
      server: {
        moduleGraph: {
          getModuleById: (id: string) => { id: string } | undefined;
          invalidateModule: (mod: unknown) => void;
        };
      };
    }) => void;
  }
  const devPlugin = (): DevPlugin => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as DevPlugin;
    p.configResolved({ command: 'serve', mode: 'development' });
    return p;
  };

  function devCssOf(p: DevPlugin, outCode: string): string {
    const key: string = (outCode.match(/virtual:qstyle\/dev\/([\w.]+)/) ?? [])[1] ?? '';
    expect(key).not.toBe('');
    return p.load(`virtual:qstyle/dev/${key}`) ?? '';
  }

  it('emits per-module css imports instead of pack imports in dev', () => {
    const p = devPlugin();
    const out = p.transform(
      `export const A = () => <div css={{ display: 'flex', gap: 8 }} />;`,
      '/src/dev-a.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).toContain('virtual:qstyle/dev/');
    expect(out?.code).not.toContain('virtual:qstyle/pack/');
    expect(out?.map).toBeDefined();
    const css: string = devCssOf(p, out?.code ?? '');
    expect(css).toContain('display:flex');
    expect(css).toContain('gap:8px');
  });

  it('recomputes module css on re-transform without stale rules', () => {
    const p = devPlugin();
    const v1 = p.transform(
      `export const A = () => <div css={{ display: 'flex' }} />;`,
      '/src/dev-b.tsx',
    );
    expect(devCssOf(p, v1?.code ?? '')).toContain('display:flex');
    const v2 = p.transform(
      `export const A = () => <div css={{ display: 'block' }} />;`,
      '/src/dev-b.tsx',
    );
    expect(v2).not.toBeNull();
    const css: string = devCssOf(p, v2?.code ?? '');
    expect(css).toContain('display:block');
    expect(css).not.toContain('display:flex');
  });

  it('keeps source order in dev css without chunking', () => {
    const p = devPlugin();
    const out = p.transform(
      `export const A = () => <><div css={{ color: 'red' }} /><div css={{ color: 'blue' }} /></>;`,
      '/src/dev-c.tsx',
    );
    expect(out).not.toBeNull();
    const css: string = devCssOf(p, out?.code ?? '');
    expect(css.indexOf('color:red')).toBeLessThan(css.indexOf('color:blue'));
  });

  it('invalidates the virtual css module on hot update of transformed files', () => {
    const p = devPlugin();
    const out = p.transform(
      `export const A = () => <div css={{ display: 'flex' }} />;`,
      '/src/dev-d.tsx',
    );
    expect(out).not.toBeNull();
    const invalidated: unknown[] = [];
    const requested: string[] = [];
    const server = {
      moduleGraph: {
        getModuleById: (id: string): { id: string } | undefined => {
          requested.push(id);
          return { id };
        },
        invalidateModule: (mod: unknown): void => {
          invalidated.push(mod);
        },
      },
    };
    p.handleHotUpdate({ file: '/src/dev-d.tsx', server });
    expect(requested.length).toBe(1);
    expect(requested[0]?.startsWith('\0virtual:qstyle/dev/')).toBe(true);
    expect(requested[0]?.endsWith('.css')).toBe(true);
    expect(invalidated.length).toBe(1);
  });

  it('ignores unrelated files in handleHotUpdate', () => {
    const p = devPlugin();
    let requested = 0;
    const server = {
      moduleGraph: {
        getModuleById: (): { id: string } | undefined => {
          requested += 1;
          return undefined;
        },
        invalidateModule: (): void => {},
      },
    };
    p.handleHotUpdate({ file: '/src/unrelated.ts', server });
    expect(requested).toBe(0);
  });
});

describe('qstyle residual log (DIA-003)', () => {
  it('collects residual reasons for unsafe selectors', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
      load: (id: string) => string | null;
      readonly __residuals: readonly { reason: string; cssText: string }[];
    };
    expect(
      p.transform(`export const A = () => <div css={{ '& > svg': { width: 16 } }} />;`, '/src/r.tsx'),
    ).toBeNull();
    expect(p.__residuals.length).toBeGreaterThan(0);
    expect(p.__residuals[0]?.reason).toBe('unsupported-selector');
    const virtual: string | null = p.load('virtual:qstyle/residuals');
    expect(virtual).toContain('unsupported-selector');
  });
});

describe('qstyle options validation + diagnostics', () => {
  it('rejects unknown option values with actionable errors (FLB-006)', () => {
    expect(() => qstyle({ optimization: 'bogus' as never })).toThrow(/unknown optimization/);
    expect(() => qstyle({ backend: 'x' as never })).toThrow(/unknown backend/);
    expect(() => qstyle({ diagnostics: 'y' as never })).toThrow(/unknown diagnostics/);
    expect(() => qstyle({ runtimeStyles: { promotion: 'z' as never } })).toThrow(
      /unknown runtimeStyles.promotion/,
    );
    expect(() => qstyle({ composition: { falsy: 'drop' as never } })).toThrow(
      /unknown composition.falsy/,
    );
    expect(() => qstyle({ chunking: { strategy: 'x' as never } })).toThrow(
      /unknown chunking.strategy/,
    );
  });

  it('emits one class per occurrence without atomicization in preserve mode', () => {
    const p = qstyle({
      optimization: 'preserve',
      diagnostics: 'silent',
      runtimeStyles: { promotion: 'always' },
    }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
      load: (id: string) => string | null;
    };
    const out = p.transform(
      `export const A = () => <div css={{ display: 'flex', gap: 8, color: 'red' }} />;`,
      '/src/pv-a.tsx',
    );
    expect(out).not.toBeNull();
    // 分割せず 1 class。宣言順を維持する。
    const ids: string[] = (out?.code.match(/class="([^"]*)"/) ?? [])[1]?.split(/\s+/) ?? [];
    expect(ids).toHaveLength(1);
    expect(ids[0]?.startsWith('p_')).toBe(true);
    const pack: string = packCssOf(p, out?.code ?? '');
    expect(pack).toContain(`.${ids[0]}{display:flex;gap:8px;color:red}`);
  });

  it('dedups identical blocks and groups contexts in preserve mode', () => {
    const p = qstyle({
      optimization: 'preserve',
      diagnostics: 'silent',
      runtimeStyles: { promotion: 'always' },
    }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
      load: (id: string) => string | null;
    };
    const code = `export const A = () => <div css={{ display: 'flex', '&:hover': { color: 'blue' } }} />;`;
    const first = p.transform(code, '/src/pv-b1.tsx');
    const second = p.transform(code, '/src/pv-b2.tsx');
    const id1: string = (first?.code.match(/class="([^"]*)"/) ?? [])[1] ?? '';
    const id2: string = (second?.code.match(/class="([^"]*)"/) ?? [])[1] ?? '';
    // 同一 block は同一 class (exact dedup)。
    expect(id1).toBe(id2);
    const pack: string = packCssOf(p, first?.code ?? '');
    expect(pack).toContain(`.${id1}{display:flex}`);
    expect(pack).toContain(`.${id1}:hover{color:blue}`);
  });

  it('keeps dynamic values as var refs inside preserve blocks', () => {
    const p = qstyle({
      optimization: 'preserve',
      diagnostics: 'silent',
      runtimeStyles: { promotion: 'always' },
    }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
      load: (id: string) => string | null;
    };
    const out = p.transform(
      `export const A = () => <div css={{ display: 'flex', width: props.w }} />;`,
      '/src/pv-c.tsx',
    );
    expect(out).not.toBeNull();
    const id: string = (out?.code.match(/class="([^"]*)"/) ?? [])[1] ?? '';
    const pack: string = packCssOf(p, out?.code ?? '');
    expect(pack).toMatch(new RegExp(`\\.${id}\\{display:flex;width:var\\(--qstyle-`));
    expect(out?.code).toMatch(/'--qstyle-[0-9a-f]{6}-0': props\.w/);
  });

  it('leaves order-sensitive declarations untouched in preserve mode', () => {
    const p = qstyle({
      optimization: 'preserve',
      diagnostics: 'silent',
      runtimeStyles: { promotion: 'always' },
    }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
    };
    // static margin + dynamic marginLeft は順序依存のため untouched。
    expect(
      p.transform(`export const A = () => <div css={{ margin: 0, marginLeft: w }} />;`, '/src/pv-d.tsx'),
    ).toBeNull();
    // 順序無関係な組は通る。
    expect(
      p.transform(`export const A = () => <div css={{ display: 'flex', width: w }} />;`, '/src/pv-d2.tsx'),
    ).not.toBeNull();
  });

  it('concatenates composition in author order in preserve mode', () => {
    const p = qstyle({
      optimization: 'preserve',
      diagnostics: 'silent',
      runtimeStyles: { promotion: 'always' },
    }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
      load: (id: string) => string | null;
    };
    const out = p.transform(
      `import { css } from '@qstyle/qwik';\n` +
        `const base = css({ display: 'flex' });\n` +
        `export const A = () => <div css={[base, { gap: 8 }]} />;`,
      '/src/pv-e.tsx',
    );
    expect(out).not.toBeNull();
    const id: string = (out?.code.match(/class="([^"]*)"/) ?? [])[1] ?? '';
    const pack: string = packCssOf(p, out?.code ?? '');
    expect(pack).toContain(`.${id}{display:flex;gap:8px}`);
  });

  it('strict mode turns untouched occurrences into compile errors (§61)', () => {
    const p = qstyle({ optimization: 'strict' }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
    };
    expect(() =>
      p.transform(`export const A = () => <div css={{ ...base }} />;`, '/src/s.tsx'),
    ).toThrow(/\[qstyle\]/);
  });

  it('diagnostics error mode throws, silent mode stays quiet (DIA-008)', () => {
    const errPlugin = qstyle({ diagnostics: 'error' }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
    };
    expect(() =>
      errPlugin.transform(`export const A = () => <div css={{ ...base }} />;`, '/src/e.tsx'),
    ).toThrow(/\[qstyle\]/);
    const silent = qstyle({ diagnostics: 'silent' }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
    };
    expect(
      silent.transform(`export const A = () => <div css={{ ...base }} />;`, '/src/e2.tsx'),
    ).toBeNull();
  });

  it('warns once per module × reason across re-transforms (DIA-009)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const p = qstyle({ diagnostics: 'warning' }) as unknown as {
        transform: (code: string, id: string) => { code: string; map: null } | null;
      };
      const code = `export const A = () => <div css={{ ...base }} />;`;
      expect(p.transform(code, '/src/dia009.tsx')).toBeNull();
      expect(p.transform(code, '/src/dia009.tsx')).toBeNull();
      // 同一 module × 同一理由は 1 回だけ。
      expect(spy).toHaveBeenCalledTimes(1);
      // 別 module は別途警告される。
      expect(p.transform(code, '/src/dia009b.tsx')).toBeNull();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('unsupported dynamic property names a reason (DIA-001)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const p = qstyle({ diagnostics: 'warning' }) as unknown as {
        transform: (code: string, id: string) => { code: string; map: null } | null;
      };
      expect(
        p.transform(
          `export const A = () => <div css={{ 'not a prop!': dynamicValue }} />;`,
          '/src/dia001.tsx',
        ),
      ).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      const message: string = String(spy.mock.calls[0]?.[0] ?? '');
      expect(message).toContain('/src/dia001.tsx');
      expect(message).toContain('unsupported dynamic property');
    } finally {
      spy.mockRestore();
    }
  });

  it('unsupported selectors name a reason (DIA-002)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const p = qstyle({ diagnostics: 'warning' }) as unknown as {
        transform: (code: string, id: string) => { code: string; map: null } | null;
      };
      expect(
        p.transform(
          `export const A = () => <div css={{ '& > div': { color: 'red' } }} />;`,
          '/src/dia002.tsx',
        ),
      ).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0] ?? '')).toContain('/src/dia002.tsx');
    } finally {
      spy.mockRestore();
    }
  });

  it('malformed template CSS names a reason (DIA-004)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const p = qstyle({ diagnostics: 'warning' }) as unknown as {
        transform: (code: string, id: string) => { code: string; map: null } | null;
      };
      expect(
        p.transform(
          `import { css } from '@qstyle/qwik';\nconst broken = css\`color: red; { oops\`;\nexport const A = () => <div css={broken} />;`,
          '/src/dia004.tsx',
        ),
      ).toBeNull();
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      expect(String(spy.mock.calls[0]?.[0] ?? '')).toContain('/src/dia004.tsx');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('qstyle generateBundle wiring', () => {
  it('emits deterministic manifests + pack css (HASH-001)', () => {
    interface Emitted {
      readonly fileName: string;
      readonly source: string;
    }
    const runOnce = (): { emitted: string[]; packCss: string } => {
      const p = qstyle({ routes: { '/': ['/src/a.tsx'] } }) as unknown as {
        buildStart: () => void;
        transform: (code: string, id: string) => { code: string; map: null } | null;
        generateBundle: (this: { emitFile: (f: { fileName: string; source: string }) => void }) => void;
        load: (id: string) => string | null;
      };
      const emitted: Emitted[] = [];
      p.buildStart();
      const out = p.transform(
        `export const A = () => <div css={{ display: 'flex' }} />;`,
        '/src/a.tsx',
      );
      p.generateBundle.call({ emitFile: (f) => emitted.push(f) });
      const packCss: string = packCssOf(p, out?.code ?? '');
      return { emitted: emitted.map((e) => `${e.fileName}:${e.source.length}`).sort(), packCss };
    };
    const first = runOnce();
    const second = runOnce();
    // 同一入力で byte-for-byte 同一 (HASH-001 の配線側)。
    expect(second.emitted).toEqual(first.emitted);
    expect(second.packCss).toBe(first.packCss);
    // CSS asset は pack css module 経由で vite 側が出す (直接 emit しない)。
    expect(first.packCss).toMatch(/\.q_[0-9a-f]{8}\{display:flex\}/);
    expect(first.emitted.some((e) => e.startsWith('qstyle.routes.json'))).toBe(true);
    expect(first.emitted.some((e) => e.startsWith('qstyle-manifest.json'))).toBe(true);
  });

  it('records provenance sources for deduped atoms across modules', async () => {
    const { sourceSignature } = await import('@qstyle/core');
    const p = qstyle({}) as unknown as {
      buildStart: () => void;
      transform: (code: string, id: string) => { code: string; map: null } | null;
      readonly __usageGraph: { styleToComponents: Map<string, Set<string>> };
    };
    p.buildStart();
    const code = `export const A = () => <div css={{ display: 'flex' }} />;`;
    const outA = p.transform(code, '/src/a.tsx');
    const outB = p.transform(code, '/src/b.tsx');
    expect(outA).not.toBeNull();
    expect(outB).not.toBeNull();
    // ponytail: graph 経由の最小チェック。同一 atom が両 module の origins を持つ。
    // §4.1 修正後は unit id も styleToComponents に載るため、provenance (§58) の
    // 対象は styleToSources の key (member atom のみ recordSource される) に絞る。
    const graph = p.__usageGraph as unknown as Parameters<typeof sourceSignature>[0];
    const atomIds = [...graph.styleToSources.keys()].filter((k) => k.startsWith('q_'));
    expect(atomIds.length).toBeGreaterThan(0);
    for (const atomId of atomIds) {
      expect(sourceSignature(graph, atomId).slice().sort()).toEqual(['/src/a.tsx', '/src/b.tsx']);
    }
  });
});

describe('qstyle css-asset backend (plan.md §3.4 R1.1-R1.3/R1.6)', () => {
  interface Emitted {
    readonly fileName: string;
    readonly source: string;
  }

  /** qstyle() の戻り配列から名前で plugin を取り出す。同一 instance の plugin 群は
   * closure 状態 (collected / graph / unit tags) を共有するため、必ず同じ戻り値から取る。 */
  const pluginsOf = (
    options: Parameters<typeof qstyleFactory>[0],
    ...names: readonly string[]
  ): Record<string, unknown>[] => {
    const plugins = qstyleFactory(options) as unknown as readonly Record<string, unknown>[];
    const found: Record<string, unknown>[] = [];
    for (const name of names) {
      const plugin: Record<string, unknown> | undefined = plugins.find(
        (p) => p['name'] === name,
      );
      if (plugin === undefined) throw new Error(`plugin ${name} not found`);
      found.push(plugin);
    }
    return found;
  };

  /** noUncheckedIndexedAccess 下の取り出し用 (見つからなければ test 失敗)。 */
  const req = (p: Record<string, unknown> | undefined): Record<string, unknown> => {
    if (p === undefined) throw new Error('plugin not found');
    return p;
  };

  /** build 相当の配線: buildStart -> transforms -> main/cssAsset の generateBundle。 */
  const buildOnce = (
    options: Parameters<typeof qstyleFactory>[0],
    modules: readonly { readonly id: string; readonly code: string }[],
  ): { emitted: Emitted[]; codes: string[] } => {
    // main と cssAsset は同一 qstyle() instance から取る (closure 状態の共有)。
    const plugins: Record<string, unknown>[] = pluginsOf(options, 'qstyle', 'qstyle:css-asset');
    const main: Record<string, unknown> = req(plugins[0]);
    const cssAsset: Record<string, unknown> = req(plugins[1]);
    const buildStart = main['buildStart'] as () => void;
    const transform = main['transform'] as (
      code: string,
      id: string,
    ) => { code: string } | null;
    const mainGenerate = main['generateBundle'] as (
      this: { emitFile: (f: Emitted) => void },
    ) => void;
    const cssGenerate = cssAsset['generateBundle'] as (
      this: { emitFile: (f: Emitted) => void },
    ) => void;
    buildStart();
    const emitted: Emitted[] = [];
    const emit = (f: Emitted): void => {
      emitted.push(f);
    };
    const codes: string[] = [];
    for (const mod of modules) {
      const out = transform(mod.code, mod.id);
      codes.push(out?.code ?? '');
    }
    mainGenerate.call({ emitFile: emit });
    cssGenerate.call({ emitFile: emit });
    return { emitted, codes };
  };

  it('injects ensureModuleStyles(unit ids) instead of pack css import (R1.6)', () => {
    const main: Record<string, unknown> = req(pluginsOf({ backend: 'css-asset' }, 'qstyle')[0]);
    const transform = main['transform'] as (
      code: string,
      id: string,
    ) => { code: string } | null;
    const out = transform(
      `export const A = () => <div css={{ display: 'flex' }} />;`,
      '/src/ca-a.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).toContain(`import { ensureModuleStyles } from '@qstyle/qwik/client';`);
    expect(out?.code).toMatch(/^ensureModuleStyles\(\["q_[0-9a-f]{8}"\]\);/m);
    expect(out?.code).not.toContain('virtual:qstyle/pack/');
  });

  it('keeps the dev pipeline under css-asset (serve は backend によらず現状維持)', () => {
    const main: Record<string, unknown> = req(
      pluginsOf({ backend: 'css-asset', diagnostics: 'silent' }, 'qstyle')[0],
    );
    const configResolved = main['configResolved'] as (config: {
      command: string;
      mode: string;
    }) => void;
    configResolved({ command: 'serve', mode: 'development' });
    const transform = main['transform'] as (
      code: string,
      id: string,
    ) => { code: string } | null;
    const out = transform(
      `export const A = () => <div css={{ display: 'flex' }} />;`,
      '/src/ca-dev.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).toContain('virtual:qstyle/dev/');
    expect(out?.code).not.toContain('ensureModuleStyles');
  });

  it('emits hashed css assets + qstyle.units.json deterministically (R1.1/R1.2)', () => {
    const modules = [
      { id: '/src/ca-a.tsx', code: `export const A = () => <div css={{ display: 'flex' }} />;` },
      {
        id: '/src/ca-b.tsx',
        code: `export const B = () => <div css={{ display: 'flex', gap: 8 }} />;`,
      },
    ];
    const first = buildOnce({ backend: 'css-asset' }, modules);
    const second = buildOnce({ backend: 'css-asset' }, modules);
    const sig = (run: { emitted: Emitted[] }): string[] =>
      run.emitted.map((e) => `${e.fileName}:${e.source}`).sort();
    // HASH-001 (css-asset 版): 同一入力で byte-for-byte 同一。
    expect(sig(second)).toEqual(sig(first));

    const cssAssets: Emitted[] = first.emitted.filter(
      (e) => /^assets\/qstyle\.q_[0-9a-f]+\.css$/.test(e.fileName),
    );
    expect(cssAssets.length).toBeGreaterThan(0);
    const cssText: string = cssAssets.map((e) => e.source).join('\n');
    // §4.1 修正後: 異なる module の unit は usage signature が異なるため別 chunk になる
    // (chunk 内 dedup も chunk 単位)。内容の存在のみ検証する。
    expect(cssText).toMatch(/\.q_[0-9a-f]{8}\{display:flex/);
    expect(cssText).toMatch(/gap:8px/);

    // units index: 各 unit は恰好 1 chunk (fileName) に属し、実在 asset を指す。
    const unitsAsset: Emitted | undefined = first.emitted.find(
      (e) => e.fileName === 'qstyle.units.json',
    );
    expect(unitsAsset).toBeDefined();
    const units: Record<string, string[]> = (
      JSON.parse(unitsAsset?.source ?? '{}') as { units: Record<string, string[]> }
    ).units;
    expect(Object.keys(units)).toHaveLength(2);
    for (const fileNames of Object.values(units)) {
      expect(fileNames).toHaveLength(1);
      expect(first.emitted.map((e) => e.fileName)).toContain(fileNames[0]);
    }
    // qwik-native 由来の emit は残る (manifest 2 件)。
    expect(
      first.emitted.filter((e) => e.fileName === 'qstyle.routes.json' || e.fileName === 'qstyle-manifest.json'),
    ).toHaveLength(2);
  });

  it('applies §39 v1 dedup inside a chunk before hashing (R1.2)', () => {
    // 同一 module 内の 2 css prop は usage signature が一致するため同一 chunk になる。
    const code = `export const M = () => (<section><div css={{ display: 'flex' }} /><div css={{ display: 'flex', gap: 8 }} /></section>);`;
    const { emitted } = buildOnce({ backend: 'css-asset' }, [
      { id: '/src/ca-m.tsx', code },
    ]);
    const cssAssets: Emitted[] = emitted.filter(
      (e) => /^assets\/qstyle\.q_[0-9a-f]+\.css$/.test(e.fileName),
    );
    expect(cssAssets).toHaveLength(1);
    const css: string = cssAssets[0]?.source ?? '';
    // 共有 decl は group selector 化され、chunk 内に 1 回だけ現れる。
    expect(css).toMatch(/\.q_[0-9a-f]{8},\.q_[0-9a-f]{8}\{display:flex\}\.q_[0-9a-f]{8}\{gap:8px\}/);
    expect(css.split('display:flex').length - 1).toBe(1);
  });

  it('resolves route manifest assets to emitted file names (R1.3)', () => {
    const modules = [
      {
        id: '/src/ca-route.tsx',
        code: `export const R = () => <div css={{ display: 'flex' }} />;`,
      },
    ];
    const { emitted } = buildOnce(
      { backend: 'css-asset', routes: { '/': ['/src/ca-route.tsx'] } },
      modules,
    );
    const routesAsset: Emitted | undefined = emitted.find(
      (e) => e.fileName === 'qstyle.routes.json',
    );
    expect(routesAsset).toBeDefined();
    const manifest = JSON.parse(routesAsset?.source ?? '{}') as {
      entries: { route: string; assets: string[] }[];
    };
    expect(manifest.entries).toHaveLength(1);
    const entry = manifest.entries[0];
    expect(entry?.route).toBe('/');
    const cssFileNames: string[] = emitted
      .filter((e) => /^assets\/qstyle\.q_[0-9a-f]+\.css$/.test(e.fileName))
      .map((e) => e.fileName);
    expect(entry?.assets.length).toBeGreaterThan(0);
    for (const asset of entry?.assets ?? []) {
      expect(cssFileNames).toContain(asset);
    }
  });

  it('sets globalThis.__QSTYLE_ROUTES__ for in-process SSG render (§3.4 R1.4)', () => {
    // plugin 側は書き込みのみ。reader (QstyleLinks) の型とは緩い構造一致で検証する。
    delete (globalThis as { __QSTYLE_ROUTES__?: unknown }).__QSTYLE_ROUTES__;
    const { emitted } = buildOnce(
      { backend: 'css-asset', routes: { '/': ['/src/ca-route.tsx'] } },
      [
        {
          id: '/src/ca-route.tsx',
          code: `export const R = () => <div css={{ display: 'flex' }} />;`,
        },
      ],
    );
    const globalRoutes: unknown = (globalThis as { __QSTYLE_ROUTES__?: unknown })
      .__QSTYLE_ROUTES__;
    expect(globalRoutes).toBeDefined();
    // qstyle.routes.json と同一内容 (serialize 前の object)。
    const routesAsset: Emitted | undefined = emitted.find(
      (e) => e.fileName === 'qstyle.routes.json',
    );
    expect(globalRoutes).toEqual(JSON.parse(routesAsset?.source ?? '{}') as unknown);
    const entries = (globalRoutes as { entries: { route: string }[] }).entries;
    expect(entries.map((e) => e.route)).toEqual(['/']);
  });

  it('exposes chunk plans (members/bytes/fileName) via __chunkPlans (R1.8 metadata)', () => {
    const plugins: Record<string, unknown>[] = pluginsOf(
      { backend: 'css-asset' },
      'qstyle',
      'qstyle:css-asset',
    );
    const main: Record<string, unknown> = req(plugins[0]);
    const cssAsset: Record<string, unknown> = req(plugins[1]);
    const buildStart = main['buildStart'] as () => void;
    const transform = main['transform'] as (
      code: string,
      id: string,
    ) => { code: string } | null;
    const generate = cssAsset['generateBundle'] as (
      this: { emitFile: (f: Emitted) => void },
    ) => void;
    buildStart();
    transform(
      `export const A = () => <div css={{ display: 'flex' }} />;`,
      '/src/ca-meta.tsx',
    );
    generate.call({ emitFile: (): void => undefined });
    const plans = cssAsset['__chunkPlans'] as {
      id: string;
      members: readonly string[];
      bytes: number;
      fileName: string;
    }[];
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(plan.id).toMatch(/^pack_[0-9a-f]{6}$/);
      expect(plan.members.length).toBeGreaterThan(0);
      expect(plan.fileName).toMatch(/^assets\/qstyle\.q_[0-9a-f]+\.css$/);
    }
  });

  it('logs backend + chunk plan report on generateBundle when debug (R1.8 report 表示)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      buildOnce(
        { backend: 'css-asset', debug: true },
        [{ id: '/src/ca-report.tsx', code: `export const A = () => <div css={{ display: 'flex' }} />;` }],
      );
      const logged: string = spy.mock.calls
        .map((args) => args.map((a) => String(a)).join(' '))
        .join('\n');
      expect(logged).toContain('chunk report (backend: css-asset');
      expect(logged).toMatch(/assets\/qstyle\.q_[0-9a-f]+\.css/);
    } finally {
      spy.mockRestore();
    }
  });

  it('qstyle:dedup does not touch css-asset output (§3.4 R1.1 実行順依存)', () => {
    const dedupPlugin: Record<string, unknown> = req(
      pluginsOf({ backend: 'css-asset' }, 'qstyle:dedup')[0],
    );
    const generate = dedupPlugin['generateBundle'] as (
      this: unknown,
      options: unknown,
      bundle: Record<string, unknown>,
    ) => void;
    interface MutableAsset {
      type: string;
      fileName: string;
      source: string;
    }
    const qstyleAsset: MutableAsset = {
      type: 'asset',
      fileName: 'assets/qstyle.q_dead.css',
      source: '.q_aaaaaaaa{color:red}.q_bbbbbbbb{color:red}',
    };
    const viteAsset: MutableAsset = {
      type: 'asset',
      fileName: 'assets/style.css',
      source: '.q_cccccccc{color:red}.q_dddddddd{color:red}',
    };
    generate.call(undefined, {}, { q: qstyleAsset, v: viteAsset });
    // css-asset の出力は emit 前 (hash 計算前) dedup 済みのため無編集。
    expect(qstyleAsset.source).toBe('.q_aaaaaaaa{color:red}.q_bbbbbbbb{color:red}');
    // vite 配管由来の CSS には従来どおり適用される。
    expect(viteAsset.source).not.toBe('.q_cccccccc{color:red}.q_dddddddd{color:red}');
    expect(viteAsset.source).toContain('.q_cccccccc,.q_dddddddd{color:red}');
  });
});
