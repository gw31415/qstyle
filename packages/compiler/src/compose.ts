import { NativeIdentityRegistry, NativeStyleError, canonicalStyleSelector, canonicalStyleWrappers, definitionSlotName, type NativeStyleRule,
  type StyleProgramState } from '@qstyle/core';
import type { ParsedNativeGlobal } from './css.js';
import type { DynamicStyleBinding, StyleExpression } from './lower.js';

export interface ComposedStyleState {
  readonly rules: readonly NativeStyleRule[];
  readonly globals: readonly ParsedNativeGlobal[];
}

export interface StyleSitePlan {
  readonly id: string;
  readonly ownerId: string;
  readonly expression: StyleExpression;
  readonly alternatives: readonly ComposedStyleState[];
  readonly states: readonly StyleProgramState[];
}

/**
 * css array entries are authoring contributions: a later contribution replaces
 * the same property/condition/importance. Fallback sequences inside that final
 * contribution remain ordered and intact. Different conditions never replace
 * each other merely because their property names match.
 */
export function composeRuleContributions(
  earlier: readonly NativeStyleRule[], later: readonly NativeStyleRule[],
): readonly NativeStyleRule[] {
  const key = (rule: NativeStyleRule, property: string, important: boolean): string => JSON.stringify([
    canonicalStyleSelector(rule.selector), canonicalStyleWrappers(rule.wrappers), property, important,
  ]);
  const replaced = new Set(later.flatMap((rule) => rule.declarations.map((declaration) => key(rule, declaration.property, declaration.important))));
  return [...earlier.map((rule) => ({ ...rule, declarations: rule.declarations.filter((declaration) =>
    !replaced.has(key(rule, declaration.property, declaration.important))) })).filter((rule) => rule.declarations.length), ...later];
}

/** Enumerate complete style choices. This is independent of runtime predicate values. */
export function planStyleSite(
  expression: StyleExpression, id: string, ownerId: string, maxStates = 256,
): StyleSitePlan {
  const check = (count: number): void => {
    if (!Number.isSafeInteger(count) || count > maxStates) {
      throw new NativeStyleError({ code: 'QS1602', message: `Style site ${id} exceeds the exact state limit (${maxStates}).` });
    }
  };
  const enumerate = (current: StyleExpression): readonly ComposedStyleState[] => {
    if (current.kind === 'style') return [{ rules: current.value.rules, globals: current.value.globals }];
    if (current.kind === 'choice') {
      const left = enumerate(current.consequent); const right = enumerate(current.alternate);
      check(left.length + right.length);
      return [...left, ...right];
    }
    let combined: readonly ComposedStyleState[] = [{ rules: [], globals: [] }];
    for (const item of current.items) {
      const next = enumerate(item);
      check(combined.length * next.length);
      combined = combined.flatMap((before) => next.map((after) => ({
        rules: composeRuleContributions(before.rules, after.rules), globals: [...before.globals, ...after.globals],
      })));
    }
    return combined;
  };
  const alternatives = enumerate(expression);
  return { id, ownerId, expression, alternatives, states: alternatives.map((alternative, index) => ({
    id: `${id}/state:${index}`, rules: alternative.rules,
    demand: { id: `${id}/state:${index}`, owner: ownerId, renderPath: id, styleState: String(index),
      lazyBoundary: ownerId, predicate: `choice(${id})=${index}` },
  })) };
}

function stateCount(expression: StyleExpression): number {
  if (expression.kind === 'style') return 1;
  if (expression.kind === 'choice') return stateCount(expression.consequent) + stateCount(expression.alternate);
  return expression.items.reduce((count, item) => count * stateCount(item), 1);
}

export interface EmittedStyleEvaluation {
  readonly code: string;
  readonly state: string;
  readonly slots: string;
}

/**
 * Only plain value/branch expressions survive. No style IR, registry or helper
 * module is emitted. Each source expression executes once at its attribute site.
 */
export function emitStyleEvaluation(
  plan: StyleSitePlan, prefix: string, identities: NativeIdentityRegistry = new NativeIdentityRegistry(), dev = false,
): EmittedStyleEvaluation {
  let ordinal = 0;
  const fresh = (suffix: string): string => `${prefix}_${suffix}${ordinal++}`;
  const slots = fresh('slots');
  const state = fresh('state');
  const lines = [`const ${slots}={};`];
  const emitBinding = (binding: DynamicStyleBinding, inputs: readonly string[], output: string[]): void => {
    const slot = definitionSlotName(binding.definition, identities);
    if (!slot) throw new NativeStyleError({ code: 'QS1102', message: 'A dynamic binding has no matching CSS slot.' });
    const variables = [...new Set(binding.parts.filter((part) => typeof part !== 'string').map((part) => inputs[part.input]!))];
    if (variables.some((variable) => !variable)) {
      throw new NativeStyleError({ code: 'QS1102', message: 'A slot references a missing expression input.' });
    }
    const valid = variables.map((variable) => `(typeof ${variable}==="string"||(typeof ${variable}==="number"&&Number.isFinite(${variable})))`).join('&&') || 'true';
    let value: string;
    if (binding.parts.length === 1 && typeof binding.parts[0] !== 'string') {
      const input = inputs[binding.parts[0]!.input]!;
      const schema = binding.definition.declaration.value;
      value = schema.kind === 'slot' && schema.unit === 'length'
        ? `(typeof ${input}==="number"?${input}+"px":${input})` : `String(${input})`;
    } else {
      value = '""' + binding.parts.map((part) => `+${typeof part === 'string' ? JSON.stringify(part) : `String(${inputs[part.input]})`}`).join('');
    }
    output.push(`${slots}[${JSON.stringify(slot)}]=(${valid})?${value}:undefined;`);
    if (dev) {
      const invalid = variables.map((variable) => `(${variable}!=null&&typeof ${variable}!=="boolean"&&!(typeof ${variable}==="string"||(typeof ${variable}==="number"&&Number.isFinite(${variable}))))`).join('||');
      if (invalid) output.push(`if(${invalid})console.error("[qstyle QS1102] Invalid dynamic value for ${binding.definition.declaration.property}.");`);
    }
  };
  const emit = (current: StyleExpression, output: string[]): string => {
    if (current.kind === 'style') {
      const inputs = current.value.inputs.map((input) => {
        const name = fresh('value'); output.push(`const ${name}=(${input.code});`); return name;
      });
      for (const binding of current.value.bindings) emitBinding(binding, inputs, output);
      return '0';
    }
    if (current.kind === 'choice') {
      const result = fresh('choice');
      const consequent: string[] = []; const alternate: string[] = [];
      const left = emit(current.consequent, consequent); const right = emit(current.alternate, alternate);
      output.push(`let ${result};if(${current.test.code}){${consequent.join('')}${result}=${left};}`
        + `else{${alternate.join('')}${result}=${stateCount(current.consequent)}+(${right});}`);
      return result;
    }
    let result = '0';
    for (const item of current.items) {
      const selected = emit(item, output);
      result = `((${result})*${stateCount(item)}+(${selected}))`;
    }
    return result;
  };
  const selected = emit(plan.expression, lines);
  lines.push(`const ${state}=${selected};`);
  return { code: lines.join('\n'), state, slots };
}
