import type { Binding, NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import postcss from 'postcss';
import {
  NativeStyleError, nativeProperty, nativeSlotUnit, nativeStaticValue,
  type DeclarationDefinition, type NativeStyleRule,
} from '@qstyle/core';
import { isCssMacro } from './bindings.js';
import { parseStyleCss } from './css.js';
import { evaluateStatic } from './evaluate.js';
import { sourceSpan, type ParsedStyleModule } from './parse.js';
import type { EvaluatedValue, RuntimeExpression } from './values.js';

export type DynamicValuePart = string | { readonly input: number };
export interface DynamicStyleBinding {
  readonly definition: DeclarationDefinition;
  readonly parts: readonly DynamicValuePart[];
}

export interface LoweredStyle {
  readonly rules: readonly NativeStyleRule[];
  readonly globals: ReturnType<typeof parseStyleCss>['globals'];
  /** Evaluate these once, in order, at the original css attribute position. */
  readonly inputs: readonly RuntimeExpression[];
  readonly bindings: readonly DynamicStyleBinding[];
}

export type StyleExpression =
  | { readonly kind: 'style'; readonly value: LoweredStyle }
  | { readonly kind: 'sequence'; readonly items: readonly StyleExpression[] }
  | { readonly kind: 'choice'; readonly test: RuntimeExpression;
      readonly consequent: StyleExpression; readonly alternate: StyleExpression };

/** Read an already evaluated spread object instead of replaying its initializer. */
export function lowerStoredStyleExpression(
  path: NodePath<t.Expression>, module: ParsedStyleModule, stored: string,
): StyleExpression {
  const snapshot = (value: EvaluatedValue, access: string): EvaluatedValue => {
    if (value.kind === 'literal') return value;
    if (value.kind === 'runtime') return { ...value, code: access };
    if (value.kind === 'array') return { ...value, effects: [],
      items: value.items.map((item, index) => snapshot(item, `${access}[${index}]`)) };
    return { ...value, effects: [], entries: value.entries.map(([key, item]) =>
      [key, snapshot(item, `${access}[${JSON.stringify(key)}]`)] as const) };
  };
  const lower = (value: EvaluatedValue): StyleExpression => {
    if (value.kind === 'literal' && (value.value == null || typeof value.value === 'boolean')) return EMPTY_STYLE;
    if (value.kind === 'array') return { kind: 'sequence', items: value.items.map(lower) };
    if (value.kind === 'object') return { kind: 'style', value: lowerObject(value, module, path.node) };
    return fail(module, path.node, 'Stored spread CSS must have a statically known object or array shape.');
  };
  return lower(snapshot(evaluateStatic(path, module), stored));
}

export interface LowerStyleOptions {
  readonly resolveImport?: (source: string, imported: string) => StyleExpression | undefined;
}

const EMPTY_STYLE: StyleExpression = Object.freeze({ kind: 'sequence', items: Object.freeze([]) });

/**
 * Identify an initializer that is made out of compiler-owned style handles.
 *
 * `evaluateStatic` deliberately treats a css macro call as a runtime
 * expression because it must never execute calls.  A reusable handle still
 * needs to recurse through that call, so identifier lowering uses this small
 * syntax check to distinguish an opaque compiler handle from an unsafe raw
 * object alias.  The evaluator remains the authority for all structural
 * const safety checks.
 */
function hasStyleHandleSource(path: NodePath<t.Expression>, seen: ReadonlySet<Binding> = new Set()): boolean {
  if (path.isTSAsExpression() || path.isTSSatisfiesExpression() || path.isTSNonNullExpression()
    || path.isTSTypeAssertion() || path.isTypeCastExpression() || path.isParenthesizedExpression()) {
    const expression = path.get('expression');
    return expression.isExpression() && hasStyleHandleSource(expression, seen);
  }
  if (path.isCallExpression() && isCssMacro(path.get('callee'))) return true;
  if (path.isTaggedTemplateExpression() && isCssMacro(path.get('tag'))) return true;
  if (path.isArrayExpression()) {
    return path.get('elements').some((item) => {
      if (!item.node) return false;
      const expression = item.isSpreadElement() ? item.get('argument') : item;
      return expression.isExpression() && hasStyleHandleSource(expression, seen);
    });
  }
  if (path.isConditionalExpression()) {
    const consequent = path.get('consequent');
    const alternate = path.get('alternate');
    return consequent.isExpression() && hasStyleHandleSource(consequent, seen)
      || alternate.isExpression() && hasStyleHandleSource(alternate, seen);
  }
  if (path.isLogicalExpression()) {
    const left = path.get('left');
    const right = path.get('right');
    return left.isExpression() && hasStyleHandleSource(left, seen)
      || right.isExpression() && hasStyleHandleSource(right, seen);
  }
  if (!path.isIdentifier()) return false;

  const binding = path.scope.getBinding(path.node.name);
  if (!binding) return false;
  if (binding.path.isImportSpecifier() || binding.path.isImportDefaultSpecifier()
    || binding.path.isImportNamespaceSpecifier()) return true;
  if (binding.kind !== 'const' || !binding.constant || !binding.path.isVariableDeclarator()
    || seen.has(binding)) return false;
  const init = binding.path.get('init');
  if (!init.isExpression()) return false;
  const next = new Set(seen);
  next.add(binding);
  return hasStyleHandleSource(init, next);
}

function fail(module: ParsedStyleModule, node: t.Node, message: string): never {
  throw new NativeStyleError({ code: 'QS1102', message, source: sourceSpan(module.file, node) });
}

function runtime(path: NodePath<t.Expression>, module: ParsedStyleModule): RuntimeExpression {
  return { kind: 'runtime', node: path.node,
    code: module.code.slice(path.node.start ?? 0, path.node.end ?? 0), source: sourceSpan(module.file, path.node) };
}

function finishCss(
  css: string, inputs: readonly RuntimeExpression[], placeholders: ReadonlyMap<string, number>,
  module: ParsedStyleModule, node: t.Node, staticNumbers: ReadonlyMap<string, number> = new Map(),
): LoweredStyle {
  const hasToken = (text: string): boolean => [...placeholders.keys()].some((token) => text.includes(token));
  if (placeholders.size || staticNumbers.size) {
    let syntax: postcss.Root;
    try { syntax = postcss.parse(css); }
    catch (error) {
      throw new NativeStyleError({ code: 'QS1101', message: `Malformed template CSS: ${String(error)}`,
        source: sourceSpan(module.file, node) });
    }
    syntax.walk((entry) => {
      if ((entry.type === 'rule' && hasToken(entry.selector))
        || (entry.type === 'atrule' && hasToken(`${entry.name} ${entry.params}`))
        || (entry.type === 'decl' && hasToken(entry.prop))) {
        fail(module, node, 'Runtime selector, property, and at-rule structure is not supported.');
      }
      const replaceNumbers = (text: string): string => {
        for (const [token, value] of staticNumbers) text = text.split(token).join(String(value));
        return text;
      };
      if (entry.type === 'decl') {
        const number = staticNumbers.get(entry.value);
        if (number !== undefined) {
          const formatted = nativeStaticValue(entry.prop, number);
          if (formatted.kind === 'static') entry.value = formatted.css;
        } else entry.value = replaceNumbers(entry.value);
      } else if (entry.type === 'rule') entry.selector = replaceNumbers(entry.selector);
      else if (entry.type === 'atrule') entry.params = replaceNumbers(entry.params);
    });
    css = syntax.toString();
  }
  const parsed = parseStyleCss(css, { file: module.file, offset: node.start ?? 0 });
  const bindings: DynamicStyleBinding[] = [];
  let slotIndex = 0;
  const splitValue = (text: string): readonly DynamicValuePart[] => {
    const parts: DynamicValuePart[] = [];
    let cursor = 0;
    while (cursor < text.length) {
      let next = -1; let matched: string | undefined;
      for (const token of placeholders.keys()) {
        const at = text.indexOf(token, cursor);
        if (at >= 0 && (next < 0 || at < next)) { next = at; matched = token; }
      }
      if (matched === undefined) { parts.push(text.slice(cursor)); break; }
      if (next > cursor) parts.push(text.slice(cursor, next));
      parts.push({ input: placeholders.get(matched)! });
      cursor = next + matched.length;
    }
    return parts;
  };
  const rules = parsed.rules.map((rule): NativeStyleRule => {
    if (hasToken(JSON.stringify([rule.selector, rule.wrappers]))) {
      fail(module, node, 'Runtime selector and at-rule structure is not supported.');
    }
    const declarations = rule.declarations.map((declaration) => {
      if (hasToken(declaration.property)) fail(module, node, 'Runtime CSS property names are not supported.');
      if (declaration.value.kind !== 'static' || !hasToken(declaration.value.css)) return declaration;
      const parts = splitValue(declaration.value.css);
      const pureInput = parts.length === 1 && typeof parts[0] !== 'string';
      const lowered = { ...declaration, value: {
        kind: 'slot' as const, index: slotIndex++, unit: pureInput ? nativeSlotUnit(declaration.property) : 'raw' as const,
      } };
      bindings.push({ definition: { selector: rule.selector, wrappers: rule.wrappers,
        declaration: lowered, dependencies: rule.dependencies }, parts });
      return lowered;
    });
    return { ...rule, declarations };
  });
  if (parsed.globals.some((global) => hasToken(JSON.stringify(global)))) {
    fail(module, node, 'Global styles and keyframes must be static.');
  }
  return { rules, globals: parsed.globals, inputs, bindings };
}

function inputCollector(module: ParsedStyleModule): {
  inputs: RuntimeExpression[];
  placeholders: Map<string, number>;
  register: (expression: RuntimeExpression) => string;
} {
  let prefix = '__qstyle_input_';
  while (module.code.includes(prefix)) prefix += '_';
  const inputs: RuntimeExpression[] = [];
  const placeholders = new Map<string, number>();
  const indexes = new Map<t.Expression, number>();
  const register = (expression: RuntimeExpression): string => {
    let index = indexes.get(expression.node);
    if (index === undefined) { index = inputs.length; indexes.set(expression.node, index); inputs.push(expression); }
    const token = `${prefix}${index}__`;
    placeholders.set(token, index);
    return token;
  };
  return { inputs, placeholders, register };
}

function lowerObject(value: EvaluatedValue, module: ParsedStyleModule, node: t.Node): LoweredStyle {
  const collector = inputCollector(module);
  const serializeObject = (object: EvaluatedValue): string => {
    if (object.kind !== 'object') fail(module, node, 'A style structure must be a statically known object.');
    // Even values overwritten by a later object property must still evaluate.
    for (const effect of object.effects) collector.register(effect);
    let css = '';
    for (const [key, entry] of object.entries) {
      if (entry.kind === 'literal' && (entry.value == null || typeof entry.value === 'boolean')) continue;
      if (entry.kind === 'object') { css += `${key}{${serializeObject(entry)}}`; continue; }
      if (key.startsWith('@') || key.includes('&')) fail(module, node, 'Nested style structure must be static.');
      const property = nativeProperty(key);
      if (entry.kind === 'runtime') { css += `${property}:${collector.register(entry)};`; continue; }
      if (entry.kind !== 'literal' || (typeof entry.value !== 'string' && typeof entry.value !== 'number')) {
        fail(module, node, `Unsupported value for ${property}.`);
      }
      const staticValue = nativeStaticValue(property, entry.value);
      if (staticValue.kind === 'static') {
        // Object values cannot introduce extra declarations or terminate their rule.
        let parsedValue: postcss.Root;
        try { parsedValue = postcss.parse(`&{${property}:${staticValue.css};}`); }
        catch { fail(module, node, `Malformed object value for ${property}.`); }
        const rule = parsedValue.first;
        const parsed = rule?.type === 'rule' ? rule.first : undefined;
        if (parsedValue.nodes.length !== 1 || rule?.type !== 'rule' || rule.nodes.length !== 1
          || parsed?.type !== 'decl' || parsed.prop !== property) {
          fail(module, node, `Object value for ${property} must contain exactly one declaration value.`);
        }
        const raw = parsed.raws.value?.raw ?? parsed.value;
        const reconstructed = raw + (parsed.important ? parsed.raws.important ?? ' !important' : '');
        if (reconstructed !== staticValue.css) fail(module, node, `Object value for ${property} contains trailing CSS syntax.`);
      }
      css += `${property}:${staticValue.kind === 'static' ? staticValue.css : ''};`;
    }
    return css;
  };
  return finishCss(serializeObject(value), collector.inputs, collector.placeholders, module, node);
}

function lowerTemplate(path: NodePath<t.TaggedTemplateExpression>, module: ParsedStyleModule): LoweredStyle {
  const collector = inputCollector(module);
  const staticNumbers = new Map<string, number>();
  let numberPrefix = '__qstyle_number_';
  while (module.code.includes(numberPrefix)) numberPrefix += '_';
  const quasi = path.get('quasi');
  const expressions = quasi.get('expressions');
  let css = '';
  for (let index = 0; index < quasi.node.quasis.length; index++) {
    css += quasi.node.quasis[index]!.value.cooked ?? quasi.node.quasis[index]!.value.raw;
    const expression = expressions[index];
    if (!expression) continue;
    if (!expression.isExpression()) fail(module, expression.node, 'Template styles require value expressions.');
    const evaluated = evaluateStatic(expression, module);
    if (evaluated.kind === 'literal' && typeof evaluated.value === 'number') {
      if (!Number.isFinite(evaluated.value)) fail(module, expression.node, 'A static CSS number must be finite.');
      const token = `${numberPrefix}${staticNumbers.size}__`;
      staticNumbers.set(token, evaluated.value); css += token;
    } else if (evaluated.kind === 'literal' && typeof evaluated.value === 'string') {
      css += evaluated.value;
    } else if (evaluated.kind === 'runtime') css += collector.register(evaluated);
    else fail(module, expression.node, 'Template interpolation must be a string or number value.');
  }
  return finishCss(css, collector.inputs, collector.placeholders, module, path.node, staticNumbers);
}

/** Resolve finite shape choices without executing application code during the build. */
export function lowerStyleExpression(
  path: NodePath<t.Expression>, module: ParsedStyleModule, options: LowerStyleOptions = {},
): StyleExpression {
  const visiting = new Set<t.Node>();
  const lower = (current: NodePath<t.Expression>): StyleExpression => {
    if (visiting.has(current.node)) fail(module, current.node, 'Cyclic style handle reference.');
    visiting.add(current.node);
    try {
      if (current.isTSAsExpression() || current.isTSSatisfiesExpression() || current.isTSNonNullExpression()) {
        return lower(current.get('expression'));
      }
      if (current.isCallExpression() && isCssMacro(current.get('callee'))) {
        const args = current.get('arguments');
        if (args.length !== 1 || !args[0]!.isExpression()) fail(module, current.node, 'css() requires one statically shaped style argument.');
        return lower(args[0] as NodePath<t.Expression>);
      }
      if (current.isTaggedTemplateExpression() && isCssMacro(current.get('tag'))) {
        return { kind: 'style', value: lowerTemplate(current, module) };
      }
      if (current.isArrayExpression()) {
        const items: StyleExpression[] = [];
        for (const item of current.get('elements')) {
          if (!item.node) continue;
          if (item.isSpreadElement()) {
            const spread = lower(item.get('argument'));
            if (spread.kind !== 'sequence') fail(module, item.node, 'Style array spreads must resolve to a static array.');
            items.push(...spread.items);
          } else if (item.isExpression()) items.push(lower(item));
          else fail(module, current.node, 'Unsupported style array item.');
        }
        return { kind: 'sequence', items };
      }
      if (current.isConditionalExpression()) {
        const test = current.get('test'); const evaluated = evaluateStatic(test, module);
        if (evaluated.kind === 'literal') return lower(evaluated.value ? current.get('consequent') : current.get('alternate'));
        return { kind: 'choice', test: runtime(test, module), consequent: lower(current.get('consequent')), alternate: lower(current.get('alternate')) };
      }
      if (current.isLogicalExpression() && current.node.operator === '&&') {
        const test = current.get('left'); const evaluated = evaluateStatic(test, module);
        if (evaluated.kind === 'literal') return evaluated.value ? lower(current.get('right')) : EMPTY_STYLE;
        return { kind: 'choice', test: runtime(test, module), consequent: lower(current.get('right')), alternate: EMPTY_STYLE };
      }
      if (current.isIdentifier()) {
        const binding = current.scope.getBinding(current.node.name);
        if (binding?.kind === 'const' && binding.constant && binding.path.isVariableDeclarator()) {
          const init = binding.path.get('init');
          if (init.isExpression()) {
            const evaluated = evaluateStatic(current, module);
            if (evaluated.kind === 'runtime' && !hasStyleHandleSource(init)) {
              fail(module, current.node, 'A reusable style handle must be a statically known value.');
            }
            const resolved = lower(init);
            const containsRuntime = (expression: StyleExpression): boolean => expression.kind === 'choice'
              || (expression.kind === 'style' ? expression.value.inputs.length > 0 : expression.items.some(containsRuntime));
            if (containsRuntime(resolved)) fail(module, current.node,
              'A reusable style handle must be static; put dynamic values and choices directly in the css prop.');
            return resolved;
          }
        }
        if (binding?.path.isImportSpecifier() && binding.path.parentPath?.isImportDeclaration()) {
          const imported = binding.path.node.imported;
          const resolved = options.resolveImport?.(binding.path.parentPath.node.source.value,
            imported.type === 'Identifier' ? imported.name : imported.value);
          if (resolved) return resolved;
          fail(module, current.node, 'Cannot resolve the imported compile-time style handle.');
        }
      }
      const value = evaluateStatic(current, module);
      if (value.kind === 'literal' && (value.value == null || typeof value.value === 'boolean')) return EMPTY_STYLE;
      if (value.kind === 'object') return { kind: 'style', value: lowerObject(value, module, current.node) };
      fail(module, current.node, 'Style shape must be a static object, template, handle, array, or finite conditional choice.');
    } finally { visiting.delete(current.node); }
  };
  return lower(path);
}
