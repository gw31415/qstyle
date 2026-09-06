// QWK-002 / RTE-004: SSG HTML に route の stylesheet link が焼かれている。
//
// browser 不要の file assertion (dist/*.html を直接読む)。前提: `node
// scripts/build.mjs` (SSG あり) で dist/ を build 済み。C0 の SSR server とは
// 独立に実行できる。
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface RouteManifest {
  readonly entries: readonly { readonly route: string; readonly assets: readonly string[] }[];
}

function readManifest(): RouteManifest {
  const raw: string = readFileSync(path.join(fixtureRoot, 'dist', 'qstyle.routes.json'), 'utf8');
  return JSON.parse(raw) as RouteManifest;
}

function bakedStylesheets(htmlFile: string): string[] {
  const html: string = readFileSync(path.join(fixtureRoot, 'dist', htmlFile), 'utf8');
  const hrefs: string[] = [];
  for (const match of html.matchAll(/<link[^>]*rel="stylesheet"[^>]*>/g)) {
    const href: RegExpMatchArray | null = /href="([^"]*)"/.exec(match[0]);
    if (href !== null) hrefs.push(href[1] ?? '');
  }
  return hrefs.sort();
}

function expectedFor(manifest: RouteManifest, route: string): string[] {
  const entry = manifest.entries.find((e) => e.route === route);
  if (entry === undefined) throw new Error(`route ${route} not in manifest`);
  return entry.assets.map((asset) => `/${asset}`).sort();
}

test('QWK-002: SSG HTML bakes route stylesheet links (/, /about)', () => {
  const manifest: RouteManifest = readManifest();
  expect(bakedStylesheets('index.html')).toEqual(expectedFor(manifest, '/'));
  expect(bakedStylesheets('about/index.html')).toEqual(expectedFor(manifest, '/about'));
  // 二重焼きなし。
  const hrefs: string[] = bakedStylesheets('index.html');
  expect(new Set(hrefs).size).toBe(hrefs.length);
});

test('RTE-004: dynamic route SSG bakes pattern-matched links (/item/42, /item/99)', () => {
  const manifest: RouteManifest = readManifest();
  const expected: string[] = expectedFor(manifest, '/item/[id]');
  expect(expected.length).toBeGreaterThan(0);
  expect(bakedStylesheets('item/42/index.html')).toEqual(expected);
  expect(bakedStylesheets('item/99/index.html')).toEqual(expected);
});
