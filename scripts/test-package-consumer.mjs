#!/usr/bin/env node
/**
 * Pack every public qstyle package, install the tarballs in an external
 * temporary consumer, and smoke the published entry points through Node and
 * Vite. This intentionally stays outside the workspace so workspace aliases
 * cannot satisfy an import by accident.
 */
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const nodePath = process.execPath;

const packages = [
  { key: 'core', name: '@qstyle/core', directory: 'core' },
  { key: 'compiler', name: '@qstyle/compiler', directory: 'compiler' },
  { key: 'inspector', name: '@qstyle/inspector', directory: 'inspector' },
  { key: 'qwik', name: '@qstyle/qwik', directory: 'qwik' },
  { key: 'unocss', name: '@qstyle/unocss', directory: 'unocss' },
  { key: 'vite', name: '@qstyle/vite', directory: 'vite' },
];

function run(command, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      } else {
        child.kill('SIGTERM');
      }
      killTimer = setTimeout(() => {
        if (process.platform !== 'win32' && child.pid !== undefined) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        } else {
          child.kill('SIGKILL');
        }
      }, 2_000);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolveResult({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function filesIn(directory) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

async function walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function compactOutput(output, limit = 2400) {
  const text = String(output ?? '').trim();
  return text.length <= limit ? text : `...${text.slice(-limit)}`;
}

function errorDetails(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : undefined,
    message: String(error?.message ?? error).split('\n')[0],
  };
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} did not emit JSON: ${errorDetails(error).message}\n${compactOutput(output)}`);
  }
}

async function packLocalPackages(tarballDirectory) {
  const tarballs = {};
  const evidence = [];
  for (const packageInfo of packages) {
    const before = new Set(await filesIn(tarballDirectory));
    const result = await run('pnpm', ['pack', '--pack-destination', tarballDirectory], {
      cwd: join(repoRoot, 'packages', packageInfo.directory),
      timeoutMs: 60_000,
    });
    if (result.code !== 0) {
      throw new Error(`pnpm pack failed for ${packageInfo.name} (exit ${String(result.code)})\n${compactOutput(`${result.stdout}\n${result.stderr}`)}`);
    }
    const produced = (await filesIn(tarballDirectory)).filter((file) => !before.has(file) && file.endsWith('.tgz'));
    if (produced.length !== 1) {
      throw new Error(`pnpm pack produced ${String(produced.length)} tarballs for ${packageInfo.name}: ${produced.join(', ')}`);
    }
    const path = join(tarballDirectory, produced[0]);
    tarballs[packageInfo.key] = path;
    evidence.push({ name: packageInfo.name, file: produced[0], bytes: (await stat(path)).size });
  }
  return { tarballs, evidence };
}

function consumerPackageJson(tarballs) {
  const dependencies = {
    ...Object.fromEntries(packages.map((packageInfo) => [packageInfo.name, `file:${tarballs[packageInfo.key]}`])),
    '@qwik.dev/core': '2.0.0-beta.43',
    vite: '8.2.2',
  };
  return {
    name: 'qstyle-external-package-consumer',
    private: true,
    type: 'module',
    dependencies,
  };
}

const consumerSmokeSource = String.raw`import { createRequire } from 'node:module';

// @qwik.dev/core beta.43 expects this bundler-provided global even for a
// direct Node import. The empty object selects its default feature flags.
globalThis.__EXPERIMENTAL__ ??= {};

const require = createRequire(import.meta.url);
const checks = [];

function check(name, pass, details = {}) {
  checks.push({ name, pass, ...details });
}

function failure(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : undefined,
    message: String(error?.message ?? error).split('\n')[0],
  };
}

async function importPublic(specifier) {
  try {
    return { ok: true, namespace: await import(specifier) };
  } catch (error) {
    return { ok: false, error: failure(error) };
  }
}

function requirePublic(specifier) {
  try {
    return { ok: true, namespace: require(specifier) };
  } catch (error) {
    return { ok: false, error: failure(error) };
  }
}

function packageMetadata(packageName) {
  try {
    return { ok: true, metadata: require(packageName + '/package.json') };
  } catch (error) {
    return { ok: false, error: failure(error) };
  }
}

