#!/usr/bin/env node

/*
 * D0 delivery-cost comparison.
 *
 * This script deliberately builds throw-away copies of a small Qwik City
 * application.  The source copies are equivalent across the three lanes:
 * qstyleNative, handwritten Qwik styles, and the old qstyle plugin.  Nothing
 * under fixtures/ is edited.  Each copy is built twice so the prefetch-on and
 * prefetch-off observations are independent.
 *
 * The browser observations are intentionally based on response bodies rather
 * than filenames or qstyle URL markers.  The report records failed builds as
 * unsupported lanes; in particular, a failed legacy build is never treated
 * as evidence that legacy qstyle accepts this input.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');
const viteEntry = resolve(repoRoot, 'packages/vite/dist/index.mjs');
const qwikAuthoringEntry = resolve(repoRoot, 'packages/qwik/dist/index.mjs');
const stockQwikRoot = resolve(repoRoot, 'packages/qwik/node_modules/@qwik.dev');
const stockCore = resolve(stockQwikRoot, 'core');
const stockRouter = resolve(stockQwikRoot, 'router');
const workRoot = resolve(repoRoot, '.qstyle/delivery-cost');
const runRoot = resolve(workRoot, `run-${process.pid}`);
const outputPath = resolve(repoRoot, 'docs/audits/2026-09-11-delivery-cost.json');

const lanes = [
  { key: 'qstyleNative', label: 'qstyleNative', mode: 'native' },
  { key: 'handwrittenNativeQwik', label: 'handwritten native Qwik', mode: 'handwritten' },
  { key: 'legacyQstyle', label: 'old qstyle', mode: 'legacy' },
];
const prefetchModes = [
  { key: 'off', enabled: false },
  { key: 'on', enabled: true },
];
const expectedStyles = {
  sharedColor: 'rgb(12, 34, 56)',
  routeAOutside: 'rgb(0, 0, 0)',
  scopedInside: 'rgb(168, 20, 92)',
  scopedChildBackground: 'rgb(246, 224, 236)',
  routeBBackground: 'rgb(255, 226, 180)',
  routeBBorderTop: '2px',
  lazyBackground: 'rgb(224, 240, 255)',
  lazyBorderTop: '2px',
};

function json(value) {
  return JSON.stringify(value);
}

function assertAvailable(path, description) {
  if (!existsSync(path)) throw new Error(`missing ${description}: ${path}`);
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function shellEnv(prefetchEnabled) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    QSTYLE_NAMED_IMPORT: '1',
    QSTYLE_DELIVERY_PREFETCH: prefetchEnabled ? '1' : '0',
    VITE_DELIVERY_PREFETCH: prefetchEnabled ? '1' : '0',
  };
}

async function ensureSymlink(target, linkPath) {
  await mkdir(dirname(linkPath), { recursive: true });
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink() || realpathSync(linkPath) !== realpathSync(target)) {
      throw new Error(`refusing to replace non-matching dependency link: ${linkPath}`);
    }
    return;
  }
  await symlink(target, linkPath, 'dir');
}

function nativeSource(mode) {
  if (mode === 'handwritten') return false;
  return true;
}

function rootSource() {
  return `import { component$, useSignal } from '@qwik.dev/core';
import { QwikCityProvider, RouterOutlet } from '@qwik.dev/router';

/** The shell stays mounted while Qwik Router swaps the outlet. */
export default component$(() => {
  const input = useSignal('shell input');
  const status = useSignal('ready');

  return (
    <QwikCityProvider>
      <head>
        <meta charSet="utf-8" />
        <title>qstyle delivery cost</title>
      </head>
      <body>
        <header data-testid="persistent-shell" data-page-token="delivery-page">
          <input
            data-testid="shell-input"
            value={input.value}
            onInput$={(_event, target) => {
              input.value = target.value;
            }}
          />
          <button
            data-testid="shell-update"
            onClick$={() => {
              status.value = status.value === 'ready' ? 'updated' : 'ready';
            }}
          >
            update shell
          </button>
          <span data-testid="shell-status">{status.value}</span>
        </header>
        <RouterOutlet />
      </body>
    </QwikCityProvider>
  );
});
`;
}

function sharedSource(mode) {
  if (nativeSource(mode)) {
    return `import { css } from '@qstyle/qwik';

/** One generated declaration is consumed by both route owners. */
export const shared = css({ color: 'rgb(12, 34, 56)' });

/** One generated pack is first introduced by the lazy owner. */
export const lazy = css({
  backgroundColor: 'rgb(224, 240, 255)',
  border: '2px solid rgb(36, 96, 160)',
});
`;
  }
  return `// Handwritten lane keeps the equivalent declarations in its components.
export const shared = '.delivery-shared { color: rgb(12, 34, 56); }';
export const lazy = '.delivery-lazy { background: rgb(224, 240, 255); border: 2px solid rgb(36, 96, 160); }';
`;
}

function sharedComponentSource(mode) {
  if (mode === 'native') {
    return `import { component$ } from '@qwik.dev/core';
import { shared } from '../shared.qstyle';

