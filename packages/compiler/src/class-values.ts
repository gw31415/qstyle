import type { Binding, NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { NativeStyleError } from '@qstyle/core';
import { evaluateStatic } from './evaluate.js';
import { sourceSpan, type ParsedStyleModule } from './parse.js';
import type { EvaluatedPrimitive, RuntimeExpression } from './values.js';

export interface FiniteClassValues {
  readonly values: readonly string[];
  readonly tokens: readonly (readonly string[])[];
  /** Evaluate the original expression once at its original JSX attribute position. */
  readonly runtime?: RuntimeExpression;
}

/** Finite class strings are proved without running predicates or user functions. */
export function analyzeClassValues(
  expression: NodePath<t.Expression>, module: ParsedStyleModule, maxStates = 256,
): FiniteClassValues {
  const seen = new Set<Binding>();
  const fail = (path: NodePath<t.Expression>, message: string): never => {
    throw new NativeStyleError({ code: 'QS1102', message, source: sourceSpan(module.file, path.node) });
  };
  const bounded = (values: readonly EvaluatedPrimitive[]): readonly EvaluatedPrimitive[] => {
    const unique = [...new Set(values)];
    if (unique.length > maxStates) throw new NativeStyleError({ code: 'QS1602',
      message: `Class expression exceeds the exact state limit (${maxStates}).`, source: sourceSpan(module.file, expression.node) });
    return unique;
  };
  const valuesOf = (path: NodePath<t.Expression>): readonly EvaluatedPrimitive[] => {
    const evaluated = evaluateStatic(path, module);
    if (evaluated.kind === 'literal') return [evaluated.value];
    if (path.isTSAsExpression() || path.isTSSatisfiesExpression() || path.isTSNonNullExpression()
      || path.isTSTypeAssertion() || path.isTypeCastExpression() || path.isParenthesizedExpression()) {
      return valuesOf(path.get('expression') as NodePath<t.Expression>);
    }
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (binding?.kind === 'const' && binding.constant && binding.path.isVariableDeclarator() && !seen.has(binding)) {
        const init = binding.path.get('init');
        if (init.isExpression()) {
          seen.add(binding);
          try { return valuesOf(init); } finally { seen.delete(binding); }
        }
      }
    }
    if (path.isConditionalExpression()) {
      const test = evaluateStatic(path.get('test'), module);
      if (test.kind === 'literal') return valuesOf(test.value ? path.get('consequent') : path.get('alternate'));
      return bounded([...valuesOf(path.get('consequent')), ...valuesOf(path.get('alternate'))]);
    }
    if (path.isLogicalExpression()) {
      const left = path.get('left'); const right = path.get('right');
      const evaluatedLeft = evaluateStatic(left, module);
      if (evaluatedLeft.kind === 'literal') {
        const useRight = path.node.operator === '&&' ? Boolean(evaluatedLeft.value)
          : path.node.operator === '??' ? evaluatedLeft.value == null : !evaluatedLeft.value;
        return useRight ? valuesOf(right) : [evaluatedLeft.value];
      }
      if (path.node.operator === '&&') {
        // At the class root these all serialize to empty; inside a template their
        // distinct string conversions must remain represented in the finite set.
        return bounded([false, 0, '', null, undefined, NaN, ...valuesOf(right)]);
      }
      const leftValues = valuesOf(left);
      const chooseRight = (value: EvaluatedPrimitive) => path.node.operator === '??' ? value == null : !value;
      return bounded([...leftValues.filter((value) => !chooseRight(value)),
        ...(leftValues.some(chooseRight) ? valuesOf(right) : [])]);
    }
    if (path.isTemplateLiteral()) {
      let values: readonly EvaluatedPrimitive[] = [path.node.quasis[0]!.value.cooked ?? path.node.quasis[0]!.value.raw];
      const expressions = path.get('expressions');
      for (let index = 0; index < expressions.length; index++) {
        const part = expressions[index]!;
        if (!part.isExpression()) fail(path, 'Unsupported class template expression.');
        const next = valuesOf(part as NodePath<t.Expression>);
        const suffix = path.node.quasis[index + 1]!.value.cooked ?? path.node.quasis[index + 1]!.value.raw;
        values = bounded(values.flatMap((before) => next.map((after) => `${String(before)}${String(after)}${suffix}`)));
      }
      return values;
    }
    if (path.isBinaryExpression({ operator: '+' })) {
      const left = path.get('left');
      if (!left.isExpression()) fail(path, 'Unsupported class concatenation.');
      const a = valuesOf(left); const b = valuesOf(path.get('right'));
      return bounded(a.flatMap((before) => b.map((after) => typeof before === 'string' || typeof after === 'string'
        ? String(before) + String(after) : Number(before) + Number(after))));
    }
    return fail(path, 'Class values must be finite strings, conditionals or templates; unknown utility construction is unsupported.');
  };
  const values = [...new Set(valuesOf(expression).map((value) => typeof value === 'string' ? value.trim() : ''))];
  const evaluated = evaluateStatic(expression, module);
  const runtime: RuntimeExpression | undefined = evaluated.kind === 'literal' ? undefined : {
    kind: 'runtime', node: expression.node,
    code: module.code.slice(expression.node.start!, expression.node.end!), source: sourceSpan(module.file, expression.node),
  };
  return { values, tokens: values.map((value) => [...new Set(value.split(/\s+/).filter(Boolean))]), ...(runtime ? { runtime } : {}) };
}
