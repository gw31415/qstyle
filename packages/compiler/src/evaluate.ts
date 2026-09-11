import { type Binding, type NodePath } from '@babel/traverse';
import { isExpression } from '@babel/types';
import type * as t from '@babel/types';
import { NativeStyleError } from '@qstyle/core';
import { sourceSpan, type ParsedStyleModule } from './parse.js';
import type { EvaluatedPrimitive, EvaluatedValue, RuntimeExpression } from './values.js';

export interface EvaluateStaticOptions {
  /** Shape inspection only; consumers must read runtime leaves from the stored object. */
  readonly allowStoredStructuralValues?: boolean;
  readonly resolveImport?:
    | ((source: string, imported: string) => EvaluatedValue | undefined)
    | undefined;
}

type ExpressionPath = NodePath<t.Expression>;
type NodePathLike = NodePath<t.Node | null>;

const literal = (value: EvaluatedPrimitive): EvaluatedValue => ({ kind: 'literal', value });

function isLiteral(value: EvaluatedValue): value is Extract<EvaluatedValue, { readonly kind: 'literal' }> {
  return value.kind === 'literal';
}

function isStructural(value: EvaluatedValue): value is Extract<EvaluatedValue, { readonly kind: 'object' | 'array' }> {
  return value.kind === 'object' || value.kind === 'array';
}

function isRuntime(value: EvaluatedValue): value is RuntimeExpression {
  return value.kind === 'runtime';
}

function isFinitePrimitive(value: EvaluatedPrimitive): boolean {
  return typeof value !== 'number' || Number.isFinite(value);
}

function isTruthy(value: EvaluatedValue): boolean | undefined {
  if (isLiteral(value)) return Boolean(value.value);
  if (isStructural(value)) return value.effects.length === 0 ? true : undefined;
  return undefined;
}

function propertyKey(value: EvaluatedValue): string | undefined {
  if (!isLiteral(value)) return undefined;
  if (typeof value.value === 'symbol' || typeof value.value === 'bigint') return undefined;
  return String(value.value);
}

function primitiveString(value: EvaluatedValue): string | undefined {
  if (!isLiteral(value)) return undefined;
  if (typeof value.value === 'symbol' || typeof value.value === 'bigint') return undefined;
  return String(value.value);
}

function effectsOf(value: EvaluatedValue): readonly RuntimeExpression[] {
  if (isRuntime(value)) return [value];
  if (isStructural(value)) return value.effects;
  return [];
}

function nodeRange(code: string, node: t.Node): { readonly start: number; readonly end: number } {
  const extra = (node as t.Node & {
    readonly extra?: { readonly parenthesized?: boolean; readonly parenStart?: number };
  }).extra;
  const start = extra?.parenthesized === true && extra.parenStart !== undefined
    ? extra.parenStart
    : node.start ?? 0;
  let end = node.end ?? start;
  // Babel stores the opening parenthesis in `extra.parenStart` but leaves the
  // closing parenthesis outside the expression's range. Include contiguous
  // closing parens so a preserved runtime expression remains source-exact.
  if (extra?.parenthesized === true) {
    while (code[end] === ')') end += 1;
  }
  return { start, end };
}

function isPropertyNameNode(node: t.Node): node is t.Identifier | t.StringLiteral | t.NumericLiteral {
  return node.type === 'Identifier' || node.type === 'StringLiteral' || node.type === 'NumericLiteral';
}

function isExpressionPath(path: NodePathLike): path is ExpressionPath {
  return path.node !== null && isExpression(path.node);
}

function asNodePath(path: NodePathLike): NodePath<t.Node> {
  return path as NodePath<t.Node>;
}

interface PatternLookup {
  readonly segments: readonly (readonly ['object', string] | readonly ['array', number])[];
  readonly defaultPath?: ExpressionPath | undefined;
}

/**
 * Evaluate the small, side-effect-free subset needed by style declarations.
 * Unknown expressions are retained as source-bearing runtime values; this
 * evaluator never invokes user code or Babel's general-purpose evaluator.
 */
