// C0 smoke (plan.md B-1 基盤)。QWK-001 (SSR) / QWK-003 (nav) / R1.9 runtime の
// 最小カバレッジ。full matrix (QWK/RTE/DYN) はこの基盤の上に増やす。
import { expect, test } from '@playwright/test';

/** head 内の stylesheet link href 一覧 (絶対 URL 解決済み)。 */
async function styleHrefs(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate((): string[] =>
    [...document.querySelectorAll('link[rel="stylesheet"]')].map(
      (link) => (link as HTMLLinkElement).href,
    ),
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
});

test('C0.2 navigation: about keeps its styles without duplicates', async ({
  page,
}) => {
  await page.goto('/');
  const before: string[] = await styleHrefs(page);
  await page.getByTestId('nav-about').click();
  await expect(page).toHaveURL(/\/about/);
  const aboutTitle = page.getByTestId('about-title');
  await expect(aboutTitle).toBeVisible();
  const color: string = await aboutTitle.evaluate(
    (el): string => getComputedStyle(el).color,
  );
  expect(color).toBe('rgb(139, 0, 139)'); // darkmagenta
  // navigation で stylesheet が重複追加されない。
  const after: string[] = await styleHrefs(page);
  expect(new Set(after).size).toBe(after.length);
  expect(after.length).toBeGreaterThanOrEqual(before.length);
});

test('C0.3 reload: styles survive reload', async ({
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
  // reload 後も stylesheet が残り、適用されている。
  const links: number = await page.evaluate(
    (): number => document.querySelectorAll('link[rel="stylesheet"]').length,
  );
  expect(links).toBeGreaterThan(0);
});
