import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { qstyle } from '../../packages/vite/src/index.ts';

// M0 最小 proof 用: dist の stale を避けるため src を相対 import する。
// React/Qwik 不要の依存ゼロ fixture (automatic JSX runtime を local stub に alias)。
const here: string = path.dirname(fileURLToPath(import.meta.url));
const jsxRuntime: string = path.resolve(here, 'src/jsx-runtime.ts');

export default defineConfig({
  plugins: [qstyle()],
  resolve: {
    alias: {
      'react/jsx-runtime': jsxRuntime,
      'react/jsx-dev-runtime': jsxRuntime,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