class StaticEvaluator {
  private readonly resolvingBindings: Set<Binding> = new Set();
  private readonly resolvedImports: Map<string, EvaluatedValue | undefined> = new Map();

  constructor(
    private readonly module: ParsedStyleModule,
    private readonly options: EvaluateStaticOptions,
  ) {}

  evaluate(path: ExpressionPath): EvaluatedValue {
    return this.evaluateExpression(path);
  }

  private runtime(path: NodePathLike): RuntimeExpression {
    if (path.node === null || !isExpression(path.node)) {
      const source = path.node === null ? undefined : sourceSpan(this.module.file, path.node);
      throw new NativeStyleError({
        code: 'QS1102',
        message: 'Expected an expression while preserving a runtime style value.',
        ...(source === undefined ? {} : { source }),
      });
    }
    const range = nodeRange(this.module.code, path.node);
    return {
      kind: 'runtime',
      node: path.node,
      code: this.module.code.slice(range.start, range.end),
      source: sourceSpan(this.module.file, path.node),
    };
  }

  private evaluateExpression(path: ExpressionPath): EvaluatedValue {
    const node = path.node;
    switch (node.type) {
      case 'StringLiteral':
        return literal(node.value);
      case 'NumericLiteral':
        return this.staticNumber(path, node.value);
      case 'BooleanLiteral':
        return literal(node.value);
      case 'NullLiteral':
        return literal(null);
      case 'Identifier':
        return this.evaluateIdentifier(path as NodePath<t.Identifier>);
      case 'UnaryExpression':
        return this.evaluateUnary(path as NodePath<t.UnaryExpression>);
      case 'BinaryExpression':
        return this.evaluateBinary(path as NodePath<t.BinaryExpression>);
      case 'LogicalExpression':
        return this.evaluateLogical(path as NodePath<t.LogicalExpression>);
      case 'ConditionalExpression':
        return this.evaluateConditional(path as NodePath<t.ConditionalExpression>);
      case 'TemplateLiteral':
        return this.evaluateTemplate(path as NodePath<t.TemplateLiteral>);
      case 'ArrayExpression':
        return this.evaluateArray(path as NodePath<t.ArrayExpression>);
      case 'ObjectExpression':
        return this.evaluateObject(path as NodePath<t.ObjectExpression>);
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        return this.evaluateMember(path as NodePath<t.MemberExpression | t.OptionalMemberExpression>);
      case 'ParenthesizedExpression':
        return this.evaluateWrapped(path, 'expression');
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSTypeAssertion':
      case 'TSNonNullExpression':
      case 'TypeCastExpression':
        return this.evaluateWrapped(path, 'expression');
      case 'SequenceExpression':
        return this.evaluateSequence(path as NodePath<t.SequenceExpression>);
      default:
        return this.runtime(path);
    }
  }

  private evaluateWrapped(path: NodePathLike, key: string): EvaluatedValue {
    const child = this.child(path, key);
    return child !== undefined && isExpressionPath(child) ? this.evaluateExpression(child) : this.runtime(path);
  }

