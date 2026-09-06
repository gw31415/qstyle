// C0 smoke (plan.md B-1 基盤)。QWK-001 (SSR) / QWK-003 (nav) / R1.9 runtime の
// 最小カバレッジ。full matrix (QWK/RTE/DYN) はこの基盤の上に増やす。
import { expect, test } from '@playwright/test';

/** head 内の qstyle stylesheet href 一覧 (絶対 URL 解決済み)。 */
async function qstyleHrefs(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate((): string[] =>
    [...document.querySelectorAll('link[rel="stylesheet"]')]
      .map((link) => (link as HTMLLinkElement).href)
      .filter((href) => href.includes('qstyle')),
  );
}

test('C0.1 SSR: home renders with qstyle classes and computed styles', async ({ page }) => {
  await page.goto('/');
  // SSR HTML に qstyle class が焼かれている。
  const homeTitle = page.getByTestId('home-title');
  await expect(homeTitle).toBeVisible();
  await expect(homeTitle).toHaveClass(/q_[0-9a-f]{8}/);
  // 最適化後も computed style が一致 (color: seagreen)。
  await expect
    .poll(async () => page.evaluate(() => getComputedStyle(document.body).color))
    .not.toBe('');
  const color: string = await homeTitle.evaluate(
    (el): string => getComputedStyle(el).color,
  );
  expect(color).toBe('rgb(46, 139, 87)'); // seagreen
  // bootstrap marker が焼かれている (R1.7 prefetch=hover)。
  const marker: string | null = await page.evaluate(
    (): string | null =>
      document.querySelector('meta[name="qstyle:prefetch"]')?.getAttribute('content') ?? null,
  );
  expect(marker).toBe('hover');
});

test('C0.2 navigation: about loads its route-local css without duplicates', async ({
  page,
}) => {
  await page.goto('/');
  const before: string[] = await qstyleHrefs(page);
  // bootstrap (document-idle の visible task) の実行を待ってから遷移する。
  // 待たずに遷移すると pushState 監視が未設置で destination の css が遅延する。
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
  await page.getByTestId('nav-about').click();
  await expect(page).toHaveURL(/\/about/);
  const aboutTitle = page.getByTestId('about-title');
  await expect(aboutTitle).toBeVisible();
  const color: string = await aboutTitle.evaluate(
    (el): string => getComputedStyle(el).color,
  );
  expect(color).toBe('rgb(139, 0, 139)'); // darkmagenta
  // navigation で stylesheet が追加され、二重適用がない。
  const after: string[] = await qstyleHrefs(page);
  expect(after.length).toBeGreaterThan(before.length);
  expect(new Set(after).size).toBe(after.length);
});

test('C0.3 reload: styles survive reload via cached css assets (R1.9)', async ({
  page,
}) => {
  await page.goto('/about/');
  await expect(page.getByTestId('about-title')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('about-title')).toBeVisible();
  const color: string = await page
    .getByTestId('about-title')
    .evaluate((el): string => getComputedStyle(el).color);
  expect(color).toBe('rgb(139, 0, 139)');
  // immutable cache-hit: reload 後の css asset は network 転送なし (transferSize 0)。
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
  expect(transfers.length).toBeGreaterThan(0);
  for (const entry of transfers) {
    expect(entry.transferSize, entry.url).toBe(0);
  }
});
