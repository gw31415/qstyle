import { describe, expect, it } from 'vitest';
import { qstyle } from './index.js';

describe('qstyle vite plugin (M0)', () => {
  it('exposes vite plugin name', () => {
    const p = qstyle({});
    expect(p.name).toBe('qstyle');
  });

  it('collects css prop heuristic via transform', () => {
    const p = qstyle({ debug: false }) as unknown as {
      transform: (code: string, id: string) => { code: string; map: null } | null;
      load: (id: string) => string | null;
    };
    const code = `export const A = () => <div css={{ display: 'flex' }} />;`;
    const out = p.transform(code, '/src/a.tsx');
    expect(out?.code).toBe(code);
    const registry = p.load('virtual:qstyle/registry');
    expect(registry).toContain('display');
    expect(registry).toContain('flex');
  });

  it('ignores files without css prop', () => {
    const p = qstyle({}) as unknown as {
      transform: (code: string, id: string) => unknown;
    };
    expect(p.transform(`export const x = 1;`, '/src/b.tsx')).toBeNull();
  });
});
