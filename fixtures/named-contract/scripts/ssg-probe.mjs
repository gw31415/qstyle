#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:4184';
const fixtureRoot = new URL('..', import.meta.url).pathname;
const buildDir = join(fixtureRoot, 'dist-ssg', 'build');
const sharedColor = /12,\s*34,\s*56/;
const routeOnlyColor = /255,\s*226,\s*180/;
const lazyColor = /224,\s*240,\s*255/;

const result = { checks: [], errors: [], navigations: 0 };
async function check(name, action) {
  try {
    await action();
    result.checks.push({ name, pass: true });
  } catch (error) {
    result.checks.push({ name, pass: false, error: error.message });
  }
}

function parseStyles(html) {
  return [...html.matchAll(/<style\s+(?:q:(?:s?style))="([^"]*)"[^>]*>([\s\S]*?)<\/style>/g)]
    .map(([, id, text]) => ({ id, text }));
}

const builtFiles = await readdir(buildDir);
const builtSource = await Promise.all(
  builtFiles.filter((name) => name.endsWith('.js')).map(async (name) => [
    name,
    await readFile(join(buildDir, name), 'utf8'),
  ]),
);
result.generated = {
  files: builtSource.length,
  sharedBodies: builtSource.filter(([, source]) => sharedColor.test(source)).map(([name]) => name),
  routeOnlyBodies: builtSource.filter(([, source]) => routeOnlyColor.test(source)).map(([name]) => name),
  lazyBodies: builtSource.filter(([, source]) => lazyColor.test(source)).map(([name]) => name),
};

const initialResponse = await fetch(`${baseUrl}/`);
const initialHtml = await initialResponse.text();
const routeBResponse = await fetch(`${baseUrl}/route-b/`);
const routeBHtml = await routeBResponse.text();
result.ssg = {
  initialStatus: initialResponse.status,
  routeBStatus: routeBResponse.status,
  initialHasRouteA: initialHtml.includes('data-testid="route-a"'),
  initialHasRouteB: initialHtml.includes('data-testid="route-b"'),
  routeBHasRouteA: routeBHtml.includes('data-testid="route-a"'),
  routeBHasRouteB: routeBHtml.includes('data-testid="route-b"'),
  initialHasRouteOnlyColor: routeOnlyColor.test(initialHtml),
  routeBHasRouteOnlyColor: routeOnlyColor.test(routeBHtml),
  initialStyles: parseStyles(initialHtml),
  routeBStyles: parseStyles(routeBHtml),
};

await check('SSG emits both routes with route-local markup and CSS', async () => {
  assert.equal(initialResponse.status, 200);
  assert.equal(routeBResponse.status, 200);
  assert.equal(result.ssg.initialHasRouteA, true);
  assert.equal(result.ssg.initialHasRouteB, false);
  assert.equal(result.ssg.routeBHasRouteA, false);
  assert.equal(result.ssg.routeBHasRouteB, true);
  assert.equal(result.ssg.initialHasRouteOnlyColor, false);
  assert.equal(result.ssg.routeBHasRouteOnlyColor, true);
  assert.equal(result.ssg.initialStyles.length > 0, true);
  assert.equal(result.ssg.routeBStyles.length > 0, true);
});

const browser = await chromium.launch({ headless: true });
const jsDisabled = await browser.newContext({ javaScriptEnabled: false });
const staticPage = await jsDisabled.newPage();
try {
  await staticPage.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  await check('JavaScript-disabled route A keeps authored structure and styles', async () => {
    await expect(staticPage.locator('[data-testid="route-a"]')).toHaveCount(1);
    await expect(staticPage.locator('[data-testid="route-b"]')).toHaveCount(0);
    await expect(staticPage.locator('[data-testid="shared-a"]')).toHaveCSS('color', 'rgb(12, 34, 56)');
    await expect(staticPage.locator('[data-testid="scoped-inside"]')).toHaveCSS('color', 'rgb(168, 20, 92)');
    await expect(staticPage.locator('[data-testid="scoped-child"]')).toHaveCSS('background-color', 'rgb(246, 224, 236)');
    await expect(staticPage.locator('[data-testid="scoped-outside"]')).toHaveCSS('color', 'rgb(0, 0, 0)');
  });

  await staticPage.goto(`${baseUrl}/route-b/`, { waitUntil: 'networkidle' });
  await check('JavaScript-disabled route B keeps route-local styles', async () => {
    await expect(staticPage.locator('[data-testid="route-b"]')).toHaveCount(1);
    await expect(staticPage.locator('[data-testid="route-a"]')).toHaveCount(0);
    await expect(staticPage.locator('[data-testid="shared-b"]')).toHaveCSS('color', 'rgb(12, 34, 56)');
    await expect(staticPage.locator('[data-testid="route-b-only"]')).toHaveCSS('background-color', 'rgb(255, 226, 180)');
  });
} finally {
  await jsDisabled.close();
}

