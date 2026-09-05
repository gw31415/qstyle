import { describe, expect, it } from 'vitest';
import { qstyle } from './index.js';

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
    expect(
      p.transform(`export const A = () => <div css={{ display: 'flex', color: 'red' }} />;`, '/src/c.tsx'),
    ).toBeNull();
    expect(
      p.transform(`export const A = () => <div css={{ display: value }} />;`, '/src/d.tsx'),
    ).toBeNull();
    expect(p.transform(`export const A = () => <div css={handle} />;`, '/src/e.tsx')).toBeNull();
  });

  it('ignores files without css prop', () => {
    const p = qstyle({}) as unknown as {
      transform: (code: string, id: string) => unknown;
    };
    expect(p.transform(`export const x = 1;`, '/src/b.tsx')).toBeNull();
  });
});
