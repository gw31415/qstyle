import type { Binding, NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import MagicString from 'magic-string';
import { parseStyleModule } from './parse.js';

export interface StyleImportRetryRender {
  readonly code: string;
  readonly map: ReturnType<MagicString['generateMap']>;
}

export interface StyleImportRetryPlan {
  /** The literal dependency loaded by the generated StylePack QRL. */
  readonly dependency: string;
  /** Render the owner with a caller-provided URL expression for retrying the dependency. */
  readonly render: (urlExpression: string) => StyleImportRetryRender;
}

interface NamedImport {
  readonly binding: Binding;
  readonly declaration: NodePath<t.ImportDeclaration>;
  readonly specifier: NodePath<t.ImportSpecifier>;
  readonly local: string;
}

interface RetryCandidate {
  readonly dependency: string;
  readonly dynamicImport: NodePath<t.ImportExpression>;
  readonly hookImport: NamedImport;
}

type CandidateResult = RetryCandidate | 'malformed' | undefined;

function importedNamedBinding(
  path: NodePath<t.Node>, source: string, imported: string,
): NamedImport | undefined {
  if (!path.isIdentifier()) return undefined;
  const binding = path.scope.getBinding(path.node.name);
  if (!binding || !binding.path.isImportSpecifier()) return undefined;
  const specifier = binding.path;
  const declaration = specifier.parentPath;
  if (!declaration?.isImportDeclaration() || declaration.node.source.value !== source) return undefined;
  if (declaration.node.importKind === 'type' || specifier.node.importKind === 'type') return undefined;
  const importedName = specifier.node.imported.type === 'Identifier'
    ? specifier.node.imported.name : specifier.node.imported.value;
  if (importedName !== imported) return undefined;
  return { binding, declaration, specifier, local: specifier.node.local.name };
}

function dynamicImportFromArrow(
  arrow: NodePath<t.ArrowFunctionExpression>,
): NodePath<t.ImportExpression> | undefined {
  if (arrow.node.async || arrow.node.params.length !== 0) return undefined;
  const body = arrow.get('body');
  if (body.isImportExpression() && body.node.source.type === 'StringLiteral') return body;
  if (!body.isBlockStatement() || body.node.body.length !== 1) return undefined;
  const statement = body.get('body.0');
  if (!statement.isReturnStatement() || !statement.node.argument) return undefined;
  const argument = statement.get('argument');
  if (argument.isImportExpression() && argument.node.source.type === 'StringLiteral') return argument;
  return undefined;
}

function candidateForMarkedHook(
  call: NodePath<t.CallExpression>, hookImport: NamedImport,
): CandidateResult {
  const args = call.node.arguments;
  if (args.length !== 2 || args[1]?.type !== 'BooleanLiteral' || args[1].value !== true) return 'malformed';
  const qrlArgument = args[0];
  if (!qrlArgument || qrlArgument.type !== 'Identifier') return 'malformed';

  const qrlBinding = call.scope.getBinding(qrlArgument.name);
  // A local or namespace qrl is authored code, even when someone happens to
  // pass the generated marker. It is not evidence that this is a StylePack.
  if (!qrlBinding?.path.isVariableDeclarator() || !qrlBinding.constant) return undefined;
  const declarator = qrlBinding.path;
  if (!declarator.node.id || declarator.node.id.type !== 'Identifier' || !declarator.node.init) return undefined;
  if (!declarator.node.init || declarator.node.init.type !== 'CallExpression') return undefined;

  const init = declarator.get('init');
  if (!init.isCallExpression()) return undefined;
  const callee = init.get('callee');
  if (!callee.isIdentifier()) return undefined;
  if (!importedNamedBinding(callee, '@qwik.dev/core', 'qrl')) return undefined;

  const firstArgument = init.get('arguments.0');
  if (!firstArgument || Array.isArray(firstArgument) || !firstArgument.isArrowFunctionExpression()) return 'malformed';
  const dynamicImport = dynamicImportFromArrow(firstArgument);
  if (!dynamicImport) return 'malformed';
  return {
    dependency: (dynamicImport.node.source as t.StringLiteral).value,
    dynamicImport,
    hookImport,
  };
}

function allBindingNames(program: NodePath<t.Program>): Set<string> {
  const names = new Set<string>();
  program.traverse({ ReferencedIdentifier(path) {
    // Adding an import must not capture an existing free/global reference.
    names.add(path.node.name);
  }, Scope(path) {
    for (const name of Object.keys(path.scope.bindings)) names.add(name);
  } });
  return names;
}

function localNameForRetry(
  candidate: RetryCandidate, program: NodePath<t.Program>, runtime: string,
): { readonly local: string; readonly addImport: boolean } {
  // Reuse an existing runtime import when it is visible at the generated QRL.
  let existing: NamedImport | undefined;
  program.traverse({ ImportSpecifier(path) {
    if (existing || path.node.importKind === 'type') return;
    const declaration = path.parentPath;
    if (!declaration?.isImportDeclaration() || declaration.node.source.value !== runtime
      || declaration.node.importKind === 'type') return;
    const imported = path.node.imported.type === 'Identifier' ? path.node.imported.name : path.node.imported.value;
    if (imported !== 'retryStyleImport') return;
    const binding = path.scope.getBinding(path.node.local.name);
    if (binding) existing = { binding, declaration, specifier: path, local: path.node.local.name };
  } });
  if (existing && candidate.dynamicImport.scope.getBinding(existing.local) === existing.binding) {
    return { local: existing.local, addImport: false };
  }

  const names = allBindingNames(program);
  let local = 'retryStyleImport';
  let suffix = 1;
  while (names.has(local) || candidate.dynamicImport.scope.getBinding(local)) local = `retryStyleImport_${suffix++}`;
  return { local, addImport: true };
}

function addRetryImport(
  output: MagicString, candidate: RetryCandidate, local: string, runtime: string,
): void {
  const importedText = local === 'retryStyleImport' ? local : `retryStyleImport as ${local}`;
  const specifiers = candidate.hookImport.declaration.node.specifiers;
  const lastNamed = [...specifiers].reverse().find((specifier) => specifier.type === 'ImportSpecifier');
  if (lastNamed?.end != null) {
    output.appendLeft(lastNamed.end, `, ${importedText}`);
    return;
  }
  output.appendLeft(candidate.hookImport.declaration.node.start ?? 0,
    `import { ${importedText} } from ${JSON.stringify(runtime)};\n`);
}

/**
 * Recognize and prepare the generated StylePack owner used for CSS import retry.
 *
 * The marker is the second `true` argument to an imported `useStylesQrl` call.
 * Every other hook shape is ignored, while a marked but malformed hook causes
 * this function to return no plan rather than guessing at authored code.
 */
export function planStyleImportRetry(
  code: string, file: string, runtime: string,
): StyleImportRetryPlan | undefined {
  const module = parseStyleModule(code, file);
  const hookImports: NamedImport[] = [];
  module.program.traverse({ ImportSpecifier(path) {
    const declaration = path.parentPath;
    if (!declaration?.isImportDeclaration() || declaration.node.source.value !== runtime
      || declaration.node.importKind === 'type' || path.node.importKind === 'type') return;
    const imported = path.node.imported.type === 'Identifier' ? path.node.imported.name : path.node.imported.value;
    if (imported !== 'useStylesQrl') return;
    const binding = path.scope.getBinding(path.node.local.name);
    if (binding) hookImports.push({ binding, declaration, specifier: path, local: path.node.local.name });
  } });
  if (!hookImports.length) return undefined;

  const marked: RetryCandidate[] = [];
  let malformed = false;
  module.program.traverse({ CallExpression(path) {
    if (path.node.callee.type !== 'Identifier') return;
    const hookBinding = path.scope.getBinding(path.node.callee.name);
    const hookImport = hookImports.find((item) => item.binding === hookBinding);
    if (!hookImport) return;
    const args = path.node.arguments;
    if (args[1]?.type !== 'BooleanLiteral' || args[1].value !== true) return;
    const candidate = candidateForMarkedHook(path, hookImport);
    if (candidate === 'malformed') malformed = true;
    else if (candidate) marked.push(candidate);
  } });
  if (malformed) {
    throw new Error('Generated StylePack has a malformed marked useStylesQrl hook.');
  }
  if (marked.length > 1) {
    throw new Error('Generated StylePack requires exactly one marked useStylesQrl hook.');
  }
  if (marked.length === 0) return undefined;
  const candidate = marked[0]!;
  const names = localNameForRetry(candidate, module.program, runtime);

  return {
    dependency: candidate.dependency,
    render(urlExpression: string): StyleImportRetryRender {
      const output = new MagicString(code);
      const importStart = candidate.dynamicImport.node.start;
      const importEnd = candidate.dynamicImport.node.end;
      if (importStart == null || importEnd == null) return {
        code: output.toString(),
        map: output.generateMap({ hires: true, source: file, includeContent: true }),
      };
      const originalImport = code.slice(importStart, importEnd);
      output.overwrite(importStart, importEnd,
        `${names.local}(()=>${originalImport}, ${urlExpression})`);
      if (names.addImport) addRetryImport(output, candidate, names.local, runtime);
      return {
        code: output.toString(),
        map: output.generateMap({ hires: true, source: file, includeContent: true }),
      };
    },
  };
}