export const SharedStylePack = component$((props: { testId: string }) => (
  <p css={shared} data-testid={props.testId}>
    shared
  </p>
));
`;
  }
  if (mode === 'legacy') {
    return `import { component$ } from '@qwik.dev/core';
import { css } from '@qstyle/qwik';

const shared = css({ color: 'rgb(12, 34, 56)' });

export const SharedStylePack = component$((props: { testId: string }) => (
  <p css={shared} data-testid={props.testId}>
    shared
  </p>
));
`;
  }
  return `import { component$, useStyles$ } from '@qwik.dev/core';

const sharedStyles = '.delivery-shared { color: rgb(12, 34, 56); }';

export const SharedStylePack = component$((props: { testId: string }) => {
  useStyles$(sharedStyles);
  return <p class="delivery-shared" data-testid={props.testId}>shared</p>;
});
`;
}

function lazySource(mode) {
  if (mode === 'native') {
    return `import { component$ } from '@qwik.dev/core';
import { lazy } from '../shared.qstyle';

/** Two instances intentionally share one generated style pack. */
export const LazyOwner = component$(() => (
  <article css={lazy} class="delivery-lazy" data-testid="lazy-owner">
    lazy owner
  </article>
));
`;
  }
  if (mode === 'legacy') {
    return `import { component$ } from '@qwik.dev/core';
import { css } from '@qstyle/qwik';

const lazy = css({
  backgroundColor: 'rgb(224, 240, 255)',
  border: '2px solid rgb(36, 96, 160)',
});

export const LazyOwner = component$(() => (
  <article css={lazy} class="delivery-lazy" data-testid="lazy-owner">
    lazy owner
  </article>
));
`;
  }
  return `import { component$, useStyles$ } from '@qwik.dev/core';

const lazyStyles = '.delivery-lazy { background: rgb(224, 240, 255); border: 2px solid rgb(36, 96, 160); }';

export const LazyOwner = component$(() => {
  useStyles$(lazyStyles);
  return <article class="delivery-lazy" data-testid="lazy-owner">lazy owner</article>;
});
`;
}

function scopedSource() {
  return `import { component$, useSignal, useStylesScoped$ } from '@qwik.dev/core';

const scopedStyles = '.delivery-scoped { color: rgb(168, 20, 92); } .delivery-scoped > .delivery-scoped-child { background-color: rgb(246, 224, 236); }';

export const ScopedControl = component$(() => {
  const marker = useSignal('scoped');
  const styles = useStylesScoped$(scopedStyles);
  return (
    <section data-testid="scoped-control" data-scope-id={styles.scopeId}>
      <div class="delivery-scoped" data-testid="scoped-inside">
        {marker.value}
        <span class="delivery-scoped-child" data-testid="scoped-child">inside</span>
      </div>
    </section>
  );
});
`;
}

function routeASource(mode) {
  const styleImports = mode !== 'handwritten'
    ? `import { component$, useSignal, useStyles$ as useNamedStyles$ } from '@qwik.dev/core';
import { css } from '@qstyle/qwik';`
    : `import { component$, useSignal, useStyles$ as useNamedStyles$ } from '@qwik.dev/core';`;
  const sharedImports = mode === 'native'
    ? `import { shared } from '../shared.qstyle';`
    : '';
  const sharedElement = mode === 'handwritten'
    ? `<p class="delivery-shared" data-testid="shared-a">shared on A</p>`
    : mode === 'native'
    ? `<p css={shared} data-testid="shared-a">shared on A</p>`
    : `<p css={routeAShared} data-testid="shared-a">shared on A</p>`;
  const handles = mode === 'native'
    ? `
const routeABox = css({ padding: 8, border: '1px solid rgb(20, 20, 20)' });
`
    : mode === 'legacy'
      ? `
const routeAShared = css({ color: 'rgb(12, 34, 56)' });
const routeABox = css({ padding: 8, border: '1px solid rgb(20, 20, 20)' });
`
      : '';
  const box = mode !== 'handwritten'
    ? `<div css={routeABox} data-testid="route-a-box">route A box</div>`
    : `<div class="delivery-route-a-box" data-testid="route-a-box">route A box</div>`;
  return `${styleImports}
import { Link } from '@qwik.dev/router';
import { SharedStylePack } from '../components/shared';
import { LazyOwner } from '../components/lazy-owner';
import { ScopedControl } from '../components/scoped-control';
${sharedImports}

