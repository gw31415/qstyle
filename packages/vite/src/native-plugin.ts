import { dirname, extname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { Plugin, ResolvedConfig, Rolldown, ViteDevServer } from 'vite';
import { NativeStyleError } from '@qstyle/core';
import type { UtilityAdapterFactory, UtilitySession } from '@qstyle/compiler';
import { buildStyleGraph, transformGraphModule, type FrozenStyleGraph } from './graph.js';
import { createNativeModules, retainDevelopmentOwners, type NativeModule } from './native.js';
import { createNativeReport } from './native-report.js';
import { createNativeStyleAdapter } from './native-style-adapter.js';

const compilerVersion: string = (createRequire(import.meta.url)('@qstyle/compiler/package.json') as { version: string }).version;

interface DiscoveryContext {
  resolve(source: string, importer?: string, options?: { skipSelf: boolean }): Promise<{ id: string; external?: unknown } | null>;
  load(options: { id: string }): Promise<{ code: string | null } | null>;
  addWatchFile(id: string): void;
  environment?: { name: string; plugins?: readonly Plugin[]; config?: { consumer?: 'client' | 'server' };
    pluginContainer?: { load(id: string): Promise<string | { code: string } | null | void> } };
}

interface Generation {
  readonly graph: FrozenStyleGraph;
  readonly native: ReadonlyMap<string, NativeModule>;
  readonly packModules: ReadonlyMap<string, string>;
  readonly utilities?: UtilitySession;
  readonly discoveryMs: number;
}

export interface NativeQstyleOptions {
  readonly utilities?: UtilityAdapterFactory;
  /** Additional local report file, written only after a successful output write. */
  readonly report?: { readonly file: string; readonly sources?: boolean };
}

/** Native compiler with the package-owned Qwik style and SSR adapter. */
export function qstyleNative(options: NativeQstyleOptions = {}): [Plugin, Plugin] {
  return [createNativeCompilerPlugin(options), createNativeStyleAdapter()];
}

/** Compiler-only control for internal differential fixtures. */
export function createNativeCompilerPlugin(options: NativeQstyleOptions = {}): Plugin {
  if (options.report && (typeof options.report.file !== 'string' || options.report.file.trim() === '')) {
    throw new NativeStyleError({ code: 'QS1401', message: 'report.file must be a nonempty file path.' });
  }
  let config: ResolvedConfig;
  let devServer: ViteDevServer | undefined;
  let generation = 0;
  const generations = new Map<string, Generation>();
  const pending = new Map<string, Promise<Generation>>();
  const environment = (context: DiscoveryContext): string => context.environment?.name ?? 'default';
  const plugins = (context: DiscoveryContext): readonly Plugin[] => context.environment?.plugins ?? config.plugins;
  const virtualId = (id: string): string => resolve(config.root, '.qstyle/native', id.slice('virtual:qstyle-native:'.length));
  const loadRouterSource = async (context: DiscoveryContext, id: string, provider: Plugin): Promise<string | undefined> => {
    const hook = typeof provider.load === 'function' ? provider.load : provider.load?.handler;
    const loaded = await hook?.call(context as never, id);
    return typeof loaded === 'string' ? loaded : loaded?.code;
  };
  const entries = async (context: DiscoveryContext): Promise<{ inputs: string[]; generated?: { id: string; code: string } }> => {
    const adapters = plugins(context).filter((plugin) => plugin.name.startsWith('vite-plugin-qwik-router-ssg-'));
    if (environment(context) === 'ssg'
      && adapters.length > 0) {
      if (adapters.length !== 1) throw new NativeStyleError({ code: 'QS1401',
        message: 'Style discovery requires one unambiguous Qwik Router SSG source provider.' });
      // Router emits this entry from buildStart instead of putting it in input.
      // Resolve the adapter's actual generated source; do not guess entry.ssr.
      const worker = await context.resolve('@qwik-ssg-worker-entry', undefined, { skipSelf: true });
      if (!worker || worker.external || !worker.id.startsWith('\0')) throw new NativeStyleError({
        code: 'QS1401', message: 'Qwik Router must expose its generated SSG worker before style discovery.',
      });
      const adapter = adapters[0]!;
      // Rolldown cannot preload emitted chunks during buildStart. The adapter's
      // load hook is the source provider; invoke it with the real plugin context
      // to obtain the worker before any Qwik transforms run.
      const code = await loadRouterSource(context, worker.id, adapter);
      if (typeof code !== 'string') throw new NativeStyleError({ code: 'QS1401',
        message: 'Qwik Router did not provide the generated SSG worker source.' });
      return { inputs: ['@qwik-ssg-worker-entry'], generated: { id: worker.id, code } };
    }
    const qwik = plugins(context).find((plugin) => plugin.name === 'vite-plugin-qwik');
    const options = qwik?.api?.getOptions?.() as { input?: string[] | string; srcDir?: string } | undefined;
    const input = options?.input ?? config.build.rolldownOptions?.input;
    if (typeof input === 'string') return { inputs: [resolve(config.root, input)] };
    if (Array.isArray(input)) return { inputs: input.map((id) => resolve(config.root, id)) };
    if (input && typeof input === 'object') return { inputs: Object.values(input).map((id) => resolve(config.root, id)) };
    throw new NativeStyleError({ code: 'QS1401', message: 'Qwik must expose its application inputs before style discovery.' });
  };
  const refresh = async (context: DiscoveryContext): Promise<Generation> => {
    const key = environment(context);
    const existing = pending.get(key);
    if (existing) return existing;
    const work = (async (): Promise<Generation> => {
      const started = performance.now();
      const utilities = await options.utilities?.create(config.root);
      const entry = await entries(context);
      let graph = await buildStyleGraph({ root: config.root, entries: entry.inputs,
        ...(plugins(context).some((plugin) => plugin.name === 'vite-plugin-qwik-router')
          ? { discoveryEntries: ['@qwik-router-config'] } : {}),
        development: config.command === 'serve',
        ...(utilities ? { utilities } : {}),
        resolve: async (source, importer) => {
          const resolved = await context.resolve(source, importer, { skipSelf: true });
          // This framework registry contains optimizer-generated RPC symbols,
          // not authored style sites. Its route sources are already discovered
          // through the Router config's own imports.
          return resolved ? { id: resolved.id, external: Boolean(resolved.external)
            || (importer === '@qwik-router-config' && resolved.id === '\0virtual:qwik-router-server-fns') } : undefined;
        },
        loadVirtual: async (id) => {
          if (id === entry.generated?.id) return entry.generated.code;
          // Dev has a real plugin-container loader, including hotUpdate's
          // minimal context adapter; provider hooks need not be invoked there.
          if (config.command === 'serve' && context.environment?.pluginContainer) {
            const loaded = await context.environment.pluginContainer.load(id);
            return typeof loaded === 'string' ? loaded : loaded?.code;
          }
          const providerName = id === '@qwik-router-config' ? 'vite-plugin-qwik-router'
            : id === '@qwik.dev/core/build' ? 'vite-plugin-qwik' : undefined;
          const provider = providerName && plugins(context).find((plugin) => plugin.name === providerName);
          if (provider) return loadRouterSource(context, id, provider);
          return (await context.load({ id }))?.code ?? undefined;
        },
      }, ++generation);
      if (config.command === 'serve') graph = { ...graph,
        program: retainDevelopmentOwners(graph.program, generations.get(key)?.graph.program),
      };
      const modules = createNativeModules(graph.program.packs, config.command === 'serve');
      const native = new Map(modules.map((module) => [virtualId(module.id), module]));
      const packModules = new Map(modules.map((module) => [module.packId, module.id]));
      const result = { graph, native, packModules, discoveryMs: performance.now() - started,
        ...(utilities ? { utilities } : {}) };
      for (const id of graph.modules.keys()) if (id.startsWith('/')) context.addWatchFile(id);
      for (const id of utilities?.watchFiles ?? []) context.addWatchFile(id);
      generations.set(key, result);
      return result;
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  };
  const finalReportPlugin = (key: string, fileName: string): Pick<Rolldown.Plugin, 'name' | 'generateBundle' | 'writeBundle'> => ({
    name: 'qstyle-native-report',
    generateBundle: { order: 'post', handler(_output, bundle) {
      const current = generations.get(key);
      if (!current) throw new NativeStyleError({ code: 'QS1401', message: 'No frozen graph for final artifact audit.' });
      const projectRequire = createRequire(resolve(config.root, 'package.json'));
      const version = (name: string): string => {
        try { return (projectRequire(`${name}/package.json`) as { version: string }).version; }
        catch { return 'unresolved'; }
      };
      const report = createNativeReport(current.graph, bundle, {
        root: config.root, compilerVersion,
        targetVersions: { qwik: version('@qwik.dev/core'), vite: version('vite') },
        timings: { discoveryMs: current.discoveryMs },
        sources: options.report?.sources ?? false,
      });
      // Output plugins run after Qwik's input-plugin post hooks, including
      // manifest generation and final chunk rewrites, even with write:false.
      this.emitFile({ type: 'asset', fileName, source: `${JSON.stringify(report, null, 2)}\n` });
      const failure = report.diagnostics.find((item) => item.code === 'QS1301'
        || item.code === 'QS1601' || item.code === 'QS1602');
      if (failure) throw new NativeStyleError(failure);
      if (report.duplicateDefinitionCount || report.duplicatePayloadCount) throw new NativeStyleError({
        code: 'QS1601', message: 'Final native CSS definitions or browser payloads are duplicated.',
      });
    } },
    async writeBundle(_output, bundle) {
      if (!options.report) return;
      const asset = bundle[fileName];
      if (asset?.type !== 'asset') throw new NativeStyleError({ code: 'QS1401', message: 'Final report asset is missing.' });
      const extension = extname(options.report.file);
      const suffix = fileName.slice('qstyle-report'.length, -'.json'.length);
      const path = resolve(config.root, suffix
        ? `${options.report.file.slice(0, extension ? -extension.length : undefined)}${suffix}${extension}`
        : options.report.file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, asset.source);
    },
  });
  return {
    name: 'qstyle-native', enforce: 'pre',
    api: { getGraph: (name = 'default') => generations.get(name)?.graph },
    configEnvironment: { order: 'post', handler(name, environmentConfig, env) {
      const consumer = environmentConfig.consumer ?? (name === 'client' ? 'client' : 'server');
      if (env.command !== 'build' || consumer !== 'client') return;
      const existing = environmentConfig.build?.rolldownOptions?.output;
      const outputs = Array.isArray(existing) ? existing : [existing ?? {}];
      const output = outputs.map((item, index) => ({ ...item, plugins: [
        ...(item.plugins ? [item.plugins] : []),
        finalReportPlugin(name, outputs.length === 1 ? 'qstyle-report.json' : `qstyle-report.${index}.json`),
      ] }));
      return { build: { rolldownOptions: { output: Array.isArray(existing) ? output : output[0]! } } };
    } },
    configResolved(resolved) {
      config = resolved;
      const self = config.plugins.findIndex((plugin) => plugin.name === 'qstyle-native');
      const qwik = config.plugins.findIndex((plugin) => plugin.name === 'vite-plugin-qwik');
      if (qwik < 0 || self >= qwik) throw new NativeStyleError({ code: 'QS1501',
        message: 'Place qstyle before qwikVite so style macros are compiled before Qwik extraction.' });
    },
    configureServer(server) { devServer = server; },
    buildStart: { order: 'post', sequential: true, async handler() { await refresh(this as unknown as DiscoveryContext); } },
    resolveId(id) {
      if (id.startsWith('virtual:qstyle-native:')) return virtualId(id);
      // Qwik's dev segments import their original module by absolute path.
      // That original is virtual too; filesystem resolution cannot find it.
      const directory = resolve(config.root, '.qstyle/native') + '/';
      if (id.startsWith(directory) && /^[a-f0-9]{32}\.tsx$/.test(id.slice(directory.length))) return id;
      if (/^\/\.qstyle\/native\/[a-f0-9]{32}\.tsx$/.test(id)) return resolve(config.root, `.${id}`);
      return;
    },
    load(id) {
      const context = this as unknown as DiscoveryContext;
      return generations.get(environment(context))?.native.get(id)?.source;
    },
    async transform(code, id) {
      if (!/\.[cm]?[jt]sx?$/.test(id) || id.startsWith(resolve(config.root, '.qstyle/native'))) return;
      const context = this as unknown as DiscoveryContext;
      const current = generations.get(environment(context)) ?? await refresh(context);
      return transformGraphModule(current.graph, id, code, { dev: config.command === 'serve', packModule: (pack) => {
        const module = current.packModules.get(pack);
        if (!module) throw new NativeStyleError({ code: 'QS1401', message: `Missing native module for ${pack}.` });
        return module;
      } });
    },
    async hotUpdate(context) {
      const key = environment(this as unknown as DiscoveryContext);
      const previous = generations.get(key);
      if (!previous || (!previous.graph.modules.has(context.file) && !previous.utilities?.watchFiles.includes(context.file))) return;
      // hotUpdate has Vite's minimal context, unlike build/transform hooks.
      const next = await refresh({
        environment: this.environment,
        resolve: (source, importer) => this.environment.pluginContainer.resolveId(source, importer),
        load: async ({ id }) => {
          const loaded = await this.environment.pluginContainer.load(id);
          return { code: typeof loaded === 'string' ? loaded : loaded?.code ?? null };
        },
        addWatchFile: (id) => { devServer?.watcher.add(id); },
      });
      const changed = new Set(context.modules);
      const graph = this.environment.moduleGraph;
      for (const [id, module] of next.native) {
        if (previous.native.get(id)?.source === module.source) continue;
        const loaded = graph.getModuleById(id);
        if (loaded) { graph.invalidateModule(loaded); changed.add(loaded); }
      }
      // Global class optimization can change an importer whose own source did not change.
      for (const [id, analysis] of next.graph.analyses) {
        if (!analysis.sites.length && !analysis.foundation) continue;
        const loaded = graph.getModuleById(id);
        if (loaded) { graph.invalidateModule(loaded); changed.add(loaded); }
      }
      return [...changed];
    },
    closeBundle() {
      if (!devServer) { generations.clear(); pending.clear(); }
    },
  };
}
