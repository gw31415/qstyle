import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { chromium, expect } from '@playwright/test';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), 'dist');
const files = await readdir(resolve(directory, 'build'));
const payloads = [];
for (const name of files.filter((name) => name.endsWith('.js'))) {
  if ((await readFile(resolve(directory, 'build', name), 'utf8')).includes('230, 240, 255')) payloads.push(name);
}
assert.equal(payloads.length, 1, 'one late CSS payload is required for the delivery probe');
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = resolve(directory, path === '/' ? 'index.html' : `.${decodeURIComponent(path)}`);
    if (!file.startsWith(directory + '/')) return response.writeHead(403).end();
    response.setHeader('content-type', extname(file) === '.js' ? 'text/javascript' : 'text/html');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
  const page = await browser.newPage();
  let unlock;
  let requested;
  const gate = new Promise((done) => { unlock = done; });
  const started = new Promise((done) => { requested = done; });
  await page.route(`**/build/${payloads[0]}`, async (route) => {
    requested();
    await gate;
    await route.continue();
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
  await page.locator('#show').click();
  await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('late CSS not requested')), 5000))]);
  // Observe actual animation frames while CSS is deliberately unavailable.
  const visibleFrames = await page.evaluate(async () => {
    let seen = 0;
    for (let i = 0; i < 8; i++) {
      await new Promise(requestAnimationFrame);
      if (document.querySelector('#lazy')) seen++;
    }
    return seen;
  });
  unlock();
  await expect(page.locator('#lazy')).toHaveCSS('background-color', 'rgb(230, 240, 255)');
  checks.push({ name: 'no lazy element is exposed in frames before its CSS resolves', pass: visibleFrames === 0, visibleFrames });
  await page.close();

  if (process.env.QSTYLE_CONTRACT_RETRY) {
    const retry = await browser.newPage();
    let attempts = 0;
    const errors = [];
    retry.on('pageerror', (error) => errors.push(error.message));
    const failures = process.env.QSTYLE_CONTRACT_RETRY === 'baseline' ? 1 : 2;
    const requestedUrls = [];
    await retry.route(`**/build/${payloads[0]}*`, async (route) => {
      requestedUrls.push(route.request().url());
      if (++attempts <= failures) await route.abort('failed');
      else await route.continue();
    });
    await retry.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
    await retry.locator('#show').click();
    await expect.poll(() => attempts).toBe(failures);
    await retry.waitForLoadState('networkidle');
    const failedMount = await retry.locator('#lazy').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));
    await retry.locator('#show').click();
    await expect(retry.locator('#lazy')).toHaveCount(0);
    await retry.locator('#show').click();
    try {
      await expect(retry.locator('#lazy')).toHaveCSS('background-color', 'rgb(230, 240, 255)');
      expect(attempts).toBe(failures + 1);
      expect(new Set(requestedUrls).size).toBe(attempts);
      checks.push({ name: 'a new owner retries a failed CSS chunk', pass: true, attempts, requestedUrls, failedMount, errors });
    } catch (error) {
      checks.push({ name: 'a new owner retries a failed CSS chunk', pass: false, attempts, requestedUrls, failedMount, errors, error: error.message });
    }
    await retry.close();
  }
  console.log(JSON.stringify({ checks }, null, 2));
  if (checks.some((check) => !check.pass)) process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
