// QWK lifecycle matrix (plan.md §9)。C0 (001/003) の続き。
// 前提: 本番 SSR server 起動済み (playwright.config.ts の webServer)。
import { expect, test } from '@playwright/test';

async function computedColor(
  page: import('@playwright/test').Page,
  testId: string,
): Promise<string> {
  return page.getByTestId(testId).evaluate((el): string => getComputedStyle(el).color);
}

test('QWK-004: back/forward navigation keeps styles without duplication', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('nav-about').click();
  await expect(page).toHaveURL(/\/about/);
  await expect(page.getByTestId('about-title')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/$|\/about\/$/);
  await expect(page.getByTestId('home-title')).toBeVisible();
  expect(await computedColor(page, 'home-title')).toBe('rgb(46, 139, 87)');
  await page.goForward();
  await expect(page.getByTestId('about-title')).toBeVisible();
  expect(await computedColor(page, 'about-title')).toBe('rgb(139, 0, 139)');
  const hrefs: string[] = await page.evaluate((): string[] =>
    [...document.querySelectorAll('link[rel="stylesheet"]')]
      .map((link) => (link as HTMLLinkElement).href)
      .filter((href) => href.includes('qstyle')),
  );
  expect(new Set(hrefs).size).toBe(hrefs.length);
});

test('QWK-005/006/007: lazy component absent, appears styled, disappears cleanly', async ({
  page,
}) => {
  const lazyCssRequests: string[] = [];
  page.on('request', (request): void => {
    if (request.url().includes('qstyle') && request.url().endsWith('.css')) {
      lazyCssRequests.push(request.url());
    }
  });
  await page.goto('/');
  // QWK-005: 初期表示に lazy の DOM/CSS が無い。
  await expect(page.getByTestId('lazy-panel')).toHaveCount(0);
  const initialCount: number = lazyCssRequests.length;
  // QWK-006: 出現と同時に styled (lavender)。
  await page.getByTestId('lazy-toggle').click();
  const panel = page.getByTestId('lazy-panel');
  await expect(panel).toBeVisible();
  const background: string = await panel.evaluate(
    (el): string => getComputedStyle(el).backgroundColor,
  );
  expect(background).toBe('rgb(230, 230, 250)'); // lavender
  expect(lazyCssRequests.length).toBeGreaterThan(initialCount);
  // QWK-007: 消去→再出現でも壊れない。
  await page.getByTestId('lazy-toggle').click();
  await expect(panel).toHaveCount(0);
  await page.getByTestId('lazy-toggle').click();
  await expect(page.getByTestId('lazy-panel')).toBeVisible();
});

test('QWK-008/009: repeated and nested components share atoms without duplication', async ({
  page,
}) => {
  await page.goto('/');
  // QWK-008: 同一 component 3 回 → 同一 class。
  const classes = await page.evaluate((): string[] =>
    ['shared-one', 'shared-two', 'shared-three'].map(
      (id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('class') ?? '',
    ),
  );
  expect(classes[0]).toMatch(/q_[0-9a-f]{8}/);
  expect(classes[1]).toBe(classes[0]);
  expect(classes[2]).toBe(classes[0]);
  // QWK-009: 親子で同一宣言 → 同一 class。
  const parent: string | null = await page
    .getByTestId('nested-parent')
    .getAttribute('class');
  const child: string | null = await page.getByTestId('nested-child').getAttribute('class');
  expect(parent).toMatch(/q_[0-9a-f]{8}/);
  expect(child).toBe(parent);
});

test('QWK-010/011/012: legacy hooks coexist, scoped clash does not leak', async ({
  page,
}) => {
  await page.goto('/');
  // QWK-010: useStyles$ global (darkolivegreen + letter-spacing)。
  expect(await computedColor(page, 'legacy-global')).toBe('rgb(85, 107, 47)');
  const spacing: string = await page
    .getByTestId('legacy-global')
    .evaluate((el): string => getComputedStyle(el).letterSpacing);
  expect(spacing).toBe('1px');
  // QWK-011/012: 同一 `.clash` でも scoped ごとに独立 (firebrick vs midnightblue)。
  expect(await computedColor(page, 'legacy-a')).toBe('rgb(178, 34, 34)');
  expect(await computedColor(page, 'legacy-b')).toBe('rgb(25, 25, 112)');
});

test('QWK-013/014: resume works, signal updates after resume', async ({ page }) => {
  await page.goto('/');
  // QWK-013: resume 後に click が効く (runtime stylesheet engine 不要)。
  await page.getByTestId('lazy-toggle').click();
  await expect(page.getByTestId('lazy-panel')).toBeVisible();
  // QWK-014: resume 後の signal 更新は表示に反映される。
  await expect(page.getByTestId('dyn-value')).toHaveText('100');
  await page.getByTestId('dyn-inc').dispatchEvent('click');
  await expect(page.getByTestId('dyn-value')).toHaveText('101');
});

test('QWK-015: nested lazy boundary loads styled', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('lazy-toggle').click();
  await expect(page.getByTestId('lazy-panel')).toBeVisible();
  await page.getByTestId('lazy-nested-toggle').click();
  const inner = page.getByTestId('lazy-inner');
  await expect(inner).toBeVisible();
  const outline: string = await inner.evaluate(
    (el): string => getComputedStyle(el).outlineColor,
  );
  expect(outline).toBe('rgb(255, 99, 71)'); // tomato
});

test('QWK-016: missing route does not corrupt style state', async ({ page }) => {
  await page.goto('/');
  await page.goto('/does-not-exist/');
  await expect(page.getByTestId('home-title')).toHaveCount(0);
  await page.goto('/');
  await expect(page.getByTestId('home-title')).toBeVisible();
  expect(await computedColor(page, 'home-title')).toBe('rgb(46, 139, 87)');
});

test('QWK-017: qstyle links precede body content in SSR HTML', async ({ request }) => {
  // streaming SSR 順序: stylesheet link が head 内 (body より前) にある。
  const response = await request.get('/');
  expect(response.ok()).toBe(true);
  const html: string = await response.text();
  const firstLink: number = html.indexOf('data-qstyle-href');
  const bodyOpen: number = html.indexOf('<body');
  expect(firstLink).toBeGreaterThan(-1);
  expect(bodyOpen).toBeGreaterThan(-1);
  expect(firstLink).toBeLessThan(bodyOpen);
});

test('QWK-018: production build markers (no dev-only assumptions)', async ({
  page,
}) => {
  await page.goto('/');
  const devMarkers: number = await page.evaluate(
    (): number =>
      document.querySelectorAll('script[src*="localhost:5173"], script[src*="@vite"], script[src*="@react-refresh"]').length,
  );
  expect(devMarkers).toBe(0);
  await expect(page.getByTestId('home-title')).toBeVisible();
});
