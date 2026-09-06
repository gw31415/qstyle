// baseline cousin 用 config。`../vite.config.ts` から qstyle plugin (+ routes)
// を抜いた対応物。`../vite.config.ts` を変えたらこちらも合わせること。
// NOTE: `baseline/` 自体は `scripts/gen-baseline.mjs` が `src/` を生成する。
// build は `baseline/scripts/build.mjs` (../scripts/build.mjs の copy)。
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { qwikVite } from '@qwik.dev/core/optimizer';
import { qwikCity } from '@qwik.dev/router/vite';
import { ssgAdapter } from '@qwik.dev/router/adapters/ssg/vite';

const here: string = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    qwikCity(),
    qwikVite(),
    ssgAdapter({
      origin: 'http://127.0.0.1:4174',
      ...(process.env.QSTYLE_SSG === '0' ? { ssg: { include: [] as string[] } } : {}),
    }),
  ],
  resolve: {
    alias: {
      '@qstyle/qwik/client': path.resolve(
        here,
        '../../../packages/qwik/dist/client.mjs',
      ),
      '@qstyle/qwik/links': path.resolve(here, '../../../packages/qwik/dist/links.qwik.mjs'),
      '@qstyle/qwik/prefetch': path.resolve(here, '../../../packages/qwik/dist/prefetch.mjs'),
      '@qstyle/qwik': path.resolve(here, '../../../packages/qwik/dist/index.mjs'),
    },
  },
});
