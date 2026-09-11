import type { Binding, NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { NativeStyleError, type SourceSpan } from '@qstyle/core';
import { sourceSpan, type ParsedStyleModule } from './parse.js';

export interface ImportedBinding {
  readonly source: string;
  readonly imported: string;
  readonly binding: Binding;
}

/** Resolve lexical imports, including namespace access, without matching spelling alone. */
export function resolveImportedBinding(path: NodePath<t.Node>): ImportedBinding | undefined {
  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    if (!binding || !binding.path.parentPath?.isImportDeclaration()) return undefined;
    const source = binding.path.parentPath.node.source.value;
    if (binding.path.isImportSpecifier()) {
      const imported = binding.path.node.imported;
      return { source, imported: imported.type === 'Identifier' ? imported.name : imported.value, binding };
    }
    if (binding.path.isImportDefaultSpecifier()) return { source, imported: 'default', binding };
    if (binding.path.isImportNamespaceSpecifier()) return { source, imported: '*', binding };
  }
  if (path.isMemberExpression() && !path.node.computed) {
    const object = resolveImportedBinding(path.get('object'));
    if (object?.imported === '*' && path.node.property.type === 'Identifier') {
      return { ...object, imported: path.node.property.name };
    }
  }
  return undefined;
}

export function isCssMacro(path: NodePath<t.Node>): boolean {
  const imported = resolveImportedBinding(path);
  return imported?.source === '@qstyle/qwik' && imported.imported === 'css';
}

export function isQwikComponent(path: NodePath<t.Node>): boolean {
  const imported = resolveImportedBinding(path);
  return imported?.source === '@qwik.dev/core' && imported.imported === 'component$';
}

export interface ComponentOwner {
  readonly id: string;
  readonly callback: NodePath<t.ArrowFunctionExpression | t.FunctionExpression>;
  readonly source: SourceSpan;
}

export function findComponentOwner(path: NodePath<t.Node>, module: ParsedStyleModule): ComponentOwner {
  for (let cursor: NodePath<t.Node> | null = path; cursor; cursor = cursor.parentPath) {
    if (!cursor.isArrowFunctionExpression() && !cursor.isFunctionExpression()) continue;
    const parent = cursor.parentPath;
    if (parent?.isCallExpression() && isQwikComponent(parent.get('callee'))) {
      if (cursor.node.async || cursor.node.generator) {
        throw new NativeStyleError({ code: 'QS1103', message: 'A style owner must be a synchronous Qwik component callback.', source: sourceSpan(module.file, cursor.node) });
      }
      return { id: `${module.file}#component:${parent.node.start}`, callback: cursor,
        source: sourceSpan(module.file, parent.node) };
    }
    // An inline synchronous map return remains within its lexical component.
    if (parent?.isCallExpression()) {
      const callee = parent.get('callee');
      if (callee.isMemberExpression() && !callee.node.computed && callee.node.property.type === 'Identifier'
        && callee.node.property.name === 'map' && !cursor.node.async && !cursor.node.generator) continue;
    }
    throw new NativeStyleError({
      code: 'QS1103', message: 'Move styled JSX returned by an arbitrary function into an explicit component$ boundary.',
      source: sourceSpan(module.file, cursor.node),
    });
  }
  throw new NativeStyleError({ code: 'QS1103', message: 'Styled JSX requires a component$ render owner.', source: sourceSpan(module.file, path.node) });
}

export interface CssPropSite {
  readonly id: string;
  readonly owner: ComponentOwner;
  readonly attribute: NodePath<t.JSXAttribute>;
  readonly opening: NodePath<t.JSXOpeningElement>;
  readonly expression: NodePath<t.Expression>;
  readonly source: SourceSpan;
}