const page = await browser.newPage();
const requests = [];
const responses = [];
const responseBodyPromises = [];
page.on('pageerror', (error) => result.errors.push(error.message));
page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) result.navigations++;
});
page.on('request', (request) => {
  const url = new URL(request.url());
  if (url.pathname.startsWith('/build/')) requests.push(url.pathname);
});
page.on('response', (response) => {
  const url = new URL(response.url());
  if (!url.pathname.startsWith('/build/') || !url.pathname.endsWith('.js')) return;
  const record = { path: url.pathname, bodyBytes: 0, shared: false, routeOnly: false, lazy: false };
  responses.push(record);
  responseBodyPromises.push(response.text().then((body) => {
    record.bodyBytes = body.length;
    record.shared = sharedColor.test(body);
    record.routeOnly = routeOnlyColor.test(body);
    record.lazy = lazyColor.test(body);
  }).catch(() => {}));
});

async function settleBodies() {
  await Promise.allSettled(responseBodyPromises.splice(0));
}

async function styleState() {
  return page.evaluate(() => {
    const styleNodes = [...document.querySelectorAll('style')]
      .filter((node) => node.hasAttribute('q:style') || node.hasAttribute('q:sstyle'));
    let cssomText = '';
    for (const sheet of [...document.styleSheets]) {
      try {
        cssomText += [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
      } catch {
        // Same-origin build payloads are the only sheets used by this fixture.
      }
    }
    const getColor = (selector) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element).color : null;
    };
    const getBackground = (selector) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element).backgroundColor : null;
    };
    return {
      styleIds: styleNodes.map((node) => node.getAttribute('q:style') ?? node.getAttribute('q:sstyle')),
      styleCount: styleNodes.length,
      headStyleCount: [...document.head.querySelectorAll('style')]
        .filter((node) => node.hasAttribute('q:style') || node.hasAttribute('q:sstyle')).length,
      cssomText,
      sharedColor: getColor('[data-testid="shared-a"], [data-testid="shared-b"]'),
      routeOnlyBackground: getBackground('[data-testid="route-b-only"]'),
      lazyBackground: getBackground('[data-testid="lazy-owner"]'),
      scopedInside: getColor('[data-testid="scoped-inside"]'),
      scopedOutside: getColor('[data-testid="scoped-outside"]'),
      scopedChildBackground: getBackground('[data-testid="scoped-child"]'),
      lazyCount: document.querySelectorAll('[data-testid="lazy-owner"]').length,
      routeA: document.querySelector('[data-testid="route-a"]') !== null,
      routeB: document.querySelector('[data-testid="route-b"]') !== null,
      shellInput: document.querySelector('[data-testid="shell-input"]')?.value ?? null,
      shellStatus: document.querySelector('[data-testid="shell-status"]')?.textContent ?? null,
      pageToken: document.querySelector('[data-testid="persistent-shell"]')?.getAttribute('data-page-token') ?? null,
    };
  });
}

try {
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  await settleBodies();
  const initial = await styleState();
  const beforeBShared = responses.filter((response) => response.shared).length;
  result.initial = initial;

  await check('resumed SSG route A computes shared and scoped CSS', async () => {
    await expect(page.locator('[data-testid="shared-a"]')).toHaveCSS('color', 'rgb(12, 34, 56)');
    await expect(page.locator('[data-testid="scoped-inside"]')).toHaveCSS('color', 'rgb(168, 20, 92)');
    await expect(page.locator('[data-testid="scoped-child"]')).toHaveCSS('background-color', 'rgb(246, 224, 236)');
    await expect(page.locator('[data-testid="scoped-outside"]')).toHaveCSS('color', 'rgb(0, 0, 0)');
    assert.equal(initial.cssomText.match(lazyColor)?.[0] ?? null, null);
    assert.equal(initial.lazyCount, 0);
  });

  await page.locator('[data-testid="shell-input"]').fill('kept through routes');
  await page.locator('[data-testid="shell-update"]').click();
  await expect(page.locator('[data-testid="shell-status"]')).toHaveText('updated');
  await page.evaluate(() => { window.__namedRouteDocument = document; });

  await Promise.all([
    page.waitForURL(`${baseUrl}/route-b`),
    page.locator('[data-testid="to-b"]').click(),
  ]);
  await page.locator('[data-testid="route-b"]').waitFor();
  await settleBodies();
  const routeB = await styleState();
  result.routeB = routeB;
  await check('resumed route navigation keeps shell and transfers only route-local CSS', async () => {
    assert.equal(await page.evaluate(() => window.__namedRouteDocument === document), true);
    await expect(page.locator('[data-testid="shell-input"]')).toHaveValue('kept through routes');
    await expect(page.locator('[data-testid="shell-status"]')).toHaveText('updated');
    await expect(page.locator('[data-testid="persistent-shell"]')).toHaveAttribute('data-page-token', 'named-route-page');
    await expect(page.locator('[data-testid="shared-b"]')).toHaveCSS('color', 'rgb(12, 34, 56)');
    await expect(page.locator('[data-testid="route-b-only"]')).toHaveCSS('background-color', 'rgb(255, 226, 180)');
    assert.equal(responses.filter((response) => response.shared).length, beforeBShared);
    assert.equal(routeB.routeB, true);
    assert.equal(routeB.routeA, false);
  });
} finally {
  result.responseErrors = result.errors;
  await browser.close();
}

result.checks.push({ name: 'no browser errors', pass: result.errors.length === 0, ...(result.errors.length ? { error: result.errors.join('; ') } : {}) });
const failures = result.checks.filter(({ pass }) => !pass);
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exitCode = 1;
