import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvironmentOptions, Plugin, ResolvedConfig, Rolldown } from 'vite';
import { build } from 'vite';
import type { UtilityAdapterFactory } from '@qstyle/compiler';
import { createNativeCompilerPlugin as qstyleNative } from './native-plugin.js';
import type { FrozenStyleGraph } from './graph.js';

type WorkerResolution = { readonly id: string; readonly external?: unknown } | null;

interface Fixture {
  readonly root: string;
  readonly configuredRoot: string;
  readonly workerRoot: string;
  readonly workerId: string;
  readonly workerSource: string;
}

interface DiscoveryContext {
  readonly environment?: { readonly name: string };
  readonly resolve: (source: string, importer?: string, options?: { skipSelf: boolean }) => Promise<WorkerResolution>;
  readonly load: ReturnType<typeof vi.fn>;
  readonly addWatchFile: ReturnType<typeof vi.fn>;
}

const utilities: UtilityAdapterFactory = {
  name: 'native-plugin-test-utilities',
  async create() {
    return {
      watchFiles: [],
      async resolve() {
        return { foundation: [{ kind: 'layer-order', names: ['reset', 'utilities'] }], states: [] };
      },
    };
  },
};

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'qstyle-native-plugin-'));
  const source = join(root, 'src');
  mkdirSync(source, { recursive: true });
  const configuredRoot = join(source, 'root-a.tsx');
  const workerRoot = join(source, 'root-b.tsx');
  const workerId = '\0virtual:qwik-router-ssg-worker';
  writeFileSync(configuredRoot, 'export default function RootA(){return <><head/><body/></>}');
  writeFileSync(workerRoot, 'export default function RootB(){return <><head/><body/></>}');
  const workerSource = `import {startWorker} from '@qwik.dev/router/ssg';
    import render from ${JSON.stringify(workerRoot)};
    startWorker({render});`;
  return { root, configuredRoot, workerRoot, workerId, workerSource };
}

function configFor(fixtureValue: Fixture, qstyle: Plugin, router: Plugin): ResolvedConfig {
  const qwik = {
    name: 'vite-plugin-qwik',
    api: { getOptions: () => ({ input: fixtureValue.configuredRoot }) },
  } as unknown as Plugin;
  return {
    command: 'build',
    mode: 'production',
    root: fixtureValue.root,
    plugins: [qstyle, qwik, router],
    build: { rolldownOptions: { input: fixtureValue.configuredRoot } },
  } as unknown as ResolvedConfig;
}

function contextFor(
  fixtureValue: Fixture,
  worker: WorkerResolution,
  environmentName?: string,
): DiscoveryContext {
  const resolve = vi.fn(async (source: string) => {
    if (source === '@qwik-ssg-worker-entry') return worker;
    if (source === fixtureValue.workerRoot || source === fixtureValue.configuredRoot) {
      return { id: source };
    }
    if (source.startsWith('@qwik.dev/')) return { id: source, external: true };
    return null;
  });
  const load = vi.fn(async () => ({ code: null }));
  const addWatchFile = vi.fn();
  return {
    ...(environmentName === undefined ? {} : { environment: { name: environmentName } }),
    resolve,
    load,
    addWatchFile,
  };
}

async function buildStart(plugin: Plugin, context: DiscoveryContext): Promise<void> {
  const hook = plugin.buildStart as unknown as { handler(this: unknown): Promise<void> };
  await hook.handler.call(context);
}

function configure(plugin: Plugin, config: ResolvedConfig): void {
  const hook = plugin.configResolved as unknown as (config: ResolvedConfig) => void;
  hook(config);
}

function graphOf(plugin: Plugin, name: string) {
  const getGraph = (plugin.api as { getGraph: (environment?: string) => unknown }).getGraph;
  return getGraph(name) as FrozenStyleGraph | undefined;
}

function configureEnvironment(plugin: Plugin, name: string, config: EnvironmentOptions = {}): EnvironmentOptions | undefined {
  const hook = plugin.configEnvironment as unknown as {
    handler(name: string, config: EnvironmentOptions, env: { command: string }): EnvironmentOptions | undefined;
  };
  return hook.handler(name, config, { command: 'build' });
}

