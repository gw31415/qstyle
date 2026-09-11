import type { Binding, NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { NativeStyleError } from '@qstyle/core';
import { resolveImportedBinding } from './bindings.js';
import { sourceSpan, type ParsedStyleModule } from './parse.js';

export type DocumentEntry =
  | { readonly kind: 'head'; readonly opening: NodePath<t.JSXOpeningElement> }
  | { readonly kind: 'reference'; readonly source: string; readonly imported: string };

/** Alias kept for callers that name the result after the resolver operation. */
export type DocumentEntryResolution = DocumentEntry;

type CallablePath = NodePath<t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression>;
type Result = DocumentEntry | undefined;
type ImportedTarget = { readonly source: string; readonly imported: string };

interface JsxScan {
  readonly heads: NodePath<t.JSXOpeningElement>[];
  readonly components: NodePath<t.JSXElement>[];
  conditionalHead: boolean;
  conditionalComponent: boolean;
}

/** Resolve the document head reachable from one statically known module export. */
export function resolveDocumentEntry(module: ParsedStyleModule, exportName = 'default'): DocumentEntry | undefined {
  const resolvingBindings = new Set<Binding>();
  const resolvingCallables = new Set<t.Node>();

  const reject = (node: t.Node, message: string): never => {
    throw new NativeStyleError({ code: 'QS1103', message, source: sourceSpan(module.file, node) });
  };

  const unwrap = (input: NodePath<t.Node>): NodePath<t.Node> => {
    let path = input;
    for (;;) {
      if (!path.isParenthesizedExpression() && !path.isTSAsExpression() && !path.isTSSatisfiesExpression()
        && !path.isTSTypeAssertion() && !path.isTSNonNullExpression() && !path.isTypeCastExpression()) return path;
      const child = path.get('expression');
      if (!child || Array.isArray(child) || !child.isExpression()) return path;
      path = child as NodePath<t.Node>;
    }
  };

  const expressionArgument = (call: NodePath<t.CallExpression>, index: number): NodePath<t.Expression> | undefined => {
    const argument = call.get('arguments')[index];
    return argument && argument.isExpression() ? argument as NodePath<t.Expression> : undefined;
  };

  const objectKey = (property: NodePath<t.ObjectProperty | t.ObjectMethod>): string | undefined => {
    const key = property.node.key;
    if (property.node.computed) {
      if (key.type === 'StringLiteral' || key.type === 'NumericLiteral') return String(key.value);
      return undefined;
    }
    if (key.type === 'Identifier') return key.name;
    if (key.type === 'StringLiteral' || key.type === 'NumericLiteral') return String(key.value);
    return undefined;
  };

  const importedTarget = (input: NodePath<t.Node>, seen = new Set<Binding>()): ImportedTarget | undefined => {
    const path = unwrap(input);
    const direct = resolveImportedBinding(path);
    if (direct) return { source: direct.source, imported: direct.imported };
    if (!path.isIdentifier()) return undefined;
    const binding = path.scope.getBinding(path.node.name);
    if (!binding || binding.kind !== 'const' || !binding.constant || !binding.path.isVariableDeclarator() || seen.has(binding)) return undefined;
    const init = binding.path.get('init');
    if (!init.isExpression()) return undefined;
    const next = new Set(seen); next.add(binding);
    return importedTarget(init as NodePath<t.Node>, next);
  };

  const callableReturn = (callable: CallablePath): NodePath<t.Expression> | undefined => {
    const body = callable.get('body');
    if (!body.isBlockStatement()) return body.isExpression() ? body as NodePath<t.Expression> : undefined;
    const direct = body.get('body').filter((statement): statement is NodePath<t.ReturnStatement> => statement.isReturnStatement());
    const returns: NodePath<t.ReturnStatement>[] = [];
    body.traverse({
      Function(path) { path.skip(); },
      Class(path) { path.skip(); },
      ReturnStatement(path) { returns.push(path); },
    });
    if (direct.length !== 1) {
      if (returns.length > 0) reject(callable.node, 'A document entry must have one unconditional top-level return.');
      return undefined;
    }
    if (returns.length !== 1) reject(callable.node, 'A document entry cannot return from a conditional or loop.');
    const argument = direct[0]!.get('argument');
    return argument && argument.isExpression() ? argument as NodePath<t.Expression> : undefined;
  };

  const scanJsxExpression = (input: NodePath<t.Node>, result: JsxScan, conditional: boolean): void => {
    const path = unwrap(input);
    if (path.isJSXElement() || path.isJSXFragment()) { scanJsx(path, result, conditional); return; }
    if (path.isConditionalExpression()) {
      const consequent = path.get('consequent'); const alternate = path.get('alternate');
      if (consequent.isExpression()) scanJsxExpression(consequent, result, true);
      if (alternate.isExpression()) scanJsxExpression(alternate, result, true);
      return;
    }
    if (path.isLogicalExpression()) {
      const left = path.get('left'); const right = path.get('right');
      if (left.isExpression()) scanJsxExpression(left, result, true);
      if (right.isExpression()) scanJsxExpression(right, result, true);
      return;
    }
    if (path.isArrayExpression()) {
      for (const element of path.get('elements')) {
        if (element.node && element.isExpression()) scanJsxExpression(element, result, true);
      }
    }
  };

  function scanJsx(path: NodePath<t.JSXElement | t.JSXFragment>, result: JsxScan, conditional: boolean): void {
    if (path.isJSXElement()) {
      const opening = path.get('openingElement');
      const name = opening.node.name;
      if (name.type === 'JSXIdentifier' && name.name === 'head') {
        if (conditional) result.conditionalHead = true;
        else result.heads.push(opening);
        return;
      }
      const component = (name.type === 'JSXIdentifier' && !/^[a-z]/.test(name.name))
        || name.type === 'JSXMemberExpression';
      if (component) {
        if (conditional) result.conditionalComponent = true;
        else result.components.push(path);
      } else if (name.type !== 'JSXIdentifier' || name.name !== 'html') {
        // A document head cannot be recovered from an ordinary DOM subtree.
        // In particular, a body/template containing a component or head is
        // application content rather than the document root.
        return;
      }
      for (const child of path.get('children')) {
        if (child.isJSXElement() || child.isJSXFragment()) scanJsx(child, result, conditional);
        else if (child.isJSXExpressionContainer()) {
          const expression = child.get('expression');
          if (expression.isExpression()) scanJsxExpression(expression, result, conditional);
        }
      }
      return;
    }
    for (const child of path.get('children')) {
      if (child.isJSXElement() || child.isJSXFragment()) scanJsx(child, result, conditional);
      else if (child.isJSXExpressionContainer()) {
        const expression = child.get('expression');
        if (expression.isExpression()) scanJsxExpression(expression, result, conditional);
      }
    }
  }

  function resolveJsxComponent(element: NodePath<t.JSXElement>): Result {
    const opening = element.get('openingElement');
    const name = opening.get('name');
    if (!name.isJSXIdentifier()) return undefined;
    const binding = name.scope.getBinding(name.node.name);
    return binding ? resolveBinding(binding) : undefined;
  }

  function resolveJsx(path: NodePath<t.JSXElement | t.JSXFragment>): Result {
    const scan: JsxScan = { heads: [], components: [], conditionalHead: false, conditionalComponent: false };
    scanJsx(path, scan, false);
    if (scan.conditionalHead) reject(path.node, 'A document head must be unconditional.');
    if (scan.conditionalComponent) reject(path.node, 'A document root component must be unconditional.');
    if (scan.heads.length > 1) reject(path.node, 'A document entry must contain one document head.');
    if (scan.heads.length === 1) return { kind: 'head', opening: scan.heads[0]! };
    if (scan.components.length > 1) reject(path.node, 'A document entry has multiple unresolved component roots.');
    return scan.components.length === 1 ? resolveJsxComponent(scan.components[0]!) : undefined;
  }

  /**
   * Resolve a value that is already rendered JSX. Function definitions and
   * component$ factories are deliberately excluded here: they are definitions
   * which may be resolved when they are exported, but returning one from a
   * document callable does not render it.
   */
  function resolveRenderedValue(input: NodePath<t.Node>, seen = new Set<Binding>()): Result {
    const path = unwrap(input);
    if (path.isJSXElement() || path.isJSXFragment()) return resolveJsx(path);
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding || binding.kind !== 'const' || !binding.constant || !binding.path.isVariableDeclarator() || seen.has(binding)) {
        return undefined;
      }
      const init = binding.path.get('init');
      if (!init.isExpression()) return undefined;
      const next = new Set(seen); next.add(binding);
      return resolveRenderedValue(init as NodePath<t.Node>, next);
    }
    if (path.isCallExpression() && isPublicRender(importedTarget(path.get('callee')))) {
      const argument = expressionArgument(path, 0);
      return argument ? resolveRenderedValue(argument) : undefined;
    }
    return undefined;
  }

  function resolveRendererObject(input: NodePath<t.Node>, seen = new Set<Binding>(), field = 'jsx'): Result {
    const path = unwrap(input);
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding || binding.kind !== 'const' || !binding.constant || !binding.path.isVariableDeclarator() || seen.has(binding)) return undefined;
      if (binding.path.parentPath?.parentPath?.isExportNamedDeclaration()
        || binding.referencePaths.some((reference) => reference.node !== path.node)) {
        reject(path.node, `A renderer options alias cannot escape or be mutated before resolving ${field}.`);
      }
      const init = binding.path.get('init');
      if (!init.isExpression()) return undefined;
      const next = new Set(seen); next.add(binding);
      return resolveRendererObject(init as NodePath<t.Node>, next, field);
    }
    if (!path.isObjectExpression()) return undefined;
    let jsx: NodePath<t.Expression> | undefined;
    for (const property of path.get('properties')) {
      if (property.isSpreadElement()) {
        if (jsx) reject(property.node, `A renderer result cannot have an unknown spread after ${field}.`);
        continue;
      }
      if (!property.isObjectProperty() && !property.isObjectMethod()) return undefined;
      const key = objectKey(property as NodePath<t.ObjectProperty | t.ObjectMethod>);
      if (key === undefined) {
        if (jsx) reject(property.node, `A renderer result cannot have an unknown computed property after ${field}.`);
        continue;
      }
      if (key !== field) continue;
      if (!property.isObjectProperty()) return undefined;
      const value = property.get('value');
      if (!value.isExpression()) return undefined;
      jsx = value as NodePath<t.Expression>;
    }
    return jsx ? field === 'render' ? resolveNode(jsx) : resolveRenderedValue(jsx) : undefined;
  }

  function resolveRendererCallback(input: NodePath<t.Node>, seen = new Set<Binding>()): Result {
    const path = unwrap(input);
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding || binding.kind !== 'const' || !binding.constant || !binding.path.isVariableDeclarator() || seen.has(binding)) return undefined;
      const init = binding.path.get('init');
      if (!init.isExpression()) return undefined;
      const next = new Set(seen); next.add(binding);
      return resolveRendererCallback(init as NodePath<t.Node>, next);
    }
    if (!path.isArrowFunctionExpression() && !path.isFunctionExpression()) return undefined;
    const callable = path as CallablePath;
    if (callable.node.async || callable.node.generator) reject(callable.node, 'A createRenderer callback must be synchronous.');
    const returned = callableReturn(callable);
    return returned ? resolveRendererObject(returned) : undefined;
  }

  function isPublicRender(target: ImportedTarget | undefined): boolean {
    return target?.source === '@qwik.dev/core/server' && (target.imported === 'renderToString' || target.imported === 'renderToStream');
  }

  function isMiddlewareFactory(target: ImportedTarget | undefined): boolean {
    if (target?.source === '@qwik.dev/router/ssg' && target.imported === 'startWorker') return true;
    return !!target && /^@qwik\.dev\/router\/middleware\/[^/]+$/.test(target.source)
      && (target.imported === 'createQwikRouter' || target.imported === 'createQwikCity');
  }

  function resolveCall(path: NodePath<t.CallExpression>): Result {
    const target = importedTarget(path.get('callee'));
    const argument = expressionArgument(path, 0);
    if (target?.source === '@qwik.dev/core' && target.imported === 'component$') {
      if (!argument) return undefined;
      const callback = unwrap(argument);
      if (!callback.isArrowFunctionExpression() && !callback.isFunctionExpression()) return undefined;
      const callable = callback as CallablePath;
      if (callable.node.async || callable.node.generator) reject(callable.node, 'A document root component must be synchronous.');
      const returned = callableReturn(callable);
      return returned ? resolveRenderedValue(returned) : undefined;
    }
    if (isPublicRender(target)) return argument ? resolveRenderedValue(argument) : undefined;
    if (target?.source === '@qwik.dev/router' && target.imported === 'createRenderer') {
      return argument ? resolveRendererCallback(argument) : undefined;
    }
    if (isMiddlewareFactory(target)) return argument ? resolveRendererObject(argument, new Set(), 'render') : undefined;
    return undefined;
  }

  function resolveCallable(path: CallablePath): Result {
    if (resolvingCallables.has(path.node)) return undefined;
    resolvingCallables.add(path.node);
    try {
      let returned = callableReturn(path);
      if (!returned) return undefined;
      let candidate = unwrap(returned);
      if (path.node.async && candidate.isAwaitExpression()) {
        const argument = candidate.get('argument');
        if (argument.isExpression()) candidate = unwrap(argument);
      }
      if (path.node.generator || (path.node.async && !candidate.isCallExpression())) {
        reject(path.node, 'A document entry must be synchronous or return a public Qwik render call.');
      }
      return resolveRenderedValue(candidate);
    } finally {
      resolvingCallables.delete(path.node);
    }
  }

  function resolveBinding(binding: Binding): Result {
    const importPath = binding.path;
    if (importPath.isImportSpecifier() || importPath.isImportDefaultSpecifier() || importPath.isImportNamespaceSpecifier()) {
      const declaration = importPath.parentPath;
      if (!declaration?.isImportDeclaration()) return undefined;
      const imported = importPath.isImportSpecifier()
        ? (importPath.node.imported.type === 'Identifier' ? importPath.node.imported.name : importPath.node.imported.value)
        : importPath.isImportDefaultSpecifier() ? 'default' : '*';
      return { kind: 'reference', source: declaration.node.source.value, imported };
    }
    if (resolvingBindings.has(binding)) return undefined;
    if (importPath.isFunctionDeclaration()) {
      if (!binding.constant) reject(importPath.node, 'Document entry aliases must be immutable local bindings.');
      return resolveCallable(importPath as CallablePath);
    }
    if (!binding.constant || binding.kind !== 'const' || !importPath.isVariableDeclarator()) {
      reject(importPath.node, 'Document entry aliases must be immutable local bindings.');
    }
    resolvingBindings.add(binding);
    try {
      const init = importPath.get('init');
      return init.isExpression() ? resolveNode(init as NodePath<t.Node>) : undefined;
    } finally {
      resolvingBindings.delete(binding);
    }
  }

  function resolveNode(input: NodePath<t.Node>): Result {
    const path = unwrap(input);
    if (path.isJSXElement() || path.isJSXFragment()) return resolveJsx(path);
    if (path.isFunctionDeclaration() || path.isFunctionExpression() || path.isArrowFunctionExpression()) return resolveCallable(path as CallablePath);
    if (path.isCallExpression()) return resolveCall(path);
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      return binding ? resolveBinding(binding) : undefined;
    }
    return undefined;
  }

  function resolveExportDeclaration(declaration: NodePath<t.Node>, name: string): Result {
    const id = declaration.isFunctionDeclaration()
      ? declaration.node.id
      : declaration.isVariableDeclaration()
        ? declaration.get('declarations').find((variable) => variable.node.id.type === 'Identifier' && variable.node.id.name === name)?.node.id as t.Identifier | undefined
        : undefined;
    if (!id) return undefined;
    const binding = declaration.scope.getBinding(id.name);
    return binding ? resolveBinding(binding) : undefined;
  }

  function exportLabel(node: t.Identifier | t.StringLiteral): string {
    return node.type === 'Identifier' ? node.name : node.value;
  }

  for (const statement of module.program.get('body')) {
    if (statement.isExportDefaultDeclaration()) {
      const declaration = statement.get('declaration');
      if (exportName !== 'default') continue;
      // Edge adapters may export an object of handlers constructed at module
      // scope. Their render input is recovered from the middleware factory below.
      if (declaration.isExpression() && !declaration.isObjectExpression()) return resolveNode(declaration as NodePath<t.Node>);
      if (declaration.isFunctionDeclaration()) {
        return declaration.node.id
          ? resolveExportDeclaration(declaration as NodePath<t.Node>, declaration.node.id.name)
          : resolveNode(declaration as NodePath<t.Node>);
      }
      continue;
    }
    if (!statement.isExportNamedDeclaration()) continue;
    const declaration = statement.get('declaration');
    if (declaration?.isFunctionDeclaration() && declaration.node.id?.name === exportName) {
      return resolveExportDeclaration(declaration as NodePath<t.Node>, exportName);
    }
    if (declaration?.isVariableDeclaration()) {
      for (const variable of declaration.get('declarations')) {
        if (variable.node.id.type !== 'Identifier' || variable.node.id.name !== exportName) continue;
        return resolveExportDeclaration(declaration as NodePath<t.Node>, exportName);
      }
    }
    for (const specifier of statement.get('specifiers')) {
      if (!specifier.isExportSpecifier() || exportLabel(specifier.node.exported) !== exportName) continue;
      const source = statement.node.source?.value;
      const imported = exportLabel(specifier.node.local);
      if (source) return { kind: 'reference', source, imported };
      const local = specifier.get('local');
      return local.isExpression() ? resolveNode(local as NodePath<t.Node>) : undefined;
    }
    if (exportName !== 'default' && statement.isExportNamedDeclaration() && statement.node.source && statement.node.specifiers.length === 0) {
      return { kind: 'reference', source: statement.node.source.value, imported: exportName };
    }
  }
  if (exportName !== 'default') return undefined;
  const middleware: DocumentEntry[] = [];
  module.program.traverse({
    Function(path) { path.skip(); },
    Class(path) { path.skip(); },
    CallExpression(path) {
      if (!isMiddlewareFactory(importedTarget(path.get('callee')))) return;
      for (let parent: NodePath<t.Node> | null = path.parentPath; parent && !parent.isProgram(); parent = parent.parentPath) {
        if (parent.isConditionalExpression() || parent.isLogicalExpression() || parent.isIfStatement()
          || parent.isSwitchStatement() || parent.isLoop() || parent.isTryStatement()) {
          reject(path.node, 'A middleware document renderer must be constructed unconditionally at module scope.');
        }
      }
      const argument = expressionArgument(path, 0);
      const result = argument ? resolveRendererObject(argument, new Set(), 'render') : undefined;
      if (result) middleware.push(result);
      else reject(path.node, 'Cannot prove the static render binding of the Qwik middleware factory.');
    },
  });
  const unique = new Map<string | t.Node, DocumentEntry>();
  for (const result of middleware) unique.set(result.kind === 'head'
    ? result.opening.node : JSON.stringify([result.source, result.imported]), result);
  if (unique.size > 1) reject(module.program.node, 'An adapter input must declare one statically known middleware document renderer.');
  if (unique.size === 1) return unique.values().next().value;
  return undefined;
}
