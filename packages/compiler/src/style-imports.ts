import MagicString from 'magic-string';
import { parseStyleModule } from './parse.js';

/** Replace only runtime named style imports; all other Qwik bindings retain their source. */
export function rewriteStyleImports(code: string, file: string, replacement: string, generatedPack = false, serverReplacement?: string): { code: string; map: ReturnType<MagicString['generateMap']> } | undefined {
  const parsed = parseStyleModule(code, file);
  const output = new MagicString(code);
  let changed = false;
  if (generatedPack) {
    const hooks: number[] = [];
    parsed.program.traverse({ CallExpression(path) {
      if (path.node.callee.type !== 'Identifier' || path.node.callee.name !== 'useStyles$') return;
      const binding = path.scope.getBinding('useStyles$');
      if (binding?.path.node.type !== 'ImportSpecifier' || binding.path.parent.type !== 'ImportDeclaration'
        || binding.path.parent.source.value !== '@qwik.dev/core') return;
      const args = path.node.arguments;
      if (args.length !== 1 || args[0]?.type !== 'StringLiteral') {
        throw new Error('Generated StylePack requires one literal useStyles$ argument.');
      }
      hooks.push(args[0].end!);
    } });
    if (hooks.length !== 1) throw new Error('Generated StylePack requires exactly one useStyles$ hook.');
    output.appendLeft(hooks[0]!, ',true');
  }
  parsed.program.traverse({ ImportDeclaration(path) {
    const node = path.node;
    const server = node.source.value === '@qwik.dev/core/server' && serverReplacement;
    if ((!server && node.source.value !== '@qwik.dev/core') || node.importKind === 'type') return;
    const selected = node.specifiers.filter((item) => item.type === 'ImportSpecifier' && item.importKind !== 'type'
      && (server ? ['renderToString', 'renderToStream'] : ['useStyles$', 'useStylesScoped$']).includes(item.imported.type === 'Identifier' ? item.imported.name : item.imported.value));
    if (!selected.length) return;
    const retained = node.specifiers.filter((item) => !selected.includes(item));
    const importText = (items: typeof node.specifiers, source: string): string => {
      const normal = items.filter((item) => item.type !== 'ImportSpecifier').map((item) => code.slice(item.start!, item.end!));
      const named = items.filter((item) => item.type === 'ImportSpecifier').map((item) => code.slice(item.start!, item.end!));
      if (named.length) normal.push(`{${named.join(',')}}`);
      return `import ${normal.join(',')} from ${JSON.stringify(source)}${code.slice(node.source.end!, node.end!)}`;
    };
    output.overwrite(node.start!, node.end!, `${retained.length ? importText(retained, node.source.value) + '\n' : ''}${importText(selected, server || replacement)}`);
    changed = true;
  } });
  if (!changed) return;
  return { code: output.toString(), map: output.generateMap({ hires: true, source: file, includeContent: true }) };
}
