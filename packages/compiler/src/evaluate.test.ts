import type { NodePath } from '@babel/traverse';
import { describe, expect, it } from 'vitest';
import type * as t from '@babel/types';
import { evaluateStatic } from './evaluate.js';
import { parseStyleModule, type ParsedStyleModule } from './parse.js';
import type { EvaluatedValue, RuntimeExpression } from './values.js';

function expressionPath(module: ParsedStyleModule): NodePath<t.Expression> {
  let result: NodePath<t.Expression> | undefined;
  module.program.traverse({
    VariableDeclarator(path) {
      if (path.node.id.type !== 'Identifier' || path.node.id.name !== 'value') return;
      const init = path.get('init');
      if (!Array.isArray(init) && init.node !== null) result = init as NodePath<t.Expression>;
    },
  });
  if (result === undefined) throw new Error('value initializer not found');
  return result;
}

function evaluate(code: string, options: Parameters<typeof evaluateStatic>[2] = {}): EvaluatedValue {
  const module = parseStyleModule(`const value = ${code};`, 'evaluate.fixture.ts');
  return evaluateStatic(expressionPath(module), module, options);
}

function runtime(value: EvaluatedValue): RuntimeExpression {
  expect(value.kind).toBe('runtime');
  return value as RuntimeExpression;
}

