import { defineConfig } from 'tsdown';

export default defineConfig({
  // qstyle 固有の client runtime は持たない (CSS 配信は vite/qwik 標準配管)。
  // 配布は index (authoring API + 型) のみ。@qwik.dev/* は peer 依存で external。
  entry: {
    index: './src/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  minify: true,
  // exports は手管理 (package.json)。
  exports: false,
  publint: true,
});