const routeAStyles = '.delivery-route-outside { color: rgb(0, 0, 0); }';
const prefetch = import.meta.env.VITE_DELIVERY_PREFETCH === '1';
${handles}
export default component$(() => {
  const showLazy = useSignal(false);
  useNamedStyles$(routeAStyles);
  return (
    <main data-testid="route-a">
      <h1>route A</h1>
      <nav>
        <Link href="/route-b" prefetch={prefetch} data-testid="to-b">route B</Link>
      </nav>
      ${sharedElement}
      <SharedStylePack testId="shared-component-a" />
      <ScopedControl />
      <div class="delivery-route-outside" data-testid="route-a-outside">outside</div>
      ${box}
      <button
        data-testid="lazy-toggle"
        aria-expanded={showLazy.value}
        onClick$={() => { showLazy.value = !showLazy.value; }}
      >toggle lazy owners</button>
      {showLazy.value ? <><LazyOwner /><LazyOwner /></> : null}
    </main>
  );
});
`;
}

function routeBSource(mode) {
  // Keep this typo-proof by supplying the actual component import separately.
  const componentImport = mode !== 'handwritten'
    ? `import { component$ } from '@qwik.dev/core';\nimport { css } from '@qstyle/qwik';`
    : `import { component$ } from '@qwik.dev/core';`;
  const style = mode === 'native'
    ? `const routeBOnly = css({\n  backgroundColor: 'rgb(255, 226, 180)',\n  border: '2px solid rgb(160, 96, 36)',\n});`
    : `const routeBOnly = css({\n  backgroundColor: 'rgb(255, 226, 180)',\n  border: '2px solid rgb(160, 96, 36)',\n});\nconst routeBShared = css({ color: 'rgb(12, 34, 56)' });`;
  const sharedImport = mode === 'native' ? `import { shared } from '../../shared.qstyle';` : '';
  const sharedElement = mode === 'native'
    ? `<p css={shared} data-testid="shared-b">shared on B</p>`
    : `<p css={routeBShared} data-testid="shared-b">shared on B</p>`;
  const element = mode !== 'handwritten'
    ? `<p css={routeBOnly} data-testid="route-b-only">route B only</p>`
    : `<p class="delivery-route-b-only" data-testid="route-b-only">route B only</p>`;
  return `${componentImport}
import { Link } from '@qwik.dev/router';
import { SharedStylePack } from '../../components/shared';
${sharedImport}
${style}

export default component$(() => (
  <main data-testid="route-b">
    <h1>route B</h1>
    <Link href="/" data-testid="to-a">route A</Link>
    ${sharedElement}
    ${element}
    <SharedStylePack testId="shared-component-b" />
  </main>
));
`;
}

function routeBSourceHandwritten() {
  return `import { component$, useStyles$ } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';
import { SharedStylePack } from '../../components/shared';

const routeBOnly = '.delivery-route-b-only { background: rgb(255, 226, 180); border: 2px solid rgb(160, 96, 36); }';

export default component$(() => {
  useStyles$(routeBOnly);
  return (
    <main data-testid="route-b">
      <h1>route B</h1>
      <Link href="/" data-testid="to-a">route A</Link>
      <p class="delivery-shared" data-testid="shared-b">shared on B</p>
      <p class="delivery-route-b-only" data-testid="route-b-only">route B only</p>
      <SharedStylePack testId="shared-component-b" />
    </main>
  );
});
`;
}

function entrySsrSource() {
  return `import { renderToStream, type RenderToStreamOptions } from '@qwik.dev/core/server';
import Root from './root';

export default function render(options: RenderToStreamOptions) {
  return renderToStream(<Root />, {
    ...options,
    preloader: process.env.QSTYLE_DELIVERY_PREFETCH === '1',
  });
}
`;
}

function entryNodeServerSource() {
  return `import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQwikRouter } from '@qwik.dev/router/middleware/node';
import render from './entry.ssr';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', 'dist');
const { router, staticFile } = createQwikRouter({ render, static: { root: distDir } });
const port = Number(process.env.PORT ?? 4187);
createServer((request, response) => {
  void staticFile(request, response, () => {
    void router(request, response, () => {
      response.statusCode = 404;
      response.end('not found');
    });
  });
}).listen(port, '127.0.0.1', () => {
  console.log('[qstyle-delivery] listening on ' + port);
});
`;
}

function viteConfigSource(mode) {
  const plugin = mode === 'native'
    ? 'qstyleNative()'
    : mode === 'legacy'
      ? `qstyle({ routes: {
    '/': ['/src/routes/index.tsx', '/src/components/shared.qstyle.ts', '/src/components/shared.tsx', '/src/components/scoped-control.tsx', '/src/components/lazy-owner.tsx'],
    '/route-b': ['/src/routes/route-b/index.tsx', '/src/components/shared.qstyle.ts', '/src/components/shared.tsx'],
  } })`
      : '';
  const pluginLine = plugin === '' ? '' : `    ${plugin},\n`;
  return `import { defineConfig } from 'vite';
import { qwikVite } from '@qwik.dev/core/optimizer';
import { qwikCity } from '@qwik.dev/router/vite';
${mode === 'native' ? `import { qstyleNative } from ${json(viteEntry)};` : ''}
${mode === 'legacy' ? `import { qstyle } from ${json(viteEntry)};` : ''}

export default defineConfig({
  plugins: [
    qwikCity(),
${pluginLine}    qwikVite({ entryStrategy: { type: 'segment' } }),
  ],
  resolve: {
    alias: [{ find: /^@qstyle\\/qwik$/, replacement: ${json(qwikAuthoringEntry)} }],
  },
});
`;
}

function serverConfigSource() {
  return `import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeServerAdapter } from '@qwik.dev/router/adapters/node-server/vite';
