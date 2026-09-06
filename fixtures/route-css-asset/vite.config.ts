import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { qstyle } from '../../packages/vite/src/index.ts';

// route 分離 chunk の実証用 fixture (plan.md §4.1 / §5.3 CHUNK-005, HASH-007/008,
// RTE-001..003 の manifest 部分)。2 route (`/` と `/about`) + それぞれ route-local
// component + 両 route で共有する component。§4.1 修正後は unit id の usage が
// module 単位で記録されるため、module ごとに別 chunk (shared.tsx 由来は共有 chunk)
// になる。
const here: string = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    qstyle({
      backend: 'css-asset',
      routes: {
        '/': ['/src/home.jsx', '/src/shared.jsx'],
        '/about': ['/src/about.jsx', '/src/shared.jsx'],
      },
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
