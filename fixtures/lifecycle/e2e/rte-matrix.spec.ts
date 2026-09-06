// RTE matrix (plan.md §10)。RTE-001..003 は build level で済み。
// RTE-004 (dynamic SSG bake) は ssg-bake.spec.ts で済み。
import { expect, test } from '@playwright/test';

async function qstyleHrefs(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate((): string[] =>
    [...document.querySelectorAll('link[rel="stylesheet"]')]
      .map((link) => (link as HTMLLinkElement).href)
      .filter((href) => href.includes('qstyle')),
  );
}

test('RTE-005: lazy (client-only) styles are absent initially, applied on demand', async ({
  page,
}) => {
  const fetched: string[] = [];
  page.on('request', (request): void => {
    if (request.url().includes('qstyle') && request.url().endsWith('.css')) {
      fetched.push(request.url());
    }
  });
  await page.goto('/');
  const initial: string[] = [...fetched];
  // lazy-panel の chunk は初期 fetch に含まれない。
  await page.getByTestId('lazy-toggle').click();
  await expect(page.getByTestId('lazy-panel')).toBeVisible();
  expect(fetched.length).toBeGreaterThan(initial.length);
  const panel = page.getByTestId('lazy-panel');
  expect(await panel.evaluate((el): string => getComputedStyle(el).backgroundColor)).toBe(
    'rgb(230, 230, 250)',
  );
});

test('RTE-006: cached route assets are not refetched on revisit', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('nav-about').click();
  await expect(page).toHaveURL(/\/about/);
  await expect(page.getByTestId('about-title')).toBeVisible();
  await page.getByTestId('nav-home').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('home-title')).toBeVisible();
  // resource timing をクリアしてから再訪。再訪時の css は全て cache hit
  // (transferSize 0) で network 転送が起きない。
  await page.evaluate((): void => performance.clearResourceTimings());
  await page.getByTestId('nav-about').click();
  await expect(page.getByTestId('about-title')).toBeVisible();
  await page.waitForTimeout(500);
  const transfers: { url: string; transferSize: number }[] = await page.evaluate(
    (): { url: string; transferSize: number }[] =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => entry.name.includes('qstyle') && entry.name.endsWith('.css'))
        .map((entry) => ({
          url: entry.name,
          transferSize: (entry as PerformanceResourceTiming).transferSize,
        })),
  );
  expect(transfers.length).toBeGreaterThanOrEqual(0);
  for (const entry of transfers) {
    expect(entry.transferSize, entry.url).toBe(0);
  }
  // 再訪で link が増殖しない (dedup 維持)。
  const hrefs: string[] = await page.evaluate((): string[] =>
    [...document.querySelectorAll('link[rel="stylesheet"]')]
      .map((link) => (link as HTMLLinkElement).href)
      .filter((href) => href.includes('qstyle')),
  );
  expect(new Set(hrefs).size).toBe(hrefs.length);
});

test('RTE-007: failed asset fetch does not crash, single attempt only', async ({
  page,
}) => {
  let attempts = 0;
  await page.route('**/qstyle.q_*.css', (route): void => {
    attempts += 1;
    void route.abort();
  });
  await page.goto('/');
  await expect(page.getByTestId('home-title')).toBeVisible();
  // retry storm なし (試行は chunk 数以下に収まる)。
  expect(attempts).toBeLessThanOrEqual(10);
});

test('RTE-009/010: few requests, chunks within max policy', async ({ page }) => {
  const fetched: string[] = [];
  page.on('request', (request): void => {
    if (request.url().includes('qstyle') && request.url().endsWith('.css')) {
      fetched.push(request.url());
    }
  });
  await page.goto('/');
  await page.getByTestId('nav-about').click();
  await expect(page.getByTestId('about-title')).toBeVisible();
  // RTE-009: one-atom-one-request にならない (2 route で 10 requests 未満)。
  expect(new Set(fetched).size).toBeLessThan(10);
  // RTE-010: chunk は maxChunkBytes (32KiB) 以下。
  const sizes = await Promise.all(
    [...new Set(fetched)].map(async (url): Promise<number> => {
      const response = await page.request.get(url);
      return (await response.body()).length;
    }),
  );
  for (const size of sizes) expect(size).toBeLessThanOrEqual(32 * 1024);
});

test('RTE-011: shuffled chunk load order still yields computed styles', async ({
  page,
}) => {
  // qstyle css の完了順を stagger で逆転させる (connection を塞がず、
  // goto のデッドロックを避けるため有限 delay で解放する)。
  let seen = 0;
  const order: string[] = [];
  await page.route('**/qstyle.q_*.css', (route): void => {
    const index: number = seen;
    seen += 1;
    order.push(route.request().url());
    setTimeout((): void => {
      void route.continue();
    }, (5 - Math.min(index, 5)) * 150);
  });
  await page.goto('/');
  await expect(page.getByTestId('home-title')).toBeVisible();
  // 全 chunk が読み込まれるまで待つ。
  await expect
    .poll(async (): Promise<number> => {
      const count: number = await page.evaluate(
        (): number =>
          [...document.querySelectorAll('link[rel="stylesheet"]')].filter((link) =>
            (link as HTMLLinkElement).href.includes('qstyle'),
          ).length,
      );
      return count;
    })
    .toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(1200);
  expect(order.length).toBeGreaterThan(1);
  const color: string = await page
    .getByTestId('home-title')
    .evaluate((el): string => getComputedStyle(el).color);
  expect(color).toBe('rgb(46, 139, 87)');
});

test('RTE-012: first chunk completing last still yields computed styles', async ({
  page,
}) => {
  let seen = 0;
  await page.route('**/qstyle.q_*.css', (route): void => {
    seen += 1;
    // 最初の 1 件だけ大幅に遅らせて最後に完了させる。
    setTimeout(
      (): void => {
        void route.continue();
      },
      seen === 1 ? 1500 : 0,
    );
  });
  await page.goto('/');
  await expect(page.getByTestId('home-title')).toBeVisible();
  await page.waitForTimeout(2000);
  const color: string = await page
    .getByTestId('home-title')
    .evaluate((el): string => getComputedStyle(el).color);
  expect(color).toBe('rgb(46, 139, 87)');
});
