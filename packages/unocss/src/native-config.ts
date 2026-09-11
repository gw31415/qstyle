import { access, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { loadConfig } from '@unocss/config';
import { parseStyleModule, type UtilityAdapterFactory, type UtilitySession } from '@qstyle/compiler';
import { NativeStyleError } from '@qstyle/core';
import { createNativeUnoAdapter } from './native-adapter.js';

export interface NativeUnoOptions {
  readonly configFile?: string;
}

async function configDependencies(entries: readonly string[]): Promise<readonly string[]> {
  const seen = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (file.split('\\').join('/').includes('/node_modules/')) return;
    if (seen.has(file)) return;
    seen.add(file);
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    const module = parseStyleModule(await readFile(file, 'utf8'), file);
    const imports = new Set<string>();
    module.program.traverse({
      ImportDeclaration(path) {
        if (path.node.importKind !== 'type' && (path.node.specifiers.length === 0 ||
          path.node.specifiers.some((specifier) => specifier.type !== 'ImportSpecifier' || specifier.importKind !== 'type'))) {
          imports.add(path.node.source.value);
        }
      },
      ExportNamedDeclaration(path) {
        if (path.node.source && path.node.exportKind !== 'type' && (path.node.specifiers.length === 0 ||
          path.node.specifiers.some((specifier) => specifier.type !== 'ExportSpecifier' || specifier.exportKind !== 'type'))) {
          imports.add(path.node.source.value);
        }
      },
      ExportAllDeclaration(path) { if (path.node.exportKind !== 'type') imports.add(path.node.source.value); },
      ImportExpression(path) {
        if (path.node.source.type !== 'StringLiteral') throw new NativeStyleError({ code: 'QS1401', message: `Uno config imports must have statically known paths: ${file}.` });
        imports.add(path.node.source.value);
      },
      CallExpression(path) {
        if (path.node.callee.type === 'Identifier' && path.node.callee.name === 'require' && !path.scope.getBinding('require')) {
          if (path.node.arguments[0]?.type !== 'StringLiteral') throw new NativeStyleError({ code: 'QS1401', message: `Uno config requires must have statically known paths: ${file}.` });
          imports.add(path.node.arguments[0].value);
        }
      },
    });
    for (const specifier of imports) {
      // Package dependencies are versioned install inputs. Local config modules
      // change during a dev session and must be watched recursively.
      if (!specifier.startsWith('.') && !isAbsolute(specifier)) continue;
      const base = resolve(dirname(file), specifier);
      const extensions = ['', '.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];
      const candidates = [...extensions.map((extension) => base + extension),
        ...(/\.[cm]?js$/.test(base) ? [base.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts')] : []),
        ...extensions.slice(1).map((extension) => resolve(base, 'index' + extension))];
      let target: string | undefined;
      for (const candidate of candidates) {
        if (await stat(candidate).then((value) => value.isFile(), () => false)) { target = candidate; break; }
      }
      if (!target) throw new NativeStyleError({ code: 'QS1401', message: `Unresolved Uno config dependency ${specifier} from ${file}.` });
      await visit(target);
    }
  };
  for (const entry of entries) await visit(entry);
  return [...seen].sort();
}

/** Build adapter factory. No Vite plugin, JSX rewrite or independent CSS emitter is created. */
export function unocss(options: NativeUnoOptions = {}): UtilityAdapterFactory {
  return { name: 'unocss', async create(root: string): Promise<UtilitySession> {
    const configPath = options.configFile ? resolve(root, options.configFile) : root;
    if (options.configFile) await access(configPath);
    const loaded = await loadConfig(root, configPath);
    const adapter = await createNativeUnoAdapter(loaded.config);
    const dependencies = await configDependencies([...loaded.sources, ...(loaded.dependencies ?? [])]);
    // Include absent default candidates so adding the first config also replaces
    // the generation. These are @unocss/config + unconfig's supported names.
    const candidates = options.configFile ? [configPath] : ['unocss.config', 'uno.config'].flatMap((name) =>
      ['mts', 'cts', 'ts', 'mjs', 'cjs', 'js', 'json', ''].map((extension) => resolve(root, name + (extension ? `.${extension}` : ''))));
    return { watchFiles: [...new Set([...dependencies, ...candidates])].sort(),
      resolve: (states) => adapter.resolve(states),
    };
  } };
}