  private evaluateIdentifier(path: NodePath<t.Identifier>): EvaluatedValue {
    const binding = path.scope.getBinding(path.node.name);
    if (binding === undefined) {
      if (path.node.name === 'undefined') return literal(undefined);
      if (path.node.name === 'NaN') return this.staticNumber(path, Number.NaN);
      if (path.node.name === 'Infinity') return this.staticNumber(path, Number.POSITIVE_INFINITY);
      return this.runtime(path);
    }

    if (!binding.constant || (binding.kind !== 'const' && binding.kind !== 'module')) {
      return this.runtime(path);
    }
    const declaration = binding.path.node;
    if (declaration.start != null && path.node.start != null && declaration.start > path.node.start) {
      if (this.referencesResolvingBinding(binding)) {
        throw new NativeStyleError({
          code: 'QS1102',
          message: `Cyclic static style binding involving ${JSON.stringify(path.node.name)}.`,
          source: sourceSpan(this.module.file, path.node),
        });
      }
      return this.runtime(path);
    }

    if (binding.kind === 'module' || declaration.type === 'ImportSpecifier' ||
      declaration.type === 'ImportDefaultSpecifier' || declaration.type === 'ImportNamespaceSpecifier') {
      return this.evaluateImport(path, binding);
    }
    if (declaration.type !== 'VariableDeclarator') return this.runtime(path);
    if (this.resolvingBindings.has(binding)) {
      throw new NativeStyleError({
        code: 'QS1102',
        message: `Cyclic static style binding involving ${JSON.stringify(path.node.name)}.`,
        source: sourceSpan(this.module.file, path.node),
      });
    }

    const initPath = this.child(binding.path, 'init');
    if (initPath === undefined || !isExpressionPath(initPath)) return this.runtime(path);
    this.resolvingBindings.add(binding);
    let resolved: EvaluatedValue;
    try {
      resolved = this.evaluateExpression(initPath);
    } finally {
      this.resolvingBindings.delete(binding);
    }

    // A use-site reference is retained whenever proving the initializer would
    // require runtime work. This avoids moving an initializer call or dynamic
    // leaf to every style use, and preserves the original JS evaluation order.
    if (isRuntime(resolved) || (isStructural(resolved) && resolved.effects.length !== 0 && !this.options.allowStoredStructuralValues)) {
      return this.runtime(path);
    }
    if (isStructural(resolved) && (this.hasStructuralEscape(binding, path)
      || this.hasStructuralStorage(path, resolved))) return this.runtime(path);
    if (declaration.id.type === 'Identifier') return resolved;

    const idPath = this.child(binding.path, 'id');
    if (idPath === undefined) return this.runtime(path);
    const lookup = this.findPattern(idPath, binding.identifier);
    if (lookup === undefined) return this.runtime(path);
    return this.readPatternValue(resolved, lookup, path);
  }

  private evaluateImport(path: NodePath<t.Identifier>, binding: Binding): EvaluatedValue {
    const declarationPath = binding.path.parentPath;
    const declaration = declarationPath?.node;
    if (declaration === undefined || declaration.type !== 'ImportDeclaration') return this.runtime(path);
    const specifier = binding.path.node;
    let imported: string;
    if (specifier.type === 'ImportSpecifier') {
      imported = typeof specifier.imported === 'string'
        ? specifier.imported
        : specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
    } else if (specifier.type === 'ImportDefaultSpecifier') {
      imported = 'default';
    } else if (specifier.type === 'ImportNamespaceSpecifier') {
      imported = '*';
    } else {
      return this.runtime(path);
    }
    if (specifier.type === 'ImportSpecifier' && specifier.importKind !== undefined && specifier.importKind !== 'value') {
      return this.runtime(path);
    }
    if (declaration.importKind !== undefined && declaration.importKind !== 'value') return this.runtime(path);
    const source = declaration.source.value;
    if (this.options.resolveImport === undefined) return this.runtime(path);
    const cacheKey = `${source}\u0000${imported}`;
    if (this.resolvedImports.has(cacheKey)) {
      const cached = this.resolvedImports.get(cacheKey);
      return cached === undefined ? this.runtime(path) : cached;
    }
    const value = this.options.resolveImport(source, imported);
    this.resolvedImports.set(cacheKey, value);
    return value === undefined ? this.runtime(path) : value;
  }

  private staticNumber(path: NodePathLike, value: number): EvaluatedValue {
    if (!Number.isFinite(value)) {
      const source = path.node === null ? undefined : sourceSpan(this.module.file, path.node);
      throw new NativeStyleError({
        code: 'QS1102',
        message: 'A statically evaluated CSS number must be finite.',
        ...(source === undefined ? {} : { source }),
      });
    }
    return literal(value);
  }

