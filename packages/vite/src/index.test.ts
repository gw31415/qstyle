import { describe, expect, it } from 'vitest';
import { hashStaticAtom } from '@qstyle/core';
import { lowerStyleObject } from '@qstyle/qwik';
import {
  parseStyleObjectLiteral,
  parseStyleObjectLiteralWithDynamics,
  qstyle,
  serializeAtomCss,
} from './index.js';

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
    // call 式・ternary は動的値として受理しない (M5c)。
    expect(
      p.transform(`export const A = () => <div css={{ display: getWidth() }} />;`, '/src/d2.tsx'),
    ).toBeNull();
    expect(
      p.transform(
        `export const A = () => <div css={{ display: flag ? 'flex' : 'block' }} />;`,
        '/src/d3.tsx',
      ),
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
    expect(out?.code).toMatch(/class="q_[0-9a-f]{8} q_[0-9a-f]{8}"/);
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

  it('rejects calls, ternaries, templates and spreads', () => {
    expect(parseStyleObjectLiteralWithDynamics(`{ width: getWidth() }`)).toBeNull();
    expect(parseStyleObjectLiteralWithDynamics(`{ width: flag ? 1 : 2 }`)).toBeNull();
    expect(parseStyleObjectLiteralWithDynamics(`{ width: \`1px\` }`)).toBeNull();
    expect(parseStyleObjectLiteralWithDynamics(`{ ...base }`)).toBeNull();
    expect(parseStyleObjectLiteralWithDynamics(`{ width: '1px'`)).toBeNull();
  });
});

describe('qstyle vite plugin dynamics (M5c)', () => {
  interface Transformable {
    transform: (code: string, id: string) => { code: string; map: null } | null;
    load: (id: string) => string | null;
  }
  const plugin = (): Transformable => qstyle({ debug: false }) as unknown as Transformable;

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
    const pack: string | null = p.load(`virtual:qstyle/pack/${ids[0] ?? ''}`);
    expect(pack).toContain(`.${ids[0]}{width:var(--qstyle-`);
    expect(out?.code).toContain(`import "virtual:qstyle/pack/${ids[0] ?? ''}"`);
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
    // display:flex (static) + width:var (parametric) + height:10px (static)
    expect(classIds(out?.code ?? '')).toHaveLength(3);
    expect(out?.code).toMatch(/'--qstyle-[0-9a-f]{6}-0': props\.w/);
    const registry: string = p.load('virtual:qstyle/registry') ?? '';
    expect(registry).toContain('display');
    expect(registry).toContain('10px');
    const packs: string[] = classIds(out?.code ?? '').map(
      (id: string): string => p.load(`virtual:qstyle/pack/${id}`) ?? '',
    );
    expect(packs.join('\n')).toContain('width:var(--qstyle-');
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
