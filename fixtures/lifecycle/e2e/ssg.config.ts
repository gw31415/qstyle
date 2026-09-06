// SSG bake 専用 config (QWK-002/RTE-004)。browser・server 不要の file assertion。
// 前提: `node scripts/build.mjs` (SSG あり) で dist/*.html が存在すること。
// live SSR 用の main config (playwright.config.ts) とは別に実行する
// (main config の serve-live が SSG HTML を消すため)。
import { defineConfig } from '@playwright/test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here: string = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: here,
  testMatch: ['ssg-bake.spec.ts'],
  fullyParallel: false,
  retries: 0,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