import { extendConfig } from '@qwik.dev/router/vite';
import baseConfig from './vite.config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export default extendConfig(baseConfig, () => ({
  build: {
    ssr: true,
    rolldownOptions: { input: [path.resolve(here, 'src/entry.node-server.tsx')] },
  },
  environments: {
    client: { build: { outDir: path.resolve(here, 'dist') } },
  },
  plugins: [nodeServerAdapter({ name: 'node-server' })],
}));
`;
}

async function writeFixture(variantRoot, mode) {
  const files = new Map([
    ['package.json', { name: `qstyle-delivery-${mode}`, private: true, type: 'module' }],
    ['tsconfig.json', {
      compilerOptions: { jsx: 'react-jsx', jsxImportSource: '@builder.io/qwik', module: 'ESNext', target: 'ES2022', strict: true, skipLibCheck: true },
      include: ['src'],
    }],
    ['vite.config.ts', viteConfigSource(mode)],
    ['server.vite.config.ts', serverConfigSource()],
    ['src/root.tsx', rootSource()],
    ['src/entry.ssr.tsx', entrySsrSource()],
    ['src/entry.node-server.tsx', entryNodeServerSource()],
    ['src/components/shared.tsx', sharedComponentSource(mode)],
    ['src/components/lazy-owner.tsx', lazySource(mode)],
    ['src/components/scoped-control.tsx', scopedSource()],
    ['src/shared.qstyle.ts', sharedSource(mode)],
    ['src/routes/index.tsx', routeASource(mode)],
    ['src/routes/route-b/index.tsx', mode === 'handwritten' ? routeBSourceHandwritten() : routeBSource(mode)],
  ]);
  for (const [file, contents] of files) {
    const target = join(variantRoot, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
  }
  await ensureSymlink(stockCore, join(variantRoot, 'node_modules/@qwik.dev/core'));
  await ensureSymlink(stockRouter, join(variantRoot, 'node_modules/@qwik.dev/router'));
}

function runProcess(command, args, options = {}) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectProcess);
    child.once('close', (code, signal) => resolveProcess({ code, signal, stdout, stderr }));
  });
}

async function buildVariant(variantRoot) {
  const { build, createBuilder } = await import('vite');
  process.env.NODE_ENV = 'production';
  const env = shellEnv(process.env.QSTYLE_DELIVERY_PREFETCH === '1');
  process.env.QSTYLE_NAMED_IMPORT = env.QSTYLE_NAMED_IMPORT;
  process.env.QSTYLE_DELIVERY_PREFETCH = env.QSTYLE_DELIVERY_PREFETCH;
  process.env.VITE_DELIVERY_PREFETCH = env.VITE_DELIVERY_PREFETCH;
  await build({ root: variantRoot, logLevel: 'warn', mode: 'production' });
  const builder = await createBuilder({
    root: variantRoot,
    logLevel: 'warn',
    mode: 'production',
    configFile: resolve(variantRoot, 'server.vite.config.ts'),
  });
  const ssrEnvironment = builder.environments.ssr;
  if (ssrEnvironment === undefined) throw new Error('ssr environment not found');
  await builder.build(ssrEnvironment);
}

function kindFor(requestUrl, resourceType) {
  const pathname = requestUrl.pathname;
  if (resourceType === 'document') return 'html';
  if (pathname.endsWith('.css')) return 'css';
  if (pathname.endsWith('.js') || pathname.includes('/build/')) return 'js';
  return undefined;
}

function transportBytes(bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    raw: source.byteLength,
    gzip: gzipSync(source).byteLength,
    brotli: brotliCompressSync(source).byteLength,
  };
}

function addBytes(a, b) {
  return { raw: a.raw + b.raw, gzip: a.gzip + b.gzip, brotli: a.brotli + b.brotli };
}

function zeroBytes() {
  return { raw: 0, gzip: 0, brotli: 0 };
}

function parseInlineStyles(body) {
  const html = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
  const styles = [];
  const pattern = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
  for (const match of html.matchAll(pattern)) {
    const attributes = match[1] ?? '';
    const text = match[2] ?? '';
    const id = attributes.match(/q:(?:s?style)=["']([^"']+)["']/i)?.[1] ?? null;
    styles.push({ id, bytes: Buffer.byteLength(text), text });
  }
  return { bytes: styles.reduce((total, style) => total + style.bytes, 0), styles };
}

function classifyBody(record) {
  if (!record.body) return null;
  return transportBytes(record.body);
}

function summarizeTransport(records) {
  const byKind = {
    html: { requests: 0, bytes: zeroBytes(), inlineStyleBytes: 0, inlineStyleIds: [], lazyMarkerBodies: 0 },
    css: { requests: 0, bytes: zeroBytes(), lazyMarkerBodies: 0 },
    js: { requests: 0, bytes: zeroBytes(), qstyleMarkerBodies: 0, lazyMarkerBodies: 0 },
  };
  const resources = [];
  let total = zeroBytes();
  for (const record of records) {
    if (!record.body || record.status == null || record.status < 200 || record.status >= 400) continue;
    const bytes = classifyBody(record);
    if (!bytes) continue;
    const bucket = byKind[record.kind];
    if (!bucket) continue;
    bucket.requests += 1;
    bucket.bytes = addBytes(bucket.bytes, bytes);
    total = addBytes(total, bytes);
    const resource = {
      url: record.path,
      kind: record.kind,
      status: record.status,
      bytes,
      qstyleMarkers: record.kind === 'js' ? markerHits(record.body.toString('utf8')) : [],
    };
    const bodyText = record.body.toString('utf8');
    const hasLazyMarker = bodyText.includes('224, 240, 255') || bodyText.includes('delivery-lazy');
    if (hasLazyMarker) bucket.lazyMarkerBodies += 1;
    resource.lazyMarker = hasLazyMarker;
    if (resource.qstyleMarkers.length > 0) bucket.qstyleMarkerBodies += 1;
    if (record.kind === 'html') {
      const inline = parseInlineStyles(record.body);
      bucket.inlineStyleBytes += inline.bytes;
      bucket.inlineStyleIds.push(...inline.styles.map((style) => style.id).filter(Boolean));
      resource.inlineStyleBytes = inline.bytes;
      resource.inlineStyleIds = inline.styles.map((style) => style.id).filter(Boolean);
    }
    resources.push(resource);
  }
  const requestSet = records.map((record) => ({
    url: record.path,
    kind: record.kind,
    status: record.status,
    responded: record.body !== null,
  }));
  return {
    requests: requestSet.length,
    requestSet,
    resources,
    byKind,
    total,
    lazyMarkerBodies: Object.values(byKind).reduce((totalMarkers, bucket) => totalMarkers + bucket.lazyMarkerBodies, 0),
  };
}

function markerHits(source) {
  const markers = [
    'qstyle-native',
    'retryStyleImport',
    '@qstyle/qwik',
    'qstyle:collected-styles',
    'qstyle-retry',
  ];
  return markers.filter((marker) => source.includes(marker));
}

async function waitForServer(baseUrl, output) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.status === 200) return;
    } catch {
      // The generated server has not started listening yet.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`delivery server did not become ready${output ? `\\n${output}` : ''}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'close'),
    new Promise((done) => setTimeout(done, 2000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function measureInBrowser(baseUrl) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const records = [];
  const requestMap = new Map();
  const bodyPromises = [];
  const errors = [];

  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const requestUrl = new URL(request.url());
    const kind = kindFor(requestUrl, request.resourceType());
    if (!kind) return;
    const record = {
      sequence: records.length,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      kind,
      status: null,
      body: null,
    };
    records.push(record);
    requestMap.set(request, record);
  });
  page.on('response', (response) => {
    const record = requestMap.get(response.request());
    if (!record) return;
    record.status = response.status();
    const promise = response.body().then((body) => { record.body = body; }).catch(() => {});
    bodyPromises.push(promise);
  });

  async function settle() {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(100);
    await Promise.allSettled(bodyPromises.splice(0));
  }

  async function snapshot(name, cursor) {
    await settle();
    const selected = records.slice(cursor);
    return { name, cursor: records.length, transport: summarizeTransport(selected) };
  }

  async function styleState() {
    return page.evaluate(() => {
      const styleNodes = [...document.querySelectorAll('style')]
        .filter((node) => node.hasAttribute('q:style') || node.hasAttribute('q:sstyle'));
      let cssomText = '';
      for (const sheet of [...document.styleSheets]) {
        try {
          cssomText += [...sheet.cssRules].map((rule) => rule.cssText).join('\\n');
        } catch {
          // Same-origin build payloads are the only sheets used here.
        }
      }
      const get = (selector, property) => {
        const element = document.querySelector(selector);
        return element ? getComputedStyle(element).getPropertyValue(property).trim() : null;
      };
      return {
        routeA: Boolean(document.querySelector('[data-testid="route-a"]')),
        routeB: Boolean(document.querySelector('[data-testid="route-b"]')),
        lazyCount: document.querySelectorAll('[data-testid="lazy-owner"]').length,
        styleIds: styleNodes.map((node) => node.getAttribute('q:style') ?? node.getAttribute('q:sstyle')),
        sharedColor: get('[data-testid="shared-a"], [data-testid="shared-b"]', 'color'),
        routeAOutside: get('[data-testid="route-a-outside"]', 'color'),
        scopedInside: get('[data-testid="scoped-inside"]', 'color'),
        scopedChildBackground: get('[data-testid="scoped-child"]', 'background-color'),
        routeBBackground: get('[data-testid="route-b-only"]', 'background-color'),
        routeBBorderTop: get('[data-testid="route-b-only"]', 'border-top-width'),
        lazyBackground: get('[data-testid="lazy-owner"]', 'background-color'),
        lazyBorderTop: get('[data-testid="lazy-owner"]', 'border-top-width'),
        cssomHasLazyRule: cssomText.includes('224, 240, 255') || cssomText.includes('delivery-lazy'),
        shellInput: document.querySelector('[data-testid="shell-input"]')?.value ?? null,
        shellStatus: document.querySelector('[data-testid="shell-status"]')?.textContent ?? null,
        pageToken: document.querySelector('[data-testid="persistent-shell"]')?.getAttribute('data-page-token') ?? null,
      };
    });
  }

  function computedCheck(state, phase) {
    const required = phase === 'routeB'
      ? {
          routeB: true,
          routeA: false,
          sharedColor: expectedStyles.sharedColor,
          routeBBackground: expectedStyles.routeBBackground,
          routeBBorderTop: expectedStyles.routeBBorderTop,
        }
      : phase === 'lazy'
        ? {
            routeA: true,
            routeB: false,
            sharedColor: expectedStyles.sharedColor,
            routeAOutside: expectedStyles.routeAOutside,
            scopedInside: expectedStyles.scopedInside,
            scopedChildBackground: expectedStyles.scopedChildBackground,
            lazyBackground: expectedStyles.lazyBackground,
            lazyBorderTop: expectedStyles.lazyBorderTop,
          }
        : {
            routeA: true,
            routeB: false,
            sharedColor: expectedStyles.sharedColor,
            routeAOutside: expectedStyles.routeAOutside,
            scopedInside: expectedStyles.scopedInside,
            scopedChildBackground: expectedStyles.scopedChildBackground,
          };
    const mismatches = [];
    for (const [key, value] of Object.entries(required)) {
      if (state[key] !== value) mismatches.push({ key, expected: value, actual: state[key] });
    }
    if (phase !== 'lazy' && state.lazyCount !== 0) mismatches.push({ key: 'lazyCount', expected: 0, actual: state.lazyCount });
    return { pass: mismatches.length === 0, mismatches };
  }

  const phases = [];
  let cursor = 0;
  try {
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    const initialState = await styleState();
    const initialCheck = computedCheck(initialState, 'initial');
    const initial = await snapshot('initial', cursor);
    cursor = initial.cursor;
    phases.push({ ...initial, state: initialState, computed: initialCheck });

    await page.locator('[data-testid="shell-input"]').fill('kept through routes');
    await page.locator('[data-testid="shell-update"]').click();
    await page.evaluate(() => { window.__deliveryDocument = document; });

    await Promise.all([
      page.waitForURL(/\/route-b\/?$/),
      page.locator('[data-testid="to-b"]').click(),
    ]);
    await page.locator('[data-testid="route-b"]').waitFor();
    const routeBState = await styleState();
    const routeBCheck = computedCheck(routeBState, 'routeB');
    const routeBStateRetention = {
      sameDocument: await page.evaluate(() => window.__deliveryDocument === document),
      input: routeBState.shellInput === 'kept through routes',
      status: routeBState.shellStatus === 'updated',
      token: routeBState.pageToken === 'delivery-page',
    };
    const routeB = await snapshot('routeB', cursor);
    cursor = routeB.cursor;
    phases.push({ ...routeB, state: routeBState, computed: routeBCheck, stateRetention: routeBStateRetention });

    await Promise.all([
      page.waitForURL((url) => url.pathname === '/'),
      page.locator('[data-testid="to-a"]').click(),
    ]);
    await page.locator('[data-testid="route-a"]').waitFor();
    const backAState = await styleState();
    const backACheck = computedCheck(backAState, 'backA');
    const backAStateRetention = {
      sameDocument: await page.evaluate(() => window.__deliveryDocument === document),
      input: backAState.shellInput === 'kept through routes',
      status: backAState.shellStatus === 'updated',
      token: backAState.pageToken === 'delivery-page',
    };
    const backA = await snapshot('backA', cursor);
    cursor = backA.cursor;
    phases.push({ ...backA, state: backAState, computed: backACheck, stateRetention: backAStateRetention });

    await page.locator('[data-testid="lazy-toggle"]').click();
    await page.locator('[data-testid="lazy-owner"]').first().waitFor();
    const lazyState = await styleState();
    const lazyCheck = computedCheck(lazyState, 'lazy');
    const lazy = await snapshot('lazy', cursor);
    cursor = lazy.cursor;
    phases.push({ ...lazy, state: lazyState, computed: lazyCheck });
  } finally {
    await settle();
    await browser.close();
  }

  return {
    phases,
    errors,
    allComputedParity: phases.every((phase) => phase.computed.pass),
    stateRetention: phases.filter((phase) => phase.stateRetention).every((phase) => Object.values(phase.stateRetention).every(Boolean)),
    initialLazyClean: phases.find((phase) => phase.name === 'initial')?.transport.lazyMarkerBodies === 0,
  };
}