  private evaluateUnary(path: NodePath<t.UnaryExpression>): EvaluatedValue {
    if (path.node.operator === 'delete') return this.runtime(path);
    const argument = this.child(path, 'argument');
    if (argument === undefined || !isExpressionPath(argument)) return this.runtime(path);
    const value = this.evaluateExpression(argument);
    if (!isLiteral(value)) return this.runtime(path);
    const operand = value.value;
    let result: EvaluatedPrimitive;
    switch (path.node.operator) {
      case '+':
        result = Number(operand);
        break;
      case '-':
        result = -Number(operand);
        break;
      case '!':
        result = !operand;
        break;
      case '~':
        result = ~Number(operand);
        break;
      case 'typeof':
        result = typeof operand;
        break;
      case 'void':
        result = undefined;
        break;
      default:
        return this.runtime(path);
    }
    return typeof result === 'number' ? this.staticNumber(path, result) : literal(result);
  }

  private evaluateBinary(path: NodePath<t.BinaryExpression>): EvaluatedValue {
    const leftPath = this.child(path, 'left');
    const rightPath = this.child(path, 'right');
    if (leftPath === undefined || rightPath === undefined || !isExpressionPath(leftPath) || !isExpressionPath(rightPath)) {
      return this.runtime(path);
    }
    const left = this.evaluateExpression(leftPath);
    const right = this.evaluateExpression(rightPath);
    if (!isLiteral(left) || !isLiteral(right)) return this.runtime(path);
    // The operands are restricted to primitive values above. Keeping these
    // values as `any` is only a TypeScript escape hatch for JavaScript's
    // primitive coercion rules; no user object can reach this switch.
    const a: any = left.value;
    const b: any = right.value;
    let result: EvaluatedPrimitive;
    try {
      switch (path.node.operator) {
        case '+': result = a + b; break;
        case '-': result = a - b; break;
        case '*': result = a * b; break;
        case '/': result = a / b; break;
        case '%': result = a % b; break;
        case '**': result = a ** b; break;
        case '<': result = a < b; break;
        case '<=': result = a <= b; break;
        case '>': result = a > b; break;
        case '>=': result = a >= b; break;
        case '==': result = a == b; break; // eslint-disable-line eqeqeq
        case '!=': result = a != b; break; // eslint-disable-line eqeqeq
        case '===': result = a === b; break;
        case '!==': result = a !== b; break;
        case '|': result = (a as number) | (b as number); break;
        case '&': result = (a as number) & (b as number); break;
        case '^': result = (a as number) ^ (b as number); break;
        case '<<': result = (a as number) << (b as number); break;
        case '>>': result = (a as number) >> (b as number); break;
        case '>>>': result = (a as number) >>> (b as number); break;
        default: return this.runtime(path);
      }
    } catch {
      return this.runtime(path);
    }
    return typeof result === 'number' ? this.staticNumber(path, result) : literal(result);
  }

  private evaluateLogical(path: NodePath<t.LogicalExpression>): EvaluatedValue {
    const leftPath = this.child(path, 'left');
    const rightPath = this.child(path, 'right');
    if (leftPath === undefined || rightPath === undefined || !isExpressionPath(leftPath) || !isExpressionPath(rightPath)) {
      return this.runtime(path);
    }
    const left = this.evaluateExpression(leftPath);
    const truthy = isTruthy(left);
    if (truthy === undefined || (isStructural(left) && left.effects.length !== 0)) return this.runtime(path);
    const shouldEvaluateRight = path.node.operator === '&&' ? truthy : path.node.operator === '||' ? !truthy : isLiteral(left) && (left.value === null || left.value === undefined);
    if (!shouldEvaluateRight) return left;
    const right = this.evaluateExpression(rightPath);
    return isRuntime(right) ? this.runtime(path) : right;
  }

