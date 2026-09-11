import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { prepareQwik } from './prepare-qwik.mjs';

const qwikMode = await prepareQwik(dirname(fileURLToPath(import.meta.url)));
const root = resolve(process.env.QSTYLE_HMR_ROOT ?? dirname(fileURLToPath(import.meta.url)));
const source = resolve(root, 'src/root.tsx');
const original = await readFile(source, 'utf8');
const unoConfig = resolve(root, 'uno.config.ts');
const originalConfig = process.env.QSTYLE_HMR_ROOT ? undefined : await readFile(unoConfig, 'utf8');
const server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'compiler-contract-render',
  configureServer(dev) {
    dev.middlewares.use(async (request, response, next) => {
      if (request.url !== '/') return next();
      try {
        const entry = await dev.ssrLoadModule('/src/entry.ssr.tsx');
        const rendered = await entry.default({ url: 'http://localhost/', preloader: false });
        response.setHeader('content-type', 'text/html');
        // Qwik Router normally injects this standard framework bridge into its SSR head.
        const html = rendered.html.replace('</head>', '<script type="module" src="/@id/@qwik-hmr-bridge"></script></head>');
        response.end(await dev.transformIndexHtml('/', html));
      } catch (error) {
        dev.ssrFixStacktrace(error);
        response.writeHead(500, { 'content-type': 'text/plain' }); response.end(error.stack);
      }
    });
  },
}] });
let browser;
let page;
let edited = false;
let activeCheck = 'CSS HMR preserves document, signal, input, focus and scroll';
const report = { qwikMode, checks: [], console: [], errors: [], navigations: 0 };
const configErrors = [];
report.watchEvents = [];
report.hotMessages = [];
server.watcher.on('change', (file) => { if (report.watchEvents.length < 20) report.watchEvents.push(file); });
const graphState = () => {
  const plugin = server.config.plugins.find((plugin) => plugin.name === 'qstyle-native');
  return Object.fromEntries(['default', 'ssr', 'client'].map((name) => {
    const graph = plugin?.api.getGraph(name);
    return [name, graph ? { generation: graph.generation, css: graph.program.packs.map((pack) => pack.css) } : null];
  }));
};
try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
    if (report.hotMessages.length < 20) report.hotMessages.push(String(payload).slice(0, 2000));
    try {
      const message = JSON.parse(String(payload));
      if (message.type === 'error') configErrors.push(message.err?.message ?? message.err);
    } catch {}
  }));
  page.on('console', (message) => {
    const text = message.text().slice(0, 1500);
    if (report.console.length < 40 && !report.console.includes(text)) report.console.push(text);
  });
  page.on('pageerror', (error) => {
    if (report.errors.length < 40 && !report.errors.includes(error.message)) report.errors.push(error.message);
  });
  const response = await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'networkidle' });
  if (!response.ok()) throw new Error(await response.text());
  await expect(page.locator('#width')).toHaveCSS('color', 'rgb(12, 34, 56)');
  await page.locator('#grow').click();
  await expect(page.locator('#width')).toHaveCSS('width', '101px');
  await page.locator('#input').fill('kept during hmr');
  await page.locator('#input').focus();
  await page.evaluate(() => {
    document.body.style.minHeight = '2400px';
    // Disable native scroll anchoring so this assertion measures HMR scroll preservation.
    document.body.style.overflowAnchor = 'none';
    window.scrollTo(0, 200);
    window.__fixtureDocument = 'same-document';
  });
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) report.navigations++; });
  edited = true;
  report.graphBefore = graphState();
  await writeFile(source, original.replace('rgb(12, 34, 56)', 'rgb(56, 34, 12)'));
  await expect(page.locator('#width')).toHaveCSS('color', 'rgb(56, 34, 12)', { timeout: 10000 });
  await expect(page.locator('#width')).toHaveCSS('width', '101px');
  await expect(page.locator('#input')).toHaveValue('kept during hmr');
  await expect(page.locator('#input')).toBeFocused();
  const state = await page.evaluate(() => ({ marker: window.__fixtureDocument, scroll: window.scrollY }));
  expect(state).toEqual({ marker: 'same-document', scroll: 200 });
  expect(report.navigations).toBe(0);
  expect(report.errors).toEqual([]);
  report.checks.push({ name: activeCheck, pass: true });
  if (!process.env.QSTYLE_HMR_ROOT) {
    for (const [name, content, color] of [
      ['removing a shared declaration clears its live CSS', original.replace("color: 'rgb(12, 34, 56)'", ''), 'rgb(0, 0, 0)'],
      ['readding a shared declaration restores its live CSS', original, 'rgb(12, 34, 56)'],
    ]) {
      activeCheck = name;
      await writeFile(source, content);
      await expect(page.locator('#width')).toHaveCSS('color', color, { timeout: 10000 });
      await expect(page.locator('#width')).toHaveCSS('width', '101px');
      await expect(page.locator('#input')).toHaveValue('kept during hmr');
      await expect(page.locator('#input')).toBeFocused();
      expect(await page.evaluate(() => ({ marker: window.__fixtureDocument, scroll: window.scrollY })))
        .toEqual({ marker: 'same-document', scroll: 200 });
      expect(report.navigations).toBe(0);
      expect(report.errors).toEqual([]);
      report.checks.push({ name, pass: true });
    }
    for (const [name, content, padding, color] of [
      ['Uno config edits update utilities and root foundation', originalConfig.replace("padding: '8px'", "padding: '16px'").replace('rgb(20, 40, 60)', 'rgb(60, 40, 20)'), '16px', 'rgb(60, 40, 20)'],
      ['removing the Uno foundation clears its live CSS', originalConfig.replace("preflights: [{ getCSS: () => ':root{--contract-foundation:rgb(20, 40, 60)}' }],", 'preflights: [],'), '8px', 'rgb(0, 0, 0)'],
      ['restoring the Uno foundation restores its live CSS', originalConfig, '8px', 'rgb(20, 40, 60)'],
    ]) {
      activeCheck = name;
      await writeFile(unoConfig, content);
      await expect(page.locator('#utility')).toHaveCSS('padding', padding, { timeout: 10000 });
      await expect(page.locator('#utility')).toHaveCSS('color', color, { timeout: 10000 });
      await expect(page.locator('#width')).toHaveCSS('width', '101px');
      await expect(page.locator('#input')).toHaveValue('kept during hmr');
      await expect(page.locator('#input')).toBeFocused();
      expect(await page.evaluate(() => ({ marker: window.__fixtureDocument, scroll: window.scrollY })))
        .toEqual({ marker: 'same-document', scroll: 200 });
      expect(report.navigations).toBe(0);
      expect(report.errors).toEqual([]);
      report.checks.push({ name, pass: true });
    }
    activeCheck = 'failed Uno config retains the last working generation and recovers';
    const beforeError = graphState();
    await writeFile(unoConfig, 'export default { rules: [');
    await expect.poll(() => configErrors.length, { timeout: 10000 }).toBeGreaterThan(0);
    expect(graphState()).toEqual(beforeError);
    await expect(page.locator('#utility')).toHaveCSS('padding', '8px');
    await expect(page.locator('#utility')).toHaveCSS('color', 'rgb(20, 40, 60)');
    await writeFile(unoConfig, originalConfig.replace("padding: '8px'", "padding: '24px'"));
    await expect(page.locator('#utility')).toHaveCSS('padding', '24px', { timeout: 10000 });
    await expect(page.locator('#width')).toHaveCSS('width', '101px');
    await expect(page.locator('#input')).toHaveValue('kept during hmr');
    expect(report.navigations).toBe(0);
    expect(report.errors).toEqual([]);
    report.expectedConfigErrors = configErrors;
    report.checks.push({ name: activeCheck, pass: true });
    activeCheck = 'an unproven document root retains the working graph and recovers';
    const beforeRootError = graphState();
    const previousErrorCount = configErrors.length;
    await writeFile(source, original.replace('<head>', '<section>').replace('</head>', '</section>'));
    await expect.poll(() => configErrors.length, { timeout: 10000 }).toBeGreaterThan(previousErrorCount);
    expect(configErrors.slice(previousErrorCount).join('\n')).toContain('QS1103');
    expect(graphState()).toEqual(beforeRootError);
    await expect(page.locator('#utility')).toHaveCSS('padding', '24px');
    await expect(page.locator('#utility')).toHaveCSS('color', 'rgb(20, 40, 60)');
    await writeFile(source, original.replace('rgb(12, 34, 56)', 'rgb(60, 34, 12)'));
    await expect(page.locator('#width')).toHaveCSS('color', 'rgb(60, 34, 12)', { timeout: 10000 });
    await expect(page.locator('#width')).toHaveCSS('width', '101px');
    await expect(page.locator('#input')).toHaveValue('kept during hmr');
    expect(report.navigations).toBe(0);
    expect(report.errors).toEqual([]);
    report.checks.push({ name: activeCheck, pass: true });
  }
} catch (error) {
  report.styles = await page?.locator('style[q\\:style]').evaluateAll((styles) => styles.map((style) => ({ id: style.getAttribute('q:style'), css: style.textContent })));
  report.checks.push({ name: activeCheck, pass: false, error: error.message });
  process.exitCode = 1;
} finally {
  report.graphAfter = graphState();
  if (edited) await writeFile(source, original);
  if (originalConfig !== undefined) await writeFile(unoConfig, originalConfig);
  await browser?.close();
  await server.close();
  await mkdir(resolve(root, '../../.qstyle'), { recursive: true });
  await writeFile(resolve(root, `../../.qstyle/compiler-hmr${process.env.QSTYLE_HMR_ROOT ? '-reference' : ''}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
process.exit(process.exitCode ?? 0);