function reportBundle(graph: FrozenStyleGraph) {
  const symbols = Object.fromEntries(graph.program.packs.map((pack, index) => [`style${index}`,
    { ctxName: 'useStyles$', hash: `style${index}`, origin: `../.qstyle/native/${pack.id}.tsx` }]));
  const mapping = Object.fromEntries(Object.keys(symbols).map((name) => [name, 'styles.js']));
  return {
    'styles.js': { type: 'chunk', fileName: 'styles.js', code: graph.program.packs.map((pack, index) =>
      `export const style${index}=${JSON.stringify(pack.css)};`).join('\n') },
    'q-manifest.json': { type: 'asset', fileName: 'q-manifest.json', source: JSON.stringify({ symbols, mapping }) },
  };
}

describe('qstyle native plugin environment discovery', () => {
  it('keeps existing output plugins and gives multiple client outputs distinct report names', async () => {
    const value = fixture();
    try {
      const plugin = qstyleNative({ utilities });
      configure(plugin, configFor(value, plugin, { name: 'unrelated' }));
      await buildStart(plugin, contextFor(value, null, 'browser-custom'));
      const existing = { name: 'existing-output-plugin' };
      const configured = configureEnvironment(plugin, 'browser-custom', { consumer: 'client', build: { rolldownOptions: {
        output: [{ format: 'es', plugins: [existing] }, { format: 'cjs' }],
      } } })!;
      const outputs = configured.build!.rolldownOptions!.output as Rolldown.OutputOptions[];
      expect((outputs[0]!.plugins as unknown[])[0]).toEqual([existing]);
      const bundle = reportBundle(graphOf(plugin, 'browser-custom')!);
      const emitFile = vi.fn();
      for (const output of outputs) {
        const reportPlugin = (output.plugins as Rolldown.Plugin[]).at(-1)!;
        const hook = reportPlugin.generateBundle as unknown as { handler(this: unknown, output: unknown, bundle: unknown): void };
        hook.handler.call({ emitFile }, output, bundle);
      }
      expect(emitFile.mock.calls.map(([asset]) => asset.fileName)).toEqual(['qstyle-report.0.json', 'qstyle-report.1.json']);
      expect(configureEnvironment(plugin, 'browser-custom', { consumer: 'server' })).toBeUndefined();
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('observes final input-plugin rewrites with write:false and rejects duplicate payloads before write', async () => {
    const value = fixture();
    try {
      const localReport = join(value.root, '.qstyle/report.json');
      const plugin = qstyleNative({ utilities, report: { file: '.qstyle/report.json', sources: true } });
      configure(plugin, configFor(value, plugin, { name: 'unrelated' }));
      await buildStart(plugin, contextFor(value, null, 'client'));
      const pack = graphOf(plugin, 'client')!.program.packs[0]!;
      const css = pack.css;
      const configured = configureEnvironment(plugin, 'client')!;
      const output = configured.build!.rolldownOptions!.output as Rolldown.OutputOptions;
      const entry = join(value.root, 'entry.js');
      const directory = join(value.root, 'output');
      writeFileSync(entry, 'export const flag=1;');
      let duplicate = false;
      const rewrite: Plugin = { name: 'final-qwik-rewrite-control', generateBundle: { order: 'post', handler(_options, bundle) {
        const chunk = Object.values(bundle).find((item) => item.type === 'chunk')!;
        chunk.code += `\nexport const lateStyle=${JSON.stringify(css)};`;
        if (duplicate) chunk.code += `\nexport const duplicateStyle=${JSON.stringify(css)};`;
        this.emitFile({ type: 'asset', fileName: 'q-manifest.json', source: JSON.stringify({
          symbols: { lateStyle: { ctxName: 'useStyles$', hash: 'lateStyle', origin: `../.qstyle/native/${pack.id}.tsx` } },
          mapping: { lateStyle: chunk.fileName },
        }) });
      } } };
      const options = { configFile: false as const, root: value.root, logLevel: 'silent' as const,
        plugins: [rewrite], build: { outDir: directory, rolldownOptions: { input: entry, output } } };
      const generated = await build({ ...options, build: { ...options.build, write: false } }) as Rolldown.RolldownOutput;
      const reportAsset = generated.output.find((item) => item.type === 'asset' && item.fileName === 'qstyle-report.json');
      expect(reportAsset?.type).toBe('asset');
      if (reportAsset?.type !== 'asset') throw new Error('Missing report output');
      const report = JSON.parse(String(reportAsset.source));
      const chunk = generated.output.find((item) => item.type === 'chunk')!;
      expect(report.assets.find((item: { fileName: string }) => item.fileName === chunk.fileName).contentDigest)
        .toBe(createHash('sha256').update(chunk.code).digest('hex'));
      expect(existsSync(directory)).toBe(false);
      expect(existsSync(localReport)).toBe(false);
      expect(report.modules[0].source).toBe(readFileSync(value.configuredRoot, 'utf8'));
      await build(options);
      const savedReport = readFileSync(localReport, 'utf8');
      expect(JSON.parse(savedReport).modules[0].source).toBe(report.modules[0].source);
      rmSync(directory, { recursive: true, force: true });
      duplicate = true;
      await expect(build(options)).rejects.toThrow('QS1601');
      expect(existsSync(directory) ? readdirSync(directory) : []).toEqual([]);
      expect(readFileSync(localReport, 'utf8')).toBe(savedReport);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('rejects final native style ID collisions before writing any files', async () => {
    const value = fixture();
    try {
      writeFileSync(value.configuredRoot,
        'import {component$} from "@qwik.dev/core";const Child=component$(()=> <span css={{color:"blue"}}/>);'
        + 'export default component$(()=> <><head/><body><div css={{color:"red"}}/><Child/></body></>);');
      const plugin = qstyleNative();
      configure(plugin, configFor(value, plugin, { name: 'unrelated' }));
      await buildStart(plugin, contextFor(value, null, 'client'));
      const packs = graphOf(plugin, 'client')!.program.packs;
      expect(packs).toHaveLength(2);
      const output = configureEnvironment(plugin, 'client')!.build!.rolldownOptions!.output as Rolldown.OutputOptions;
      const entry = join(value.root, 'entry.js');
      const directory = join(value.root, 'output');
      writeFileSync(entry, 'export const flag=1;');
      let collision = false;
      const rewrite: Plugin = { name: 'final-qwik-style-id-control', generateBundle: { order: 'post', handler(_options, bundle) {
        const chunk = Object.values(bundle).find((item) => item.type === 'chunk')!;
        const hashes = ['Aa', collision ? 'BB' : 'BC'];
        const symbols = Object.fromEntries(packs.map((pack, index) => {
          const symbol = `style${index}`;
          chunk.code += `\nexport const ${symbol}=${JSON.stringify(pack.css)};`;
          return [symbol, { ctxName: 'useStyles$', hash: hashes[index], origin: `../.qstyle/native/${pack.id}.tsx` }];
        }));
        this.emitFile({ type: 'asset', fileName: 'q-manifest.json', source: JSON.stringify({
          symbols, mapping: Object.fromEntries(Object.keys(symbols).map((symbol) => [symbol, chunk.fileName])),
        }) });
      } } };
      const options = { configFile: false as const, root: value.root, logLevel: 'silent' as const,
        plugins: [rewrite], build: { outDir: directory, rolldownOptions: { input: entry, output } } };
      await build({ ...options, build: { ...options.build, write: false } });
      expect(existsSync(directory)).toBe(false);
      collision = true;
      await expect(build(options)).rejects.toThrow('QS1301');
      expect(existsSync(directory) ? readdirSync(directory) : []).toEqual([]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('audits browser payloads once and excludes server/SSG copies', async () => {
    const value = fixture();
    try {
      const plugin = qstyleNative({ utilities });
      const router = { name: 'unrelated' } as Plugin;
      configure(plugin, configFor(value, plugin, router));
      const client = contextFor(value, null, 'client');
      await buildStart(plugin, client);
      const frozen = graphOf(plugin, 'client')!;
      const bundle = reportBundle(frozen);
      const configured = configureEnvironment(plugin, 'client')!;
      const output = configured.build!.rolldownOptions!.output as Rolldown.OutputOptions;
      const reportPlugin = (output.plugins as Rolldown.Plugin[])[0]!;
      const hook = reportPlugin.generateBundle as unknown as { handler(this: unknown, output: unknown, bundle: unknown): void };
      const emitFile = vi.fn();
      hook.handler.call({ emitFile }, {}, bundle);
      expect(emitFile).toHaveBeenCalledOnce();
      const source = emitFile.mock.calls[0]![0].source;
      const report = JSON.parse(source);
      expect(report.schemaVersion).toBe(1);
      expect(report.duplicatePayloadCount).toBe(0);
      expect(source).not.toContain(value.root);
      for (const name of ['ssr', 'ssg']) {
        expect(configureEnvironment(plugin, name)).toBeUndefined();
      }
      expect(() => hook.handler.call({ emitFile }, {}, {})).toThrow('QS1601');
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('uses the generated SSG worker render root instead of configured SSR input', async () => {
    const value = fixture();
    try {
      let loadThis: unknown;
      const router = {
        name: 'vite-plugin-qwik-router-ssg-test',
        load(this: unknown, id: string) {
          loadThis = this;
          return id === value.workerId ? value.workerSource : null;
        },
      } as unknown as Plugin;
      const plugin = qstyleNative({ utilities });
      configure(plugin, configFor(value, plugin, router));

      const ssg = contextFor(value, { id: value.workerId }, 'ssg');
      await buildStart(plugin, ssg);
      const ssgGraph = graphOf(plugin, 'ssg');
      expect(ssgGraph?.analyses.get(value.workerRoot)?.foundation).toBeDefined();
      expect(ssgGraph?.analyses.get(value.configuredRoot)?.foundation).toBeUndefined();
      expect(loadThis).toBe(ssg);
      expect(ssg.load).not.toHaveBeenCalled();

      const ordinary = contextFor(value, null);
      await buildStart(plugin, ordinary);
      const ordinaryGraph = graphOf(plugin, 'default');
      expect(ordinaryGraph?.analyses.get(value.configuredRoot)?.foundation).toBeDefined();
      expect(ordinaryGraph?.analyses.get(value.workerRoot)?.foundation).toBeUndefined();
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'missing', worker: null as WorkerResolution },
    { label: 'unresolved', worker: { id: '' } as WorkerResolution },
    { label: 'external', worker: { id: '\0virtual:qwik-router-ssg-worker', external: true } as WorkerResolution },
    { label: 'nonvirtual', worker: { id: '/generated/qwik-worker.ts' } as WorkerResolution },
    { label: 'missing source', worker: { id: '\0virtual:qwik-router-ssg-worker' } as WorkerResolution, missingSource: true },
  ])('fails closed for a $label generated worker without falling back to configured input', async ({ worker, missingSource }) => {
    const value = fixture();
    try {
      const router = {
        name: 'vite-plugin-qwik-router-ssg-test',
        load: () => missingSource ? null : value.workerSource,
      } as unknown as Plugin;
      const plugin = qstyleNative({ utilities });
      configure(plugin, configFor(value, plugin, router));
      const context = contextFor(value, worker, 'ssg');
      await expect(buildStart(plugin, context)).rejects.toMatchObject({ code: 'QS1401' });
      expect(graphOf(plugin, 'ssg')).toBeUndefined();
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('fails closed when the SSG worker cannot be resolved', async () => {
    const value = fixture();
    try {
      const router = { name: 'vite-plugin-qwik-router-ssg-test', load: () => value.workerSource } as unknown as Plugin;
      const plugin = qstyleNative({ utilities });
      configure(plugin, configFor(value, plugin, router));
      const context = contextFor(value, null, 'ssg');
      await expect(buildStart(plugin, context)).rejects.toMatchObject({ code: 'QS1401' });
      expect(graphOf(plugin, 'ssg')).toBeUndefined();
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });
});