  private evaluateConditional(path: NodePath<t.ConditionalExpression>): EvaluatedValue {
    const testPath = this.child(path, 'test');
    const consequentPath = this.child(path, 'consequent');
    const alternatePath = this.child(path, 'alternate');
    if (testPath === undefined || consequentPath === undefined || alternatePath === undefined ||
      !isExpressionPath(testPath) || !isExpressionPath(consequentPath) || !isExpressionPath(alternatePath)) {
      return this.runtime(path);
    }
    const test = this.evaluateExpression(testPath);
    const truthy = isTruthy(test);
    if (truthy === undefined || (isStructural(test) && test.effects.length !== 0)) return this.runtime(path);
    const selected = this.evaluateExpression(truthy ? consequentPath : alternatePath);
    return isRuntime(selected) ? this.runtime(path) : selected;
  }

  private evaluateTemplate(path: NodePath<t.TemplateLiteral>): EvaluatedValue {
    const expressions = path.get('expressions') as NodePathLike[];
    const pieces: string[] = [];
    for (let index = 0; index < path.node.quasis.length; index += 1) {
      pieces.push(path.node.quasis[index]?.value.cooked ?? path.node.quasis[index]?.value.raw ?? '');
      const expression = expressions[index];
      if (expression === undefined) continue;
      if (!isExpressionPath(expression)) return this.runtime(path);
      const value = this.evaluateExpression(expression);
      const text = primitiveString(value);
      if (text === undefined) return this.runtime(path);
      pieces.push(text);
    }
    return literal(pieces.join(''));
  }

  private evaluateSequence(path: NodePath<t.SequenceExpression>): EvaluatedValue {
    const expressions = path.get('expressions') as NodePathLike[];
    let result: EvaluatedValue = literal(undefined);
    for (const expression of expressions) {
      if (!isExpressionPath(expression)) return this.runtime(path);
      result = this.evaluateExpression(expression);
      if (isRuntime(result) || (isStructural(result) && result.effects.length !== 0)) return this.runtime(path);
    }
    return result;
  }

  private evaluateArray(path: NodePath<t.ArrayExpression>): EvaluatedValue {
    const elements = path.get('elements') as NodePathLike[];
    const items: EvaluatedValue[] = [];
    const effects: RuntimeExpression[] = [];
    for (const element of elements) {
      if (element.node === null) {
        items.push(literal(undefined));
        continue;
      }
      if (element.node.type === 'SpreadElement') {
        const argument = this.child(element, 'argument');
        if (argument === undefined || !isExpressionPath(argument)) return this.runtime(path);
        const spread = this.evaluateExpression(argument);
        if (isRuntime(spread)) return this.runtime(path);
        if (spread.kind === 'array') {
          items.push(...spread.items);
          effects.push(...spread.effects);
          continue;
        }
        if (isLiteral(spread) && typeof spread.value === 'string') {
          items.push(...Array.from(spread.value, (character) => literal(character)));
          continue;
        }
        return this.runtime(path);
      }
      if (!isExpressionPath(element)) return this.runtime(path);
      const value = this.evaluateExpression(element);
      items.push(value);
      effects.push(...effectsOf(value));
    }
    return { kind: 'array', items, effects };
  }

  private evaluateObject(path: NodePath<t.ObjectExpression>): EvaluatedValue {
    const entries: [string, EvaluatedValue][] = [];
    const positions: Map<string, number> = new Map();
    const effects: RuntimeExpression[] = [];
    const properties = path.get('properties') as NodePathLike[];
    for (const property of properties) {
      if (property.node === null) return this.runtime(path);
      if (property.node.type === 'SpreadElement') {
        const argument = this.child(property, 'argument');
        if (argument === undefined || !isExpressionPath(argument)) return this.runtime(path);
        const spread = this.evaluateExpression(argument);
        if (isRuntime(spread)) return this.runtime(path);
        effects.push(...effectsOf(spread));
        const spreadEntries = this.objectEntries(spread);
        if (spreadEntries === undefined) continue;
        for (const [key, value] of spreadEntries) this.setEntry(entries, positions, key, value);
        continue;
      }
      if (property.node.type !== 'ObjectProperty') return this.runtime(path);
      const key = this.evaluateObjectKey(property);
      if (key === undefined) return this.runtime(path);
      const valuePath = this.child(property, 'value');
      if (valuePath === undefined || !isExpressionPath(valuePath)) return this.runtime(path);
      const value = this.evaluateExpression(valuePath);
      effects.push(...effectsOf(value));
      this.setEntry(entries, positions, key, value);
    }
    return { kind: 'object', entries, effects };
  }