async function runServerMeasurement(variantRoot) {
  const port = 4300 + (process.pid % 500) + Math.floor(Math.random() * 200);
  const serverEntry = resolve(variantRoot, 'server/entry.node-server.js');
  assertAvailable(serverEntry, 'generated node server entry');
  const child = spawn(process.execPath, [serverEntry], {
    cwd: variantRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl, output);
    return await measureInBrowser(baseUrl);
  } finally {
    await stopChild(child);
  }
}

async function buildInventory(variantRoot) {
  const distRoot = resolve(variantRoot, 'dist');
  const files = [];
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        files.push({
          path: relative(distRoot, path),
          ext: extname(path),
          bytes: transportBytes(bytes),
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  }
  await visit(distRoot);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function combinePhaseRecords(result, names) {
  const selected = result.phases.filter((phase) => names.includes(phase.name));
  const transport = selected.reduce((total, phase) => addBytes(total, phase.transport.total), zeroBytes());
  return {
    phases: selected.map((phase) => phase.name),
    requests: selected.reduce((total, phase) => total + phase.transport.requests, 0),
    bytes: transport,
  };
}

function laneCost(run) {
  if (!run.measurement) return null;
  const initial = combinePhaseRecords(run.measurement, ['initial']);
  const operation = combinePhaseRecords(run.measurement, ['routeB', 'backA', 'lazy']);
  const all = combinePhaseRecords(run.measurement, ['initial', 'routeB', 'backA', 'lazy']);
  return { initial, operation, all };
}

function ratio(actual, baseline) {
  if (!baseline || baseline === 0 || actual == null) return null;
  return actual / baseline;
}

function compareRuns(runs, prefetchEnabled) {
  const relevant = runs.filter((run) => run.prefetchEnabled === prefetchEnabled);
  const byLane = Object.fromEntries(relevant.map((run) => [run.lane, run]));
  const native = byLane.qstyleNative;
  const handwritten = byLane.handwrittenNativeQwik;
  const legacy = byLane.legacyQstyle;
  const nativeCost = native && laneCost(native);
  const handwrittenCost = handwritten && laneCost(handwritten);
  const legacyCost = legacy && laneCost(legacy);
  const complete = Boolean(nativeCost && handwrittenCost && legacyCost);
  const gate = complete ? {
    nativeInitialAtMostLegacy: nativeCost.initial.bytes.raw <= legacyCost.initial.bytes.raw,
    nativeAllWithinLegacy105: nativeCost.all.bytes.raw <= legacyCost.all.bytes.raw * 1.05,
    nativeGzipInitialAtMostLegacy: nativeCost.initial.bytes.gzip <= legacyCost.initial.bytes.gzip,
    nativeGzipAllWithinLegacy105: nativeCost.all.bytes.gzip <= legacyCost.all.bytes.gzip * 1.05,
    nativeBrotliInitialAtMostLegacy: nativeCost.initial.bytes.brotli <= legacyCost.initial.bytes.brotli,
    nativeBrotliAllWithinLegacy105: nativeCost.all.bytes.brotli <= legacyCost.all.bytes.brotli * 1.05,
    nativeInitialLazyClean: prefetchEnabled || native.measurement?.initialLazyClean === true,
    handwrittenInitialLazyClean: prefetchEnabled || handwritten.measurement?.initialLazyClean === true,
    legacyInitialLazyClean: legacy.measurement?.initialLazyClean === true,
  } : null;
  return {
    prefetchEnabled,
    complete,
    lanes: Object.fromEntries(relevant.map((run) => [run.lane, {
      build: run.build,
      computedStyleParity: run.measurement?.allComputedParity ?? false,
      stateRetention: run.measurement?.stateRetention ?? false,
      initialLazyClean: run.measurement?.initialLazyClean ?? false,
      cost: laneCost(run),
      qstyleMarkerBodiesProxy: run.measurement
        ? run.measurement.phases.reduce((total, phase) => total + phase.transport.byKind.js.qstyleMarkerBodies, 0)
        : null,
    }])),
    ratios: complete ? {
      nativeVsLegacyInitialRaw: ratio(nativeCost.initial.bytes.raw, legacyCost.initial.bytes.raw),
      nativeVsLegacyOperationRaw: ratio(nativeCost.operation.bytes.raw, legacyCost.operation.bytes.raw),
      nativeVsLegacyAllRaw: ratio(nativeCost.all.bytes.raw, legacyCost.all.bytes.raw),
      nativeVsLegacyInitialGzip: ratio(nativeCost.initial.bytes.gzip, legacyCost.initial.bytes.gzip),
      nativeVsLegacyOperationGzip: ratio(nativeCost.operation.bytes.gzip, legacyCost.operation.bytes.gzip),
      nativeVsLegacyAllGzip: ratio(nativeCost.all.bytes.gzip, legacyCost.all.bytes.gzip),
      nativeVsLegacyInitialBrotli: ratio(nativeCost.initial.bytes.brotli, legacyCost.initial.bytes.brotli),
      nativeVsLegacyOperationBrotli: ratio(nativeCost.operation.bytes.brotli, legacyCost.operation.bytes.brotli),
      nativeVsLegacyAllBrotli: ratio(nativeCost.all.bytes.brotli, legacyCost.all.bytes.brotli),
      nativeVsHandwrittenInitialRaw: ratio(nativeCost.initial.bytes.raw, handwrittenCost.initial.bytes.raw),
      nativeVsHandwrittenOperationRaw: ratio(nativeCost.operation.bytes.raw, handwrittenCost.operation.bytes.raw),
    } : null,
    gate,
    releaseGate: complete && Boolean(gate)
      && Object.entries(gate).filter(([key]) => key !== 'legacyInitialLazyClean').every(([, pass]) => pass)
      && relevant.every((run) => run.measurement?.allComputedParity
        && run.measurement?.stateRetention),
  };
}

async function runParent() {
  assertAvailable(viteEntry, 'built public @qstyle/vite entry');
  assertAvailable(qwikAuthoringEntry, 'built public @qstyle/qwik entry');
  assertAvailable(stockCore, 'stock @qwik.dev/core');
  assertAvailable(stockRouter, 'stock @qwik.dev/router');
  const corePackage = JSON.parse(await readFile(resolve(stockCore, 'package.json'), 'utf8'));
  const routerPackage = JSON.parse(await readFile(resolve(stockRouter, 'package.json'), 'utf8'));
  if (corePackage.version !== '2.0.0-beta.43') {
    throw new Error(`delivery comparison requires unmodified Qwik beta.43; found ${corePackage.version}`);
  }

  await mkdir(workRoot, { recursive: true });
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });
  const startedAt = new Date().toISOString();
  const runs = [];
  try {
    for (const prefetch of prefetchModes) {
      for (const lane of lanes) {
        const laneRoot = resolve(runRoot, `${lane.mode}-${prefetch.key}`);
        await mkdir(laneRoot, { recursive: true });
        await writeFixture(laneRoot, lane.mode);
        const buildResult = await runProcess(process.execPath, [scriptPath, '--build', laneRoot], {
          cwd: repoRoot,
          env: shellEnv(prefetch.enabled),
        });
        const run = {
          lane: lane.key,
          label: lane.label,
          prefetchEnabled: prefetch.enabled,
          root: laneRoot,
          build: {
            pass: buildResult.code === 0,
            exitCode: buildResult.code,
            signal: buildResult.signal,
            stdoutTail: buildResult.stdout.slice(-4000),
            stderrTail: buildResult.stderr.slice(-4000),
          },
        };
        if (buildResult.code === 0) {
          try {
            run.inventory = await buildInventory(laneRoot);
            run.measurement = await runServerMeasurement(laneRoot);
          } catch (error) {
            run.measurementError = safeError(error);
          }
        } else if (lane.mode === 'legacy') {
          run.legacyCapability = 'build-failed-for-this-equivalent-input';
        }
        runs.push(run);
      }
    }
  } finally {
    if (process.env.QSTYLE_DELIVERY_KEEP !== '1') await rm(runRoot, { recursive: true, force: true });
  }

  const comparisons = prefetchModes.map((prefetch) => compareRuns(runs, prefetch.enabled));
  const report = {
    schema: 'qstyle.delivery-cost.v1',
    generatedAt: new Date().toISOString(),
    startedAt,
    command: 'node scripts/measure-native-delivery.mjs',
    protocol: {
      browser: 'Playwright Chromium headless',
      network: 'localhost HTTP/1.1, no artificial throttling, cold page context per lane',
      source: 'isolated generated copies of the named routing A/B/lazy semantic fixture',
      routes: ['/', '/route-b/'],
      sequence: ['initial', 'routeB', 'backA', 'lazy'],
      transfer: 'successful browser response bodies, each counted per request; raw, gzip, and Brotli bytes',
      inlineStyle: 'CSS text bytes inside HTML <style> elements, reported separately from full HTML bytes',
      prefetch: 'Link prefetch and SSR preloader are compiled separately with VITE_DELIVERY_PREFETCH/QSTYLE_DELIVERY_PREFETCH',
      gate: 'initial compares initial only; operation metrics are incremental, while the 105% operation gate uses cumulative initial+routeB+backA+lazy bytes',
      runtimeProxy: 'qstyle marker body counts are a heuristic body-content proxy, not a proof of module identity or runtime reachability',
    },
    dependencies: {
      qwikCore: { version: corePackage.version, resolved: realpathSync(stockCore), unmodifiedBeta43: true },
      qwikRouter: { version: routerPackage.version, resolved: realpathSync(stockRouter) },
      qstyleViteEntry: viteEntry,
      qstyleQwikEntry: qwikAuthoringEntry,
    },
    expectedStyles,
    comparisons,
    runs: runs.map((run) => ({
      lane: run.lane,
      label: run.label,
      prefetchEnabled: run.prefetchEnabled,
      build: run.build,
      legacyCapability: run.legacyCapability,
      measurementError: run.measurementError,
      inventory: run.inventory,
      measurement: run.measurement,
      cost: laneCost(run),
    })),
    uncertainty: [
      'This is a small routing fixture; it is a D0 cost comparison, not a large consumer benchmark.',
      'No network throttling is applied. Raw/compressed transfer counts are deterministic response-body measurements; browser timing is intentionally omitted.',
      'A lane with a failed build is reported as unsupported for this equivalent input and is excluded from release-gate arithmetic.',
    ],
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ outputPath, comparisons: comparisons.map(({ prefetchEnabled, complete, releaseGate }) => ({ prefetchEnabled, complete, releaseGate })) })}\n`);
  if (runs.some((run) => !run.build.pass || !run.measurement || run.measurementError)
    || comparisons.some((comparison) => !comparison.releaseGate)) process.exitCode = 1;
}

if (process.argv[2] === '--build') {
  const variantRoot = process.argv[3];
  if (!variantRoot) throw new Error('Usage: measure-native-delivery.mjs --build <fixture-root>');
  await buildVariant(resolve(variantRoot));
} else {
  await runParent();
}