function exportEntry(metadata, subpath) {
  const exports = metadata?.exports;
  if (typeof exports === 'string') return subpath === '.' ? exports : undefined;
  if (exports === null || typeof exports !== 'object') return undefined;
  if (subpath === '.' && Object.prototype.hasOwnProperty.call(exports, '.')) {
    return exports['.'];
  }
  return exports[subpath];
}

function hasRequireBranch(metadata, subpath) {
  const entry = exportEntry(metadata, subpath);
  return entry !== null && typeof entry === 'object'
    && Object.prototype.hasOwnProperty.call(entry, 'require');
}

const esmSpecifiers = [
  '@qstyle/core',
  '@qstyle/compiler',
  '@qstyle/inspector',
  '@qstyle/qwik',
  '@qstyle/qwik/runtime',
  '@qstyle/qwik/server',
  '@qstyle/unocss',
  '@qstyle/vite',
];
const esm = new Map();
for (const specifier of esmSpecifiers) {
  const result = await importPublic(specifier);
  esm.set(specifier, result);
  check('ESM ' + specifier, result.ok,
    result.ok ? { exports: Object.keys(result.namespace).sort() } : { error: result.error });
}

const runtime = esm.get('@qstyle/qwik/runtime');
check('ESM @qstyle/qwik/runtime exposes native hook aliases', runtime?.ok === true
  && typeof runtime.namespace.useStylesQrl === 'function'
  && typeof runtime.namespace.useStylesScopedQrl === 'function',
{ exports: runtime?.ok === true ? Object.keys(runtime.namespace).sort() : [] });

const server = esm.get('@qstyle/qwik/server');
check('ESM @qstyle/qwik/server exposes render wrappers', server?.ok === true
  && typeof server.namespace.renderToString === 'function'
  && typeof server.namespace.renderToStream === 'function',
{ exports: server?.ok === true ? Object.keys(server.namespace).sort() : [] });

const vite = esm.get('@qstyle/vite');
let nativePlugins;
try {
  nativePlugins = vite?.ok === true ? vite.namespace.qstyleNative() : undefined;
  check('ESM @qstyle/vite qstyleNative returns compiler and adapter plugins',
    Array.isArray(nativePlugins) && nativePlugins.length === 2
      && nativePlugins.every((plugin) => typeof plugin?.name === 'string'),
  { pluginNames: nativePlugins?.map((plugin) => plugin.name) ?? [] });
} catch (error) {
  check('ESM @qstyle/vite qstyleNative returns compiler and adapter plugins', false,
    { error: failure(error) });
}

for (const specifier of esmSpecifiers) {
  const packageName = specifier.startsWith('@qstyle/qwik/')
    ? '@qstyle/qwik'
    : specifier;
  const metadata = packageMetadata(packageName);
  check('package metadata ' + specifier, metadata.ok,
    metadata.ok ? { packageName } : { error: metadata.error });
  const exportSubpath = specifier.startsWith(packageName + '/')
    ? '.' + specifier.slice(packageName.length)
    : '.';
  const requireBranch = metadata.ok && hasRequireBranch(metadata.metadata, exportSubpath);
  const expectedRequire = [
    '@qstyle/core',
    '@qstyle/inspector',
  ].includes(specifier);
  check('package metadata ' + specifier + ' require condition',
    metadata.ok && requireBranch === expectedRequire,
    { expectedRequire, requireBranch, exportSubpath });
}

const cjsExpectations = [
  ['@qstyle/core', true],
  ['@qstyle/compiler', false],
  ['@qstyle/inspector', true],
  ['@qstyle/qwik', false],
  ['@qstyle/qwik/runtime', false],
  ['@qstyle/qwik/server', false],
  ['@qstyle/unocss', false],
  ['@qstyle/vite', false],
];
for (const [specifier, expectedRequire] of cjsExpectations) {
  const result = requirePublic(specifier);
  const pass = expectedRequire
    ? result.ok
    : result.ok === false && result.error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
  check('CJS ' + specifier, pass,
    result.ok
      ? { expected: expectedRequire ? 'available' : 'absent', exports: Object.keys(result.namespace).sort() }
      : { expected: expectedRequire ? 'available' : 'ERR_PACKAGE_PATH_NOT_EXPORTED', error: result.error });
}

