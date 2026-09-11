import { describe, expect, it } from 'vitest';
import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { parseStyleModule } from './parse.js';
import { analyzeClassValues } from './class-values.js';

function analyze(expression: string, prelude = '', limit?: number) {
  const module = parseStyleModule(`${prelude}\nconst target=(${expression});`, 'class.tsx');
  let path: NodePath<t.Expression> | undefined;
  module.program.traverse({ VariableDeclarator(current) {
    if (current.node.id.type === 'Identifier' && current.node.id.name === 'target') {
      const init = current.get('init'); if (init.isExpression()) path = init;
    }
  } });
  return analyzeClassValues(path!, module, limit);
}

describe('finite utility class values', () => {
  it('proves template alternatives without executing predicates', () => {
    const result = analyze('`p-${sideEffect() ? "4" : "8"} ${active ? "dark:text-red" : "text-blue"}`');
    expect(result.values).toEqual(['p-4 dark:text-red', 'p-4 text-blue', 'p-8 dark:text-red', 'p-8 text-blue']);
    expect(result.runtime?.code).toContain('sideEffect()');
  });

  it('keeps reads of previously evaluated finite const aliases at the attribute', () => {
    const result = analyze('choice', 'const choice=sideEffect() ? "p-4" : "p-8";');
    expect(result.values).toEqual(['p-4', 'p-8']);
    expect(result.runtime?.code).toBe('choice');
  });

  it('normalizes falsy classes but preserves their distinct template conversions', () => {
    expect(analyze('active && "p-4"').values).toEqual(['', 'p-4']);
    expect(analyze('`x-${active && "p-4"}`').values).toContain('x-undefined');
    expect(analyze('`x-${active && "p-4"}`').values).toContain('x-false');
  });

  it('rejects unbounded class construction and bounded-state overflow', () => {
    expect(() => analyze('`p-${signal.value}`')).toThrow('QS1102');
    expect(() => analyze('choice', 'let choice="p-4"; choice="p-8";')).toThrow('QS1102');
    expect(() => analyze('flag ? "a" : "b"', '', 1)).toThrow('QS1602');
  });
});
