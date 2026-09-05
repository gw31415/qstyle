import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { qstyle } from '../../packages/vite/src/index.ts';

// M0 css-asset proof 用 (plan.md §3.4 R1.1-R1.3/R1.6)。Backend B は vite/qwik の
// CSS 配管に乗せないため、pack css import の代わりに @qstyle/qwik/client の
// ensureModuleStyles(unit ids) が module 先頭に注入される。
// 依存ゼロ fixture (automatic JSX runtime と client helper を local/source alias にする)。
const here: string = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    qstyle({
      backend: 'css-asset',
      routes: { '/': ['/src/app.jsx'] },
    }),
  ],
  resolve: {
    alias: {
      'react/jsx-runtime': path.resolve(here, 'src/jsx-runtime.ts'),
      'react/jsx-dev-runtime': path.resolve(here, 'src/jsx-runtime.ts'),
      // workspace root に @qstyle が link されていないため source 直参照する。
      '@qstyle/qwik/client': path.resolve(here, '../../packages/qwik/src/client.ts'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