const failures = checks.filter(({ pass }) => !pass);
const output = JSON.stringify({ checks, failures }, null, 2) + '\n';
process.stdout.write(output, () => process.exit(failures.length > 0 ? 1 : 0));
`;

const viteConfigSource = String.raw`import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { qwikVite } from '@qwik.dev/core/optimizer';
import { qstyleNative } from '@qstyle/vite';

const clientInput = fileURLToPath(new URL('./src/root.tsx', import.meta.url));
const ssrInput = fileURLToPath(new URL('./src/entry.ssr.tsx', import.meta.url));

export default defineConfig({
  plugins: [
    ...qstyleNative(),
    qwikVite({
      entryStrategy: { type: 'segment' },
      client: { input: clientInput },
      ssr: { input: ssrInput },
    }),
    {
      name: 'consumer-client-module-audit',
      generateBundle(_options, bundle) {
        const modules = [...new Set(Object.values(bundle).filter((item) => item.type === 'chunk')
          .flatMap((chunk) => Object.entries(chunk.modules)
            .filter(([, metadata]) => metadata.renderedLength > 0).map(([id]) => id)))].sort();
        const imports = [...new Set(Object.values(bundle).filter((item) => item.type === 'chunk')
          .flatMap((chunk) => [...chunk.imports, ...chunk.dynamicImports]))].sort();
        this.emitFile({ type: 'asset', fileName: 'client-module-audit.json',
          source: JSON.stringify({ modules, imports }) });
      },
    },
  ],
});
`;

const rootSource = String.raw`import { component$ } from '@qwik.dev/core';
import { css } from '@qstyle/qwik';

const panel = css({ color: 'rgb(18, 52, 86)', padding: 8 });

export default component$(() => (
  <>
    <head><title>external qstyle consumer</title></head>
    <body><main id="styled" css={panel}>external consumer</main></body>
  </>
));
`;

const ssrSource = String.raw`import { renderToString } from '@qwik.dev/core/server';
import Root from './root';

export default function render(options) {
  return renderToString(<Root />, { ...options, preloader: false });
}
`;

const renderSmokeSource = String.raw`import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
process.env.NODE_ENV = 'production';
await build({ configFile: 'vite.config.mjs', logLevel: 'warn', build: {
  ssr: resolve('src/entry.ssr.tsx'), outDir: 'server', emptyOutDir: true,
  rolldownOptions: { output: { entryFileNames: 'render.mjs' } },
} });
const { default: render } = await import('./server/render.mjs');
const manifest = JSON.parse(await readFile('dist/q-manifest.json', 'utf8'));
const { html } = await render({ manifest, url: 'http://localhost/' });
const head = html.slice(html.indexOf('<head'), html.indexOf('</head>'));
const body = html.slice(html.indexOf('<body'));
assert.match(head, /color:rgb\(18,\s*52,\s*86\)/);
assert.match(body, /id="styled"/);
assert.doesNotMatch(body, /<style\s[^>]*q:style/);
process.stdout.write(JSON.stringify({ pass: true, htmlBytes: Buffer.byteLength(html),
  generatedCssInHead: true, bodyStyleCount: 0 }) + '\n', () => process.exit(0));
