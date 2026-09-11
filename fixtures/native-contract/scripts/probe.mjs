#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:4181';
const fixtureRoot = new URL('..', import.meta.url).pathname;
const buildDir = join(fixtureRoot, 'dist', 'build');
const sharedMarker = '.native-shared';
const lazyMarker = '.native-lazy';

const builtFiles = await readdir(buildDir);
const builtSource = await Promise.all(
  builtFiles
    .filter((name) => name.endsWith('.js'))
    .map(async (name) => [name, await readFile(join(buildDir, name), 'utf8')]),
);
const sourceHits = builtSource
  .filter(([, source]) => source.includes(sharedMarker) || source.includes(lazyMarker))
  .map(([name, source]) => ({
    name,
    hasSharedLiteral: source.includes(sharedMarker),
    hasLazyLiteral: source.includes(lazyMarker),
  }));

const ssrHtml = await (await fetch(`${baseUrl}/`)).text();
const ssrStyles = [...ssrHtml.matchAll(/<style q:style="([^"]+)"[^>]*>([\s\S]*?)<\/style>/g)].map(
  ([, id, text]) => ({ id, text }),
);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const requests = [];
const responses = [];
const responseBodyPromises = [];

page.on('request', (request) => {
  const url = new URL(request.url());
  if (url.pathname.startsWith('/build/')) requests.push(url.pathname);
});
page.on('response', (response) => {
  const url = new URL(response.url());
  if (!url.pathname.startsWith('/build/') || !url.pathname.endsWith('.js')) return;
  const record = { path: url.pathname, bodyBytes: 0, hasSharedLiteral: false, hasLazyLiteral: false };
  responses.push(record);
  responseBodyPromises.push(
    response
      .text()
      .then((body) => {
        record.bodyBytes = body.length;
        record.hasSharedLiteral = body.includes(sharedMarker);
        record.hasLazyLiteral = body.includes(lazyMarker);
      })
      .catch(() => {}),
  );
});

async function settleResponseBodies() {
  await Promise.allSettled(responseBodyPromises.splice(0));
}

function styleState() {
  return page.evaluate(() => {
    const styleNodes = [...document.querySelectorAll('style')].filter((node) => node.hasAttribute('q:style'));
    let cssomText = '';
    for (const sheet of [...document.styleSheets]) {
      try {
        cssomText += [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
      } catch {
        // Cross-origin sheets are irrelevant for this same-origin fixture.
      }
    }
    const shared = document.querySelector('[data-testid="shared-a"]');
    const routeShared = document.querySelector('[data-testid="shared-b-route"]');
    const identical = document.querySelector('.native-identical');
    return {
      styleIds: styleNodes.map((node) => node.getAttribute('q:style')),
      styleTexts: styleNodes.map((node) => node.textContent ?? ''),
      styleCount: styleNodes.length,
      foundationValue: getComputedStyle(document.documentElement).getPropertyValue('--native-foundation').trim(),
      foundationHeadCount: [...document.head.querySelectorAll('style')].filter((node) => node.textContent?.includes('--native-foundation')).length,
      htmlHasLazyClass: document.documentElement.innerHTML.includes('native-lazy'),
      cssomHasLazyRule: cssomText.includes('.native-lazy'),
      lazyPresent: document.querySelector('[data-testid="lazy-panel"]') !== null,
      sharedColor: shared ? getComputedStyle(shared).color : null,
      routeSharedColor: routeShared ? getComputedStyle(routeShared).color : null,
      routePadding: document.querySelector('[data-testid="route-b"]')
        ? getComputedStyle(document.querySelector('[data-testid="route-b"]')).paddingTop : null,
      identicalColor: identical ? getComputedStyle(identical).color : null,
      lazyBackground: document.querySelector('[data-testid="lazy-panel"]')
        ? getComputedStyle(document.querySelector('[data-testid="lazy-panel"]')).backgroundColor
        : null,
      lazyBorderTop: document.querySelector('[data-testid="lazy-panel"]')
        ? getComputedStyle(document.querySelector('[data-testid="lazy-panel"]')).borderTopWidth
        : null,
    };
  });
}

function responseState() {
  return {
    requestPaths: [...requests],
    sharedCssResponses: responses
      .filter((response) => response.hasSharedLiteral)
      .map(({ path, bodyBytes }) => ({ path, bodyBytes })),
    lazyCssResponses: responses
      .filter((response) => response.hasLazyLiteral)
      .map(({ path, bodyBytes }) => ({ path, bodyBytes })),
  };
}

await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
await settleResponseBodies();
const initial = await styleState();
const initialResponses = responseState();

await page.getByTestId('show-shared').click();
await page.getByTestId('shared-extra').waitFor();
await page.waitForTimeout(100);
await settleResponseBodies();
const afterSharedInstance = await styleState();
const afterSharedResponses = responseState();

await Promise.all([
  page.waitForURL(`${baseUrl}/route-b`),
  page.getByTestId('to-b').click(),
]);
await page.getByTestId('route-b').waitFor();
await page.waitForTimeout(100);
await settleResponseBodies();
const routeB = await styleState();
const routeBResponses = responseState();

await Promise.all([
  page.waitForURL(`${baseUrl}/`),
  page.getByTestId('to-a').click(),
]);
await page.getByTestId('route-a').waitFor();
await page.waitForTimeout(100);
await settleResponseBodies();
const routeAAgain = await styleState();
const routeAAgainResponses = responseState();

await page.getByTestId('show-lazy').click();
await page.getByTestId('lazy-panel').waitFor();
await page.waitForTimeout(150);
await settleResponseBodies();
const afterLazy = await styleState();
const afterLazyResponses = responseState();

await browser.close();

const result = {
  ssrFoundationHeadCount: [...ssrHtml.slice(0, ssrHtml.indexOf('</head>')).matchAll(/--native-foundation/g)].length,
  sourceHits,
  ssrStyles,
  ssrHasLazyClass: ssrHtml.includes(lazyMarker),
  initial,
  routeB,
  routeAAgain,
  afterSharedInstance,
  afterLazy,
  initialResponses,
  routeBResponses,
  routeAAgainResponses,
  afterSharedResponses,
  afterLazyResponses,
};

console.log(JSON.stringify(result, null, 2));
