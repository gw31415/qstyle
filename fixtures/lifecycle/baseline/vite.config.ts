// baseline cousin 用 config。`../vite.config.ts` から qstyle plugin (+ routes)
// を抜いた対応物。`../vite.config.ts` を変えたらこちらも合わせること。
// NOTE: `baseline/` 自体は `scripts/gen-baseline.mjs` が `src/` を生成する。
// build は `baseline/scripts/build.mjs` (../scripts/build.mjs の copy)。
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { qwikVite } from '@qwik.dev/core/optimizer';
import { qwikCity } from '@qwik.dev/router/vite';

const here: string = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // baseline は live SSR のみ配信するため SSG adapter は入れない
  // (SSG render は differential に不要。../vite.config.ts の対応物)。
  plugins: [qwikCity(), qwikVite()],
  resolve: {
    alias: {
      '@qstyle/qwik': path.resolve(here, '../../../packages/qwik/dist/index.mjs'),
    },
  },
});
