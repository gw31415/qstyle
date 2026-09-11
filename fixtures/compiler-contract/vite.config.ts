import { defineConfig } from 'vite';
import { qwikVite } from '@qwik.dev/core/optimizer';
import { qstyleNative } from '../../packages/vite/dist/index.mjs';
import { unocss } from '../../packages/unocss/dist/index.mjs';

export default defineConfig({
  plugins: [qstyleNative({ utilities: unocss({ configFile: process.env.QSTYLE_CONTRACT_WIND4 ? './uno.wind4.config.ts' : './uno.config.ts' }) }),
    qwikVite({
    entryStrategy: { type: 'segment' },
    client: { input: new URL('./src/root.tsx', import.meta.url).pathname },
    ssr: { input: new URL('./src/entry.ssr.tsx', import.meta.url).pathname },
  })],
  resolve: { alias: [{ find: /^@qstyle\/qwik$/, replacement: new URL('../../packages/qwik/dist/index.mjs', import.meta.url).pathname }] },
});
