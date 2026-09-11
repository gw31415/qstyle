import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { chromium, expect } from '@playwright/test';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = resolve(dist, path === '/' ? 'index.html' : `.${decodeURIComponent(path)}`);
    if (!file.startsWith(dist + '/')) { response.writeHead(403).end(); return; }
    const data = await readFile(file);
    response.setHeader('content-type', extname(file) === '.js' ? 'text/javascript' : extname(file) === '.json' ? 'application/json' : 'text/html');
    response.end(data);
  } catch { response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
const responses = [];
const bodyTasks = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  if (!response.url().includes('/build/')) return;
  bodyTasks.push(response.text().then((body) => responses.push({ url: response.url(), status: response.status(), body })).catch(() => {}));
});
const result = { checks: [] };
async function check(name, action) {
  try { await action(); result.checks.push({ name, pass: true }); }
  catch (error) { result.checks.push({ name, pass: false, error: error.message }); }
}
try {
  if (process.env.QSTYLE_CONTRACT_HEAD || process.env.QSTYLE_NAMED_HEAD) await check('head delivery preserves SSR selectors with JavaScript disabled', async () => {
    const ssrPage = await browser.newPage({ javaScriptEnabled: false });
    try {
      await ssrPage.goto(`http://127.0.0.1:${address.port}/`);
      const bodyStyles = await ssrPage.locator('body style[q\\:style]').allTextContents();
      expect(bodyStyles).toHaveLength(process.env.QSTYLE_NAMED_HEAD ? 2 : 0);
      expect(bodyStyles.every((text) => text.includes('.named-hook-global') || text.includes('.named-hook-scoped'))).toBe(true);
      await expect(ssrPage.locator('#structure-first')).toHaveCSS('color', 'rgb(100, 0, 100)');
      await expect(ssrPage.locator('#structure-second')).toHaveCSS('color', 'rgb(0, 100, 100)');
      await expect(ssrPage.locator('#head-order')).toHaveCSS('color', 'rgb(0, 100, 0)');
    } finally { await ssrPage.close(); }
  });
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'networkidle' });
  await Promise.all(bodyTasks);
  result.initialResponses = responses.map(({ url, status }) => ({ url, status }));
  await check('initial SSR and CSSOM contain no lazy-only declaration', async () => {
    const html = await readFile(resolve(dist, 'index.html'), 'utf8');
    expect(html).not.toContain('230, 240, 255');
    expect(await page.locator('#lazy').count()).toBe(0);
    const css = await page.locator('style').allTextContents();
    expect(css.join('')).not.toContain('230, 240, 255');
    expect(responses.some(({ body }) => body.includes('230, 240, 255'))).toBe(false);
  });
  await check('initial static and numeric styles compute correctly', async () => {
    await expect(page.locator('#width')).toHaveCSS('width', '100px');
    await expect(page.locator('#width')).toHaveCSS('color', 'rgb(12, 34, 56)');
  });
  await check('SSR style delivery preserves first-child and adjacent sibling selectors', async () => {
    await expect(page.locator('#structure-first')).toHaveCSS('color', 'rgb(100, 0, 100)');
    await expect(page.locator('#structure-second')).toHaveCSS('color', 'rgb(0, 100, 100)');
  });
  await check('Uno foundation and utilities render with retained anchors and CSS priority', async () => {
    await expect(page.locator('#utility')).toHaveCSS('padding', '8px');
    await expect(page.locator('#utility')).toHaveCSS('border-radius', '0px');
    await expect(page.locator('#utility')).toHaveCSS('color', 'rgb(20, 40, 60)');
    await expect(page.locator('#utility-order')).toHaveCSS('color', 'rgb(0, 100, 0)');
    expect(await page.locator('#utility').getAttribute('class')).toContain('group');
    expect(await page.locator('#utility').getAttribute('class')).not.toContain('contract-');
    expect((await page.locator('head style').allTextContents()).join('')).toContain('--contract-foundation');
    expect((await page.locator('style').allTextContents()).join('')).not.toContain('outline-width:3px');
  });
  await check('finite utility state changes after resume without replacing input', async () => {
    await page.locator('#input').fill('utility retained');
    await page.locator('#round').click();
    await expect(page.locator('#utility')).toHaveCSS('border-radius', '12px');
    await expect(page.locator('#utility')).toHaveCSS('padding', '8px');
    await expect(page.locator('#input')).toHaveValue('utility retained');
  });
  if (process.env.QSTYLE_CONTRACT_WIND4) await check('Wind4 layers, arbitrary values and group selectors compute correctly', async () => {
    await expect(page.locator('#wind4')).toHaveCSS('display', 'flex');
    await expect(page.locator('#wind4-child')).toHaveCSS('width', '123px');
    await page.locator('#wind4').hover();
    await expect(page.locator('#wind4-child')).toHaveCSS('opacity', '0.5');
    expect((await page.locator('style').allTextContents()).join('')).not.toContain('@keyframes');
    expect((await page.locator('head style').allTextContents()).join('')).toContain('.underline{');
  });
  await check('aliased authored hooks preserve nonzero indices, scoping, and resume', async () => {
    const global = page.getByTestId('named-global-owner');
    const scoped = page.getByTestId('named-scoped-owner');
    const globalId = await global.getAttribute('data-named-style-id');
    const scopedId = await scoped.getAttribute('data-named-scope-id');
    expect(globalId).toMatch(/-2$/);
    expect(scopedId).toMatch(/-1$/);
    await expect(page.getByTestId('named-global-target')).toHaveCSS('color', 'rgb(24, 88, 150)');
    await expect(page.getByTestId('named-scoped-inside')).toHaveCSS('color', 'rgb(168, 20, 92)');
    await expect(page.getByTestId('named-scoped-child')).toHaveCSS('background-color', 'rgb(246, 224, 236)');
    await expect(page.getByTestId('named-scoped-outside')).toHaveCSS('color', 'rgb(0, 0, 0)');
    await expect(page.getByTestId('named-scoped-outside-child')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.getByTestId('named-retained-input').fill('named preserved');
    await page.getByTestId('named-global-update').click();
    await expect(page.getByTestId('named-global-target')).toHaveText('resumed');
    await expect(page.getByTestId('named-retained-input')).toHaveValue('named preserved');
    expect(await global.getAttribute('data-named-style-id')).toBe(globalId);
    expect(await scoped.getAttribute('data-named-scope-id')).toBe(scopedId);
    await page.getByTestId('named-scoped-update').click();
    await expect(page.getByTestId('named-scoped-inside')).toContainText('scoped resumed');
    await expect(page.getByTestId('named-scoped-inside')).toHaveCSS('color', 'rgb(168, 20, 92)');
    await expect(page.getByTestId('named-scoped-outside')).toHaveCSS('color', 'rgb(0, 0, 0)');
    expect(await scoped.getAttribute('data-named-scope-id')).toBe(scopedId);
  });
  await check('aliased authored lazy hook remounts without duplicate native styles', async () => {
    const toggle = page.getByTestId('named-lazy-toggle');
    const owner = page.getByTestId('named-lazy-owner');
    await expect(owner).toHaveCount(0);
    await toggle.click();
    await expect(owner).toHaveCSS('background-color', 'rgb(224, 240, 255)');
    const id = await owner.getAttribute('data-named-style-id');
    expect(id).toMatch(/-1$/);
    await toggle.click();
    await expect(owner).toHaveCount(0);
    await toggle.click();
    await expect(owner).toHaveCSS('background-color', 'rgb(224, 240, 255)');
    expect(await owner.getAttribute('data-named-style-id')).toBe(id);
    await expect(page.getByTestId('named-retained-input')).toHaveValue('named preserved');
  });
  await page.locator('#input').fill('preserved');
  await check('resume updates numeric CSS from 100px to 101px', async () => {
    await page.locator('#grow').click();
    await expect(page.locator('#width')).toHaveText('101');
    await expect(page.locator('#width')).toHaveCSS('width', '101px');
    await expect(page.locator('#input')).toHaveValue('preserved');
  });
  await check('first lazy render loads only its needed CSS and retains shared color', async () => {
    await page.locator('#show').click();
    await expect(page.locator('#lazy')).toHaveCSS('background-color', 'rgb(230, 240, 255)');
    await expect(page.locator('#lazy')).toHaveCSS('color', 'rgb(12, 34, 56)');
    await expect(page.locator('#lazy')).toHaveCSS('outline-width', '3px');
    if (process.env.QSTYLE_CONTRACT_WIND4) {
      const name = await page.locator('#lazy').evaluate((element) => getComputedStyle(element).animationName);
      expect(name).toMatch(/^qk1_[a-f0-9]{32}$/);
      expect((await page.locator('style').allTextContents()).join('')).toContain(`@keyframes ${name}`);
      await expect(page.locator('#lazy')).toHaveCSS('text-decoration-line', 'underline');
      expect(await page.locator('#lazy').getAttribute('class')).toContain('underline');
    }
  });
  await check('remount keeps each native style ID unique', async () => {
    await page.locator('#show').click();
    await expect(page.locator('#lazy')).toHaveCount(0);
    await page.locator('#show').click();
    await expect(page.locator('#lazy')).toHaveCount(1);
    const ids = await page.locator('style[q\\:style]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('q:style')));
    expect(new Set(ids).size).toBe(ids.length);
  });
  await Promise.all(bodyTasks);
  await check('SSR-inlined shared CSS is never downloaded again for a new owner', async () => {
    const sharedBodies = responses.filter(({ body }) => body.includes('color:rgb(12, 34, 56);'));
    expect(sharedBodies.map(({ url }) => new URL(url).pathname)).toEqual([]);
  });
  if (process.env.QSTYLE_CONTRACT_REMOVAL) await check('removed applied style is restored for a new owner', async () => {
    await page.locator('#show').click();
    await expect(page.locator('#lazy')).toHaveCount(0);
    await page.locator('style[q\\:style]').evaluateAll((nodes) => {
      for (const node of nodes) if (node.textContent.includes('color:rgb(12, 34, 56);')) node.remove();
    });
    await page.locator('#show').click();
    await expect(page.locator('#lazy')).toHaveCSS('color', 'rgb(12, 34, 56)');
  });
  await check('browser has no runtime errors or missing build assets', async () => {
    expect(errors).toEqual([]);
    expect(responses.filter(({ status }) => status !== 200)).toEqual([]);
  });
  result.errors = errors;
  result.assets = responses.map(({ url, status, body }) => ({ url, status, bytes: Buffer.byteLength(body) }));
  await mkdir(resolve(root, '../../.qstyle'), { recursive: true });
  await writeFile(resolve(root, '../../.qstyle/compiler-contract.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (result.checks.some(({ pass }) => !pass)) process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