  private evaluateObjectKey(property: NodePathLike): string | undefined {
    const node = property.node;
    if (node === null || node.type !== 'ObjectProperty') return undefined;
    if (!node.computed) {
      return isPropertyNameNode(node.key)
        ? node.key.type === 'Identifier' ? node.key.name : String(node.key.value)
        : undefined;
    }
    const keyPath = this.child(property, 'key');
    if (keyPath === undefined || !isExpressionPath(keyPath)) return undefined;
    return propertyKey(this.evaluateExpression(keyPath));
  }

  private setEntry(entries: [string, EvaluatedValue][], positions: Map<string, number>, key: string, value: EvaluatedValue): void {
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, entries.length);
      entries.push([key, value]);
    } else {
      entries[position] = [key, value];
    }
  }

  private objectEntries(value: EvaluatedValue): readonly (readonly [string, EvaluatedValue])[] | undefined {
    if (value.kind === 'object') return value.entries;
    if (value.kind === 'array') return value.items.map((item, index) => [String(index), item] as const);
    if (value.kind === 'literal') {
      if (value.value === null || value.value === undefined || typeof value.value !== 'string') return [];
      return [...value.value].map((character, index) => [String(index), literal(character)] as const);
    }
    return undefined;
  }

  private evaluateMember(path: NodePath<t.MemberExpression | t.OptionalMemberExpression>): EvaluatedValue {
    const objectPath = this.child(path, 'object');
    if (objectPath === undefined || !isExpressionPath(objectPath)) return this.runtime(path);
    const object = this.evaluateExpression(objectPath);
    if (isRuntime(object)) return this.runtime(path);
    if (isStructural(object) && object.effects.length !== 0) return this.runtime(path);
    let key: string | undefined;
    if (path.node.computed) {
      const propertyPath = this.child(path, 'property');
      if (propertyPath === undefined || !isExpressionPath(propertyPath)) return this.runtime(path);
      key = propertyKey(this.evaluateExpression(propertyPath));
    } else {
      const property = path.node.property;
      key = property.type === 'Identifier' ? property.name : undefined;
    }
    if (key === undefined) return this.runtime(path);
    return this.readMember(object, key, path);
  }

  private readMember(object: EvaluatedValue, key: string, path: NodePathLike): EvaluatedValue {
    if (object.kind === 'object') {
      const entry = object.entries.find(([entryKey]) => entryKey === key);
      if (entry !== undefined) return entry[1];
      if (key === 'toString' || key === 'constructor' || key === '__proto__') return this.runtime(path);
      return literal(undefined);
    }
    if (object.kind === 'array') {
      if (key === 'length') return literal(object.items.length);
      if (/^(?:0|[1-9][0-9]*)$/.test(key)) {
        const index = Number(key);
        return object.items[index] ?? literal(undefined);
      }
      return this.runtime(path);
    }
    if (object.kind !== 'literal') return this.runtime(path);
    if (typeof object.value === 'string') {
      if (key === 'length') return literal(object.value.length);
      if (/^(?:0|[1-9][0-9]*)$/.test(key)) return literal(object.value[Number(key)]);
    }
    return this.runtime(path);
  }

  private findPattern(path: NodePathLike, target: t.Identifier): PatternLookup | undefined {
    if (path.node === null) return undefined;
    switch (path.node.type) {
      case 'Identifier':
        return path.node === target ? { segments: [] } : undefined;
      case 'AssignmentPattern': {
        const left = this.child(path, 'left');
        const result = left === undefined ? undefined : this.findPattern(left, target);
        if (result === undefined) return undefined;
        const right = this.child(path, 'right');
        return right !== undefined && isExpressionPath(right) ? { ...result, defaultPath: right } : result;
      }
      case 'ObjectPattern': {
        const properties = path.get('properties') as NodePathLike[];
        for (const property of properties) {
          if (property.node?.type !== 'ObjectProperty') continue;
          const key = this.evaluateObjectKey(property);
          if (key === undefined) continue;
          const value = this.child(property, 'value');
          if (value === undefined) continue;
          const result = this.findPattern(value, target);
          if (result !== undefined) return { ...result, segments: [['object', key], ...result.segments] };
        }
        return undefined;
      }
      case 'ArrayPattern': {
        const elements = path.get('elements') as NodePathLike[];
        for (let index = 0; index < elements.length; index += 1) {
          const element = elements[index];
          if (element === undefined || element.node === null || element.node.type === 'RestElement') continue;
          const result = this.findPattern(element, target);
          if (result !== undefined) return { ...result, segments: [['array', index], ...result.segments] };
        }
        return undefined;
      }
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSTypeAssertion':
      case 'TSNonNullExpression':
        return this.findPattern(this.child(path, 'expression') ?? path, target);
      default:
        return undefined;
    }
  }

  private readPatternValue(value: EvaluatedValue, lookup: PatternLookup, usePath: NodePathLike): EvaluatedValue {
    if (isStructural(value) && value.effects.length !== 0) return this.runtime(usePath);
    let result = value;
    for (const segment of lookup.segments) {
      const [kind, key] = segment;
      if (kind === 'object') {
        if (result.kind !== 'object') return this.runtime(usePath);
        const entry = result.entries.find(([entryKey]) => entryKey === key);
        result = entry?.[1] ?? literal(undefined);
      } else {
        if (result.kind !== 'array') return this.runtime(usePath);
        result = result.items[Number(key)] ?? literal(undefined);
      }
      if (isRuntime(result)) return this.runtime(usePath);
    }
    if (isLiteral(result) && result.value === undefined && lookup.defaultPath !== undefined) {
      return this.evaluateExpression(lookup.defaultPath);
    }
    return result;
  }

  private referencesResolvingBinding(binding: Binding): boolean {
    for (const active of this.resolvingBindings) {
      const name = active.identifier.name;
      if (binding.referencePaths.some((reference) => reference.scope.getBinding(name) === active)) return true;
    }
    return false;
  }

  /**
   * `const` makes the binding immutable, but it does not freeze an object. A
   * structural constant is only safe to project when all other references are
   * reads or static spreads. Passing it to a call, assigning through it, or
   * storing it in another binding can change what a later member read observes.
  */
  private hasStructuralEscape(binding: Binding, current: NodePath<t.Identifier>): boolean {
    return binding.referencePaths.some((reference) => reference.node !== current.node &&
      this.referenceEscapes(reference as NodePath<t.Identifier>));
  }

  /**
   * A structural value read as another binding's initializer is an alias. A
   * const binding cannot freeze that object, so projecting the initializer at
   * a later style site could observe a mutation or a different alias. Member
   * reads that end in a primitive remain safe (`const color = palette.color`).
   */
  private hasStructuralStorage(path: NodePath<t.Identifier>, resolved: EvaluatedValue): boolean {
    let value = resolved;
    let expression: NodePath<t.Node> = path as NodePath<t.Node>;
    while (true) {
      const parent = expression.parentPath as NodePath<t.Node> | null;
      if (parent === null) break;
      if ((parent.isMemberExpression() || parent.isOptionalMemberExpression())
        && parent.node.object === expression.node) {
        const key = parent.node.computed
          ? (() => {
            const property = this.child(parent, 'property');
            return property !== undefined && isExpressionPath(property)
              ? propertyKey(this.evaluateExpression(property)) : undefined;
          })()
          : parent.node.property.type === 'Identifier' ? parent.node.property.name : undefined;
        if (key === undefined) return false;
        value = this.readMember(value, key, parent);
        expression = parent;
        continue;
      }
      if (parent.isTSAsExpression() || parent.isTSSatisfiesExpression() || parent.isTSTypeAssertion()
        || parent.isTSNonNullExpression() || parent.isTypeCastExpression()
        || parent.isParenthesizedExpression()) {
        expression = parent;
        continue;
      }
      break;
    }
    if (!isStructural(value)) return false;

    const parent = expression.parentPath as NodePath<t.Node> | null;
    if (parent?.isObjectProperty() && parent.node.value === expression.node) return true;
    if (parent?.isArrayExpression()) return true;
    return parent?.isVariableDeclarator() === true && parent.node.init === expression.node;
  }

  private referenceEscapes(reference: NodePath<t.Identifier>): boolean {
    let parent: NodePath<t.Node> | null = reference.parentPath as NodePath<t.Node> | null;
    if (parent === null) return true;

    // TypeScript wrappers do not change whether the value escapes.
    while (parent.isTSAsExpression() || parent.isTSSatisfiesExpression() ||
      parent.isTSTypeAssertion() || parent.isTSNonNullExpression() || parent.isTypeCastExpression()) {
      parent = parent.parentPath as NodePath<t.Node> | null;
      if (parent === null) return true;
    }

    if (parent.isSpreadElement() && parent.node.argument === reference.node) {
      const container = parent.parentPath?.node;
      return container?.type !== 'ObjectExpression' && container?.type !== 'ArrayExpression';
    }
    if (parent.isConditionalExpression() && parent.node.test === reference.node) return false;
    if (parent.isLogicalExpression() && parent.node.left === reference.node) return false;
    if (parent.isUnaryExpression() && parent.node.argument === reference.node &&
      (parent.node.operator === '!' || parent.node.operator === 'typeof' || parent.node.operator === 'void')) return false;

    // Walk a member chain (`p.x.y = ...`) to inspect the operation applied to
    // the final read. A direct member read is safe; a write/method call/alias is
    // an escape of the underlying object.
    if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && parent.node.object === reference.node) {
      let expression: NodePath<t.Node> = parent as NodePath<t.Node>;
      let outer = expression.parentPath;
      while (outer !== null && (outer.isMemberExpression() || outer.isOptionalMemberExpression()) &&
        outer.node.object === expression.node) {
        expression = outer as NodePath<t.Node>;
        outer = outer.parentPath;
      }
      if (outer === null) return false;
      if (outer.isAssignmentExpression() && outer.node.left === expression.node) return true;
      if (outer.isUpdateExpression()) return true;
      if (outer.isUnaryExpression() && outer.node.operator === 'delete') return true;
      if (outer.isCallExpression() || outer.isOptionalCallExpression() || outer.isNewExpression() ||
        outer.isTaggedTemplateExpression()) return true;
      if (outer.isObjectProperty() && outer.node.value === expression.node) return true;
      if (outer.isArrayExpression()) return true;
      return false;
    }

    return true;
  }

  private child(path: NodePathLike, key: string): NodePathLike | undefined {
    if (path.node === null) return undefined;
    const child = (asNodePath(path).get as (name: string) => NodePathLike | NodePathLike[])(key);
    return Array.isArray(child) ? undefined : child;
  }
}

/** Evaluate a style expression without executing arbitrary JavaScript. */
export function evaluateStatic(
  path: NodePath<t.Expression>,
  module: ParsedStyleModule,
  options: EvaluateStaticOptions = {},
): EvaluatedValue {
  // Traversal is imported here so that callers can pass a path obtained from a
  // parsed module even when no prior visitor has forced Babel to crawl scopes.
  // A Program path already has its scope in normal use; crawl is idempotent.
  const program = module.program;
  if (program.scope.crawling === false) program.scope.crawl();
  return new StaticEvaluator(module, options).evaluate(path);
}
