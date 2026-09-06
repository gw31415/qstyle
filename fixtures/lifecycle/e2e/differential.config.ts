// Baseline differential 専用 config (Gate P0.1)。optimized (:4173) と
// baseline (:4174) の両 SSR server を起動して differential.spec.ts を回す。
// 前提:
//   optimized: `node scripts/build.mjs` (dist/ + server/)
//   baseline: `node scripts/gen-baseline.mjs` + `baseline/scripts/build.mjs`
//   (baseline/dist/ + baseline/server/)
import { defineConfig } from '@playwright/test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here: string = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot: string = path.resolve(here, '..');

export default defineConfig({
  testDir: here,
  testMatch: ['differential.spec.ts'],
  fullyParallel: false,
  retries: 0,
  webServer: [
    {
      command: 'node scripts/serve-live.mjs',
      cwd: fixtureRoot,
      port: 4173,
      reuseExistingServer: true,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node server/entry.node-server.js',
      cwd: path.join(fixtureRoot, 'baseline'),
      port: 4174,
      reuseExistingServer: true,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PORT: '4174' },
    },
  ],
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
});