describe('evaluateStatic', () => {
  it('evaluates primitive literals and safe expressions', () => {
    expect(evaluate('2 + 3 * 4')).toEqual({ kind: 'literal', value: 14 });
    expect(evaluate('`navy-${1 + 1}`')).toEqual({ kind: 'literal', value: 'navy-2' });
    expect(evaluate('false ? "red" : "blue"')).toEqual({ kind: 'literal', value: 'blue' });
    expect(evaluate('false && missing')).toEqual({ kind: 'literal', value: false });
    expect(evaluate('null ?? "fallback"')).toEqual({ kind: 'literal', value: 'fallback' });
  });

  it('resolves immutable const bindings and static member reads with scope awareness', () => {
    expect(evaluate('({ palette: { primary: "navy" } }).palette.primary')).toEqual({ kind: 'literal', value: 'navy' });
    expect(evaluate('({ palette: { primary: "navy" } })["palette"].primary')).toEqual({ kind: 'literal', value: 'navy' });

    const module = parseStyleModule(
      'const color = "navy"; const value = color; function render(color: string) { return color; }',
      'bindings.fixture.ts',
    );
    expect(evaluateStatic(expressionPath(module), module)).toEqual({ kind: 'literal', value: 'navy' });
  });

  it('keeps shadowed and mutable bindings at runtime', () => {
    const module = parseStyleModule(
      'const color = "navy"; let candidate = color; candidate = "red"; const value = candidate;',
      'mutable.fixture.ts',
    );
    const value = runtime(evaluateStatic(expressionPath(module), module));
    expect(value.code).toBe('candidate');

    const shadowed = parseStyleModule(
      'const color = "navy"; const value = (() => { const color = getColor(); return color; })();',
      'shadow.fixture.ts',
    );
    const shadowedRuntime = runtime(evaluateStatic(expressionPath(shadowed), shadowed));
    expect(shadowedRuntime.code).toBe('(() => { const color = getColor(); return color; })()');
  });

  it('preserves the use-site reference for a dynamic const initializer', () => {
    const module = parseStyleModule(
      'const n = sideEffect(); const value = ({ width: n });',
      'dynamic-binding.fixture.ts',
    );
    const result = evaluateStatic(expressionPath(module), module);
    expect(result.kind).toBe('object');
    if (result.kind !== 'object') return;
    expect(result.entries).toEqual([['width', { kind: 'runtime', code: 'n', node: expect.any(Object), source: expect.any(Object) }]]);
    expect(result.effects.map((effect) => effect.code)).toEqual(['n']);
  });

  it('does not project structural consts after mutation or alias escape', () => {
    const mutated = parseStyleModule(
      'const palette = { color: "red" }; palette.color = "blue"; const value = palette.color;',
      'mutated-structural.fixture.ts',
    );
    expect(runtime(evaluateStatic(expressionPath(mutated), mutated)).code).toBe('palette.color');

    const passed = parseStyleModule(
      'const palette = { color: "red" }; consume(palette); const value = palette.color;',
      'escaped-structural.fixture.ts',
    );
    expect(runtime(evaluateStatic(expressionPath(passed), passed)).code).toBe('palette.color');

    const copied = parseStyleModule(
      'const palette = { color: "red" }; const value = { ...palette };',
      'spread-structural.fixture.ts',
    );
    expect(evaluateStatic(expressionPath(copied), copied)).toEqual({
      kind: 'object', entries: [['color', { kind: 'literal', value: 'red' }]], effects: [],
    });

    const alias = parseStyleModule(
      'const palette = { color: "red" }; const alias = palette; const value = alias;',
      'aliased-structural.fixture.ts',
    );
    expect(runtime(evaluateStatic(expressionPath(alias), alias)).code).toBe('alias');

    const primitiveMember = parseStyleModule(
      'const palette = { color: "red" }; const value = palette.color;',
      'primitive-member.fixture.ts',
    );
    expect(evaluateStatic(expressionPath(primitiveMember), primitiveMember)).toEqual({ kind: 'literal', value: 'red' });

    const nestedAlias = parseStyleModule(
      'const palette = { color: "red" }; const holder = { palette }; const value = holder;',
      'nested-alias.fixture.ts',
    );
    expect(runtime(evaluateStatic(expressionPath(nestedAlias), nestedAlias)).code).toBe('holder');
  });

  it('resolves named, default, and namespace imports through the callback', () => {
    const module = parseStyleModule(
      'import { primary as color } from "./theme"; import theme from "./theme2"; import * as tokens from "./tokens"; const value = { a: color, b: theme.primary, c: tokens.gap };',
      'imports.fixture.ts',
    );
    const result = evaluateStatic(expressionPath(module), module, {
      resolveImport(source, imported) {
        if (source === './theme' && imported === 'primary') return { kind: 'literal', value: 'navy' };
        if (source === './theme2' && imported === 'default') return { kind: 'object', entries: [['primary', { kind: 'literal', value: 'red' }]], effects: [] };
        if (source === './tokens' && imported === '*') return { kind: 'object', entries: [['gap', { kind: 'literal', value: 8 }]], effects: [] };
        return undefined;
      },
    });
    expect(result).toEqual({
      kind: 'object',
      entries: [
        ['a', { kind: 'literal', value: 'navy' }],
        ['b', { kind: 'literal', value: 'red' }],
        ['c', { kind: 'literal', value: 8 }],
      ],
      effects: [],
    });
  });

  it('expands static arrays and objects while retaining holes and final duplicate order', () => {
    const result = evaluate('({ a: 1, ...{ b: 2, a: 3 }, a: 4, c: 5 })');
    expect(result).toEqual({
      kind: 'object',
      entries: [['a', { kind: 'literal', value: 4 }], ['b', { kind: 'literal', value: 2 }], ['c', { kind: 'literal', value: 5 }]],
      effects: [],
    });
    expect(evaluate('[1, , ...[2, 3]]')).toEqual({
      kind: 'array',
      items: [
        { kind: 'literal', value: 1 },
        { kind: 'literal', value: undefined },
        { kind: 'literal', value: 2 },
        { kind: 'literal', value: 3 },
      ],
      effects: [],
    });
  });

  it('records every runtime value even when a later duplicate overwrites it', () => {
    const result = evaluate('({ color: first, color: second })');
    expect(result.kind).toBe('object');
    if (result.kind !== 'object') return;
    expect(result.entries[0]?.[1].kind).toBe('runtime');
    expect(result.effects.map((effect) => effect.code)).toEqual(['first', 'second']);
  });

  it('keeps unknown structural spreads opaque', () => {
    const object = runtime(evaluate('({ known: 1, ...props })'));
    expect(object.code).toBe('({ known: 1, ...props })');
    const array = runtime(evaluate('[...items]'));
    expect(array.code).toBe('[...items]');
  });

  it('reports local const cycles and rejects non-finite static numbers', () => {
    const cycle = parseStyleModule('const a = b; const b = a; const value = a;', 'cycle.fixture.ts');
    expect(() => evaluateStatic(expressionPath(cycle), cycle)).toThrow(/QS1102/);
    expect(() => evaluate('1 / 0')).toThrow(/QS1102/);
  });

  it('never executes calls and preserves their source expression', () => {
    const result = runtime(evaluate('getWidth()'));
    expect(result.code).toBe('getWidth()');
    const start = 'const value = '.length;
    expect(result.source).toEqual({ file: 'evaluate.fixture.ts', start, end: start + 'getWidth()'.length });
  });
});
