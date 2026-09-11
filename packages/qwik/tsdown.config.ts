import { defineConfig } from 'tsdown';

export default defineConfig({
  // 配布は authoring API、client runtime、server runtime。@qwik.dev/* は peer 依存で external。
  entry: {
    index: './src/index.ts',
    runtime: './src/runtime.ts',
    server: './src/server.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  minify: true,
  // exports は手管理 (package.json)。
  exports: false,
  publint: true,
});
