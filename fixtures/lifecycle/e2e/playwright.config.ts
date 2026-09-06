// C0 Playwright 基盤 (plan.md B-1)。chromium のみ。対象は本番 SSR server。
//
// 前提: `QSTYLE_SSG=0 node scripts/build.mjs` で dist/ + server/ を build 済み。
// 実行 (workspace root から):
//   pnpm exec playwright test -c fixtures/lifecycle/e2e/playwright.config.ts
import { defineConfig } from '@playwright/test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here: string = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot: string = path.resolve(here, '..');

export default defineConfig({
  testDir: here,
  testMatch: [
    'c0-smoke.spec.ts',
    'qwk-matrix.spec.ts',
    'dyn-matrix.spec.ts',
    'rte-matrix.spec.ts',
    'fouc.spec.ts',
  ],
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: {
    // serve-live: SSG HTML を消してから起動し、live SSR を保証する。
    command: 'node scripts/serve-live.mjs',
    cwd: fixtureRoot,
    port: 4173,
    reuseExistingServer: true,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
});