`;

async function writeConsumer(consumerRoot, tarballs) {
  await mkdir(join(consumerRoot, 'src'), { recursive: true });
  await writeFile(join(consumerRoot, 'package.json'), `${JSON.stringify(consumerPackageJson(tarballs), null, 2)}\n`);
  await writeFile(join(consumerRoot, 'pnpm-workspace.yaml'), [
    'overrides:',
    ...packages.map((packageInfo) => `  '${packageInfo.name}': 'file:${tarballs[packageInfo.key]}'`),
    '',
  ].join('\n'));
  await writeFile(join(consumerRoot, 'smoke.mjs'), consumerSmokeSource);
  await writeFile(join(consumerRoot, 'render-smoke.mjs'), renderSmokeSource);
  await writeFile(join(consumerRoot, 'vite.config.mjs'), viteConfigSource);
  await writeFile(join(consumerRoot, 'src', 'root.tsx'), rootSource);
  await writeFile(join(consumerRoot, 'src', 'entry.ssr.tsx'), ssrSource);
}

async function inspectClientGraph(consumerRoot) {
  const dist = join(consumerRoot, 'dist');
  const files = await walkFiles(dist);
  const clientFiles = files.filter((path) => /\.(?:[cm]?js|css)$/.test(path));
  const hits = [];
  const graph = JSON.parse(await readFile(join(dist, 'client-module-audit.json'), 'utf8'));
  if (!Array.isArray(graph.modules) || graph.modules.length === 0) throw new Error('Client module audit is empty');
  for (const id of [...graph.modules, ...graph.imports]) {
    if (/(?:^|\/)parse5(?:\/|$)/.test(id)) hits.push({ module: id });
  }
  for (const path of clientFiles) {
    const text = await readFile(path, 'utf8');
    if (text.includes('parse5')) hits.push({ file: path.slice(`${dist}/`.length) });
  }
  return {
    files: files.map((path) => path.slice(`${dist}/`.length)),
    javascriptFiles: clientFiles.filter((path) => /\.(?:[cm]?js)$/.test(path)).map((path) => path.slice(`${dist}/`.length)),
    parse5Hits: hits,
    renderedModuleCount: graph.modules.length,
  };
}

async function main() {
  let tempRoot;
  const report = { packages: [], public: undefined, build: undefined, clientGraph: undefined, failures: [] };
  try {
    tempRoot = await mkdtemp(join(tmpdir(), 'qstyle-package-consumer-'));
    const tarballDirectory = join(tempRoot, 'tarballs');
    const consumerRoot = join(tempRoot, 'consumer');
    await mkdir(tarballDirectory);
    await mkdir(consumerRoot);

    const packed = await packLocalPackages(tarballDirectory);
    report.packages = packed.evidence;
    await writeConsumer(consumerRoot, packed.tarballs);

    let install = await run('pnpm', ['install', '--offline', '--ignore-scripts', '--lockfile=false'], {
      cwd: consumerRoot,
      timeoutMs: 180_000,
    });
    let installMode = 'offline';
    if (install.code !== 0) {
      installMode = 'online-fallback';
      install = await run('pnpm', ['install', '--ignore-scripts', '--lockfile=false'], {
        cwd: consumerRoot,
        timeoutMs: 180_000,
      });
    }
    report.install = {
      mode: installMode,
      code: install.code,
      output: compactOutput(`${install.stdout}\n${install.stderr}`),
    };
    if (install.code !== 0) throw new Error(`consumer dependency install failed (mode ${installMode})`);

    const smoke = await run(nodePath, ['smoke.mjs'], { cwd: consumerRoot, timeoutMs: 45_000 });
    report.public = parseJsonOutput(smoke.stdout, 'public package smoke');
    if (smoke.stderr.trim()) report.public.stderr = compactOutput(smoke.stderr);

    const build = await run('pnpm', ['exec', 'vite', 'build', '--config', 'vite.config.mjs', '--logLevel', 'warn'], {
      cwd: consumerRoot,
      env: { NODE_ENV: 'production' },
      timeoutMs: 180_000,
    });
    report.build = {
      code: build.code,
      output: compactOutput(`${build.stdout}\n${build.stderr}`),
    };
    if (build.code === 0) {
      report.clientGraph = await inspectClientGraph(consumerRoot);
      report.clientGraph.parse5Absent = report.clientGraph.parse5Hits.length === 0;
    }
    if (build.code !== 0) throw new Error('external Vite+Qwik production build failed');
    if (report.clientGraph.parse5Absent !== true) throw new Error('parse5 was reachable from the client graph');
    const server = await run(nodePath, ['render-smoke.mjs'], { cwd: consumerRoot, timeoutMs: 180_000 });
    report.server = { code: server.code, output: compactOutput(`${server.stdout}\n${server.stderr}`) };
    if (server.code !== 0) throw new Error('external SSR build or render failed');

    report.failures = [
      ...(report.public?.failures ?? []),
      ...(report.clientGraph.parse5Absent ? [] : [{ name: 'parse5 absent from client graph', pass: false }]),
    ];
    console.log(JSON.stringify({ ...report, tempRoot }, null, 2));
    if (report.failures.length > 0) process.exitCode = 1;
  } catch (error) {
    report.failures.push({ name: 'harness', pass: false, error: errorDetails(error) });
    console.log(JSON.stringify({ ...report, tempRoot }, null, 2));
    process.exitCode = 1;
  } finally {
    if (tempRoot && process.env.QSTYLE_KEEP_TEMP !== '1') await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
