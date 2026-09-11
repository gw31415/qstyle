#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';

process.env.QSTYLE_NAMED_IMPORT ??= '1';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = fileURLToPath(new URL('../src/routes/route-b/index.tsx', import.meta.url));
const original = await readFile(source, 'utf8');
const marker = "backgroundColor: 'rgb(255, 226, 180)'";
const edited = original.replace(marker, "backgroundColor: 'rgb(180, 226, 255)'");
if (edited === original) throw new Error('route B HMR source marker missing');

const report = { checks: [], errors: [], navigations: 0 };
let server;
let browser;
try {
  await writeFile(source, edited);
  server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (error) => report.errors.push(error.message));
  const address = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${address.port}/route-b/`, { waitUntil: 'networkidle' });
  await expect(page.locator('[data-testid="route-b-only"]')).toHaveCSS('background-color', 'rgb(180, 226, 255)');
  await page.locator('[data-testid="shell-input"]').fill('keep during hmr');
  await page.locator('[data-testid="shell-update"]').click();
  await expect(page.locator('[data-testid="shell-status"]')).toHaveText('updated');
  await page.evaluate(() => { window.__namedRouteHmrDocument = document; });
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) report.navigations++; });

  const next = edited.replace("backgroundColor: 'rgb(180, 226, 255)'", "backgroundColor: 'rgb(180, 255, 226)'");
  await writeFile(source, next);
  await expect(page.locator('[data-testid="route-b-only"]')).toHaveCSS('background-color', 'rgb(180, 255, 226)', { timeout: 10000 });
  await expect(page.locator('[data-testid="shell-input"]')).toHaveValue('keep during hmr');
  await expect(page.locator('[data-testid="shell-status"]')).toHaveText('updated');
  if (!await page.evaluate(() => window.__namedRouteHmrDocument === document)) throw new Error('Document was replaced');
  if (report.navigations !== 0) throw new Error('HMR caused a navigation');
  report.checks.push({ name: 'route CSS HMR keeps document and shell state', pass: true });
  await browser.close();
} catch (error) {
  report.checks.push({ name: 'route CSS HMR keeps document and shell state', pass: false, error: error.message });
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
  await writeFile(source, original);
}
report.checks.push({ name: 'no browser errors', pass: report.errors.length === 0, ...(report.errors.length ? { error: report.errors.join('; ') } : {}) });
console.log(JSON.stringify(report, null, 2));
if (report.checks.some(({ pass }) => !pass)) process.exitCode = 1;
// Qwik's dev optimizer can keep a worker channel alive after Vite closes.
process.exit(process.exitCode ?? 0);