export function collectCssPropSites(module: ParsedStyleModule): readonly CssPropSite[] {
  const sites: CssPropSite[] = [];
  module.program.traverse({
    JSXAttribute(attribute) {
      if (attribute.node.name.type !== 'JSXIdentifier' || attribute.node.name.name !== 'css') return;
      const opening = attribute.parentPath;
      if (!opening.isJSXOpeningElement()) return;
      const tag = opening.node.name;
      if (tag.type !== 'JSXIdentifier' || !/^[a-z]/.test(tag.name)) {
        throw new NativeStyleError({ code: 'QS1103', message: 'Apply css to a DOM element, not a component or Slot.', source: sourceSpan(module.file, opening.node) });
      }
      const value = attribute.get('value');
      if (!value.isJSXExpressionContainer()) {
        throw new NativeStyleError({ code: 'QS1102', message: 'The css prop requires a style expression.', source: sourceSpan(module.file, attribute.node) });
      }
      const expression = value.get('expression');
      if (!expression.isExpression()) {
        throw new NativeStyleError({ code: 'QS1102', message: 'The css prop cannot be empty.', source: sourceSpan(module.file, attribute.node) });
      }
      sites.push({ id: `${module.file}#css:${attribute.node.start}`, owner: findComponentOwner(attribute, module),
        attribute, opening, expression, source: sourceSpan(module.file, attribute.node) });
    },
  });
  return sites;
}

/** Compiler-only handles cannot escape into QRL captures or arbitrary runtime APIs. */
export function validateAuthoringUses(module: ParsedStyleModule): void {
  const checked = new Set<Binding>();
  const failUse = (path: NodePath<t.Node>): never => {
    throw new NativeStyleError({ code: 'QS1102', message: 'A compile-time style handle escapes into runtime code.',
      source: sourceSpan(module.file, path.node), fixHint: 'Use the handle directly in css or another static style composition.' });
  };
  const acceptedContext = (reference: NodePath<t.Node>): boolean => {
    for (let path: NodePath<t.Node> | null = reference; path; path = path.parentPath) {
      if (path.isJSXAttribute()) return path.node.name.type === 'JSXIdentifier' && path.node.name.name === 'css';
      if (path.isCallExpression()) return isCssMacro(path.get('callee'));
      if (path.isTaggedTemplateExpression()) return isCssMacro(path.get('tag'));
      if (path.isMemberExpression() || path.isObjectProperty() || path.isAssignmentExpression()
        || path.isUpdateExpression() || path.isFunction()) return false;
      if (path.isTSTypeQuery()) return true;
      if (path.isVariableDeclarator()) {
        if (path.node.id.type !== 'Identifier') return false;
        const binding = path.scope.getBinding(path.node.id.name);
        if (!binding || binding.kind !== 'const' || !binding.constant) return false;
        inspect(binding);
        return true;
      }
      if (path.isExportSpecifier() || path.isExportNamedDeclaration()) return module.file.endsWith('.qstyle.ts');
    }
    return false;
  };
  const inspect = (binding: Binding): void => {
    if (checked.has(binding)) return;
    checked.add(binding);
    if (binding.kind !== 'const' || !binding.constant) failUse(binding.path);
    if (binding.path.parentPath?.parentPath?.isExportNamedDeclaration() && !module.file.endsWith('.qstyle.ts')) {
      failUse(binding.path);
    }
    for (const reference of binding.referencePaths) if (!acceptedContext(reference)) failUse(reference);
  };
  const inspectMacro = (path: NodePath<t.CallExpression | t.TaggedTemplateExpression>): void => {
    const parent = path.parentPath;
    if (parent?.isVariableDeclarator() && parent.node.id.type === 'Identifier') {
      const binding = parent.scope.getBinding(parent.node.id.name);
      if (!binding) return failUse(path);
      inspect(binding);
    } else if (parent?.isExpressionStatement()) {
      // A statically validated, unused macro is erasable; lower validates purity.
    } else if (!acceptedContext(parent ?? path)) failUse(path);
  };
  module.program.traverse({
    CallExpression(path) { if (isCssMacro(path.get('callee'))) inspectMacro(path); },
    TaggedTemplateExpression(path) { if (isCssMacro(path.get('tag'))) inspectMacro(path); },
  });
}
