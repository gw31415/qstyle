// Baseline differential (Gate P0.1): qstyle OFF (useStyles$ 等価物) と ON の
// getComputedStyle() が意味論的に一致すること。
// optimized (:4173, live SSR) と baseline (:4174, live SSR) の両 server が必要。
// baseline は `scripts/gen-baseline.mjs` + `baseline/scripts/build.mjs` で作る。
import { expect, test, type Browser } from '@playwright/test';

const ON = 'http://127.0.0.1:4173';
const OFF = 'http://127.0.0.1:4174';

/** route ごとに観測する [testId, props] (旧 plan §11「観測 property 宣言」)。 */
const OBSERVED: readonly (readonly [
  route: string,
  cases: readonly (readonly [testId: string, props: readonly string[]])[],
])[] = [
  [
    '/',
    [
      ['home-title', ['color', 'font-size']],
      ['shared-one', ['border-top-color', 'border-top-width', 'padding-top', 'border-radius']],
      ['nested-parent', ['margin-top']],
      ['nested-child', ['margin-top']],
      ['nav', ['display', 'padding-top']],
      ['legacy-global', ['color', 'letter-spacing']],
      ['legacy-a', ['color']],
      ['legacy-b', ['color']],
      ['dyn-box', ['background-color', 'padding-top']],
      ['g-inherit-c', ['color']],
      ['g-noninh-c', ['margin-top']],
      ['g-where', ['color']],
      ['g-current', ['color']],
      ['g-var', ['padding-top']],
      ['g-logical', ['margin-left', 'padding-bottom']],
      ['g-direction', ['direction']],
    ],
  ],
  [
    '/about/',
    [
      ['about-title', ['color', 'font-size']],
      ['nav', ['display']],
      ['legacy-b', ['color']],
    ],
  ],
  [
    '/item/42/',
    [['item-title', ['color', 'padding-top']]],
  ],
];

async function snapshot(
  browser: Browser,
  base: string,
  route: string,
  cases: readonly (readonly [string, readonly string[]])[],
): Promise<Record<string, Record<string, string>>> {
  const page = await browser.newPage();
  try {
    await page.goto(base + route);
    await expect(page.getByTestId(cases[0]?.[0] ?? 'nav')).toBeVisible();
    const out: Record<string, Record<string, string>> = {};
    for (const [testId, props] of cases) {
      out[testId] = await page
        .getByTestId(testId)
        .evaluate(
          (el, properties: readonly string[]): Record<string, string> => {
            const computed: CSSStyleDeclaration = getComputedStyle(el);
            const record: Record<string, string> = {};
            for (const property of properties) {
              record[property] = computed.getPropertyValue(property);
            }
            return record;
          },
          props,
        )
        .catch((): Record<string, string> => ({}));
    }
    return out;
  } finally {
    await page.close();
  }
}

for (const [route, cases] of OBSERVED) {
  test(`differential ${route}: OFF vs ON computed styles match`, async ({ browser }) => {
    const off = await snapshot(browser, OFF, route, cases);
    const on = await snapshot(browser, ON, route, cases);
    expect(on).toEqual(off);
  });
}

test('differential dynamic: signal-driven width matches', async ({ browser }) => {
  const widths: string[] = [];
  for (const base of [OFF, ON]) {
    const page = await browser.newPage();
    await page.goto(`${base}/`);
    await expect(page.getByTestId('dyn-value')).toHaveText('100');
    widths.push(
      await page.getByTestId('dyn-box').evaluate((el): string => getComputedStyle(el).width),
    );
    await page.getByTestId('dyn-inc').dispatchEvent('click');
    await expect(page.getByTestId('dyn-value')).toHaveText('101');
    widths.push(
      await page.getByTestId('dyn-box').evaluate((el): string => getComputedStyle(el).width),
    );
    await page.close();
  }
  expect(widths[0]).toBe('100px');
  expect(widths[2]).toBe('100px');
  expect(widths[1]).toBe('101px');
  expect(widths[3]).toBe('101px');
});
