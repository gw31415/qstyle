import { defineConfig } from 'vite';
import { qwikVite } from '@qwik.dev/core/optimizer';
import { qwikCity } from '@qwik.dev/router/vite';
import { qstyleNative } from '../../packages/vite/dist/index.mjs';

export default defineConfig({
  plugins: [
    qwikCity(),
    qstyleNative(),
    qwikVite({ entryStrategy: { type: 'segment' } }),
  ],
  resolve: {
    alias: [{ find: /^@qstyle\/qwik$/, replacement: new URL('../../packages/qwik/dist/index.mjs', import.meta.url).pathname }],
  },
});
