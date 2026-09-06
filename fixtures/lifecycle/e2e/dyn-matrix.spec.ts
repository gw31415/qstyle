// DYN matrix (plan.md §8.5 の browser 側: DYN-012/013/014/015/021)。
// unit 側 (DYN-001..011/016..024) は vitest でカバー済み。
import { expect, test } from '@playwright/test';

/** head 内の stylesheet link 数 (qstyle 以外も含む) と qstyle の CSS rule 総数。 */
async function styleStats(page: import('@playwright/test').Page): Promise<{
  links: number;
  rules: number;
}> {
  return page.evaluate((): { links: number; rules: number } => {
    const links: number = document.querySelectorAll('link[rel="stylesheet"]').length;
    let rules = 0;
    for (const sheet of [...document.styleSheets]) {
      try {
        rules += sheet.cssRules.length;
      } catch {
        // cross-origin は数えられない (同一 origin のみ対象)。
      }
    }
    return { links, rules };
  });
}

test('DYN-012: single signal update adds no stylesheet or rule', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('dyn-value')).toHaveText('100');
  const before = await styleStats(page);
  await page.getByTestId('dyn-inc').dispatchEvent('click');
  await expect(page.getByTestId('dyn-value')).toHaveText('101');
  // width は custom property の値更新のみ (stylesheet 追加なし)。
  const width: string = await page
    .getByTestId('dyn-box')
    .evaluate((el): string => getComputedStyle(el).width);
  expect(parseFloat(width)).toBeGreaterThan(100);
  expect(await styleStats(page)).toEqual(before);
});

test('DYN-013: 100 signal updates add no stylesheet or rule', async ({ page }) => {
  await page.goto('/');
  const before = await styleStats(page);
  for (let i = 0; i < 100; i += 1) {
    await page.getByTestId('dyn-inc').dispatchEvent('click');
  }
  await expect(page.getByTestId('dyn-value')).toHaveText('200');
  expect(await styleStats(page)).toEqual(before);
});

test('DYN-014/015: SSR initial value present, resume keeps equivalence', async ({
  page,
}) => {
  // DYN-014: SSR HTML に初期値あり。
  const response = await page.request.get('/');
  const html: string = await response.text();
  expect(html).toContain('>100<');
  // DYN-015: resume 後も同値 (mismatch なし)。
  await page.goto('/');
  await expect(page.getByTestId('dyn-value')).toHaveText('100');
  const widthBefore: string = await page
    .getByTestId('dyn-box')
    .evaluate((el): string => getComputedStyle(el).width);
  await page.getByTestId('dyn-inc').dispatchEvent('click');
  await expect(page.getByTestId('dyn-value')).toHaveText('101');
  const widthAfter: string = await page
    .getByTestId('dyn-box')
    .evaluate((el): string => getComputedStyle(el).width);
  expect(widthAfter).not.toBe(widthBefore);
});

test('DYN-021: high-frequency pointer updates add no stylesheet', async ({ page }) => {
  await page.goto('/');
  const before = await styleStats(page);
  const box = page.getByTestId('dyn-box');
  const bounds = await box.boundingBox();
  expect(bounds).not.toBeNull();
  // 高頻度 pointermove (30 回)。
  for (let i = 0; i < 30; i += 1) {
    await page.mouse.move(bounds!.x + 10 + i * 5, bounds!.y + 10);
  }
  await page.waitForTimeout(300);
  // DOM 値は更新されるが stylesheet は増えない。
  const value: string = (await page.getByTestId('dyn-value').textContent()) ?? '';
  expect(value).not.toBe('');
  expect(await styleStats(page)).toEqual(before);
});
