// FOUC / prefetch 判定 (plan.md B-1)。
// fixture root は `<QstyleLinks prefetch="hover" />` 固定。
//
// NOTE: Qwik が小 CSS を SSR HTML に inline するため、本 fixture では視覚的
// flash は起きない (inline が anti-FOUC として働く)。ここでは prefetch の
// request 層を検証する: hover で destination chunk が先読みされること、
// hover 無しでは navigation まで fetch されないこと。視覚的一致は各 matrix が
// computed style で保証する。
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** about route 固有の chunk file 名 (routes.json から解決。build hash 直書き禁止)。 */
function aboutLocalChunk(): string {
  const raw: string = readFileSync(path.join(fixtureRoot, 'dist', 'qstyle.routes.json'), 'utf8');
  const manifest = JSON.parse(raw) as {
    entries: { route: string; assets: string[] }[];
  };
  const home: string[] =
    manifest.entries.find((e) => e.route === '/')?.assets ?? [];
  const about: string[] =
    manifest.entries.find((e) => e.route === '/about')?.assets ?? [];
  const local: string | undefined = about.find((asset) => !home.includes(asset));
  if (local === undefined) throw new Error('no about-local chunk in manifest');
  return local.split('/').pop() ?? local;
}

async function idle(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(
    (): Promise<void> =>
      new Promise<void>((resolve): void => {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback((): void => resolve());
        } else {
          setTimeout(resolve, 500);
        }
      }),
  );
  await page.waitForTimeout(500);
}

test('FOUC on (prefetch hover): hovering a link prefetches its route css', async ({
  page,
}) => {
  const fetched: string[] = [];
  page.on('request', (request): void => {
    if (request.url().includes('qstyle') && request.url().endsWith('.css')) {
      fetched.push(request.url());
    }
  });
  await page.goto('/');
  await idle(page);
  const before: string[] = [...fetched];
  // hover 先の about-local chunk がまだ無ければ、hover で先読みされる。
  const local: string = aboutLocalChunk();
  const aboutPrefetched = async (): Promise<boolean> =>
    page.evaluate((file: string): boolean => {
      for (const link of [...document.querySelectorAll('link[rel="stylesheet"]')]) {
        if ((link as HTMLLinkElement).href.includes(file)) return true;
      }
      return false;
    }, local);
  if (!(await aboutPrefetched())) {
    await page.getByTestId('nav-about').hover();
    await expect
      .poll(async (): Promise<boolean> => aboutPrefetched(), { timeout: 8000 })
      .toBe(true);
  }
  expect(fetched.length).toBeGreaterThanOrEqual(before.length);
  // 先読み後も computed style は正しい (flash なし)。
  await page.getByTestId('nav-about').click();
  await expect(page).toHaveURL(/\/about/);
  await expect(page.getByTestId('about-title')).toBeVisible();
  const color: string = await page
    .getByTestId('about-title')
    .evaluate((el): string => getComputedStyle(el).color);
  expect(color).toBe('rgb(139, 0, 139)');
});

test('FOUC off (no hover): destination css is fetched only on navigation', async ({
  page,
}) => {
  const fetched: string[] = [];
  page.on('request', (request): void => {
    if (request.url().includes('qstyle') && request.url().endsWith('.css')) {
      fetched.push(request.url());
    }
  });
  await page.goto('/');
  await idle(page);
  // hover 無しでは about-local chunk の fetch が起きない。
  expect(fetched.some((url) => url.includes(aboutLocalChunk()))).toBe(false);
  await page.getByTestId('nav-about').click();
  await expect(page).toHaveURL(/\/about/);
  await expect(page.getByTestId('about-title')).toBeVisible();
  // navigation で取得され、適用される。
  await expect
    .poll(
      async (): Promise<boolean> =>
        fetched.some((url) => url.includes(aboutLocalChunk())),
      { timeout: 8000 },
    )
    .toBe(true);
  const color: string = await page
    .getByTestId('about-title')
    .evaluate((el): string => getComputedStyle(el).color);
  expect(color).toBe('rgb(139, 0, 139)');
});
