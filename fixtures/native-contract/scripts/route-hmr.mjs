import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = new URL('../src/routes/route-b/index.tsx', import.meta.url);
const original = await readFile(source, 'utf8');
const fixture = original.replace('class="adapter-route-only">', 'class="adapter-route-only" css={{marginTop:"29px"}}><input data-testid="hmr-input"/>');
if (fixture === original) throw new Error('Route HMR fixture source marker missing');
let server;
let browser;
const report = { checks: [], errors: [], navigations: 0 };
try {
  await writeFile(source, fixture);
  server = await createServer({ root, logLevel: 'warn', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (error) => report.errors.push(error.message));
  const address = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${address.port}/route-b/`, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('route-b')).toHaveCSS('padding-top', '23px');
  await expect(page.getByTestId('route-b')).toHaveCSS('margin-top', '29px');
  report.checks.push({ name: 'Router dev SSR discovers route-only utility and native CSS', pass: true });
  await page.getByTestId('hmr-input').fill('keep me');
  await page.evaluate(() => { window.__qstyleRouteDocument = document; });
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) report.navigations++; });
  await writeFile(source, fixture.replace('marginTop:"29px"', 'marginTop:"31px"'));
  await expect(page.getByTestId('route-b')).toHaveCSS('margin-top', '31px');
  await expect(page.getByTestId('hmr-input')).toHaveValue('keep me');
  if (!await page.evaluate(() => window.__qstyleRouteDocument === document)) throw new Error('Document was replaced');
  if (report.navigations || report.errors.length) throw new Error('Navigation or browser errors during route CSS HMR');
  report.checks.push({ name: 'Router CSS HMR retains the document and edited input', pass: true });
} catch (error) {
  report.checks.push({ name: 'Router route HMR acceptance', pass: false, error: error.stack });
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
  await writeFile(source, original);
  console.log(JSON.stringify(report, null, 2));
}
