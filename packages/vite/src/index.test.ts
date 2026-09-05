import { describe, expect, it } from 'vitest';
import { hashStaticAtom } from '@qstyle/core';
import { lowerStyleObject } from '@qstyle/qwik';
import { parseStyleObjectLiteral, qstyle, serializeAtomCss } from './index.js';

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
    // spread / runtime value / bare handle は parse 不能または residual のため untouched。
    expect(
      p.transform(`export const A = () => <div css={{ ...base }} />;`, '/src/c.tsx'),
    ).toBeNull();
    expect(
      p.transform(`export const A = () => <div css={{ display: value }} />;`, '/src/d.tsx'),
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
