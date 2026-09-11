import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: true,
  minify: true,
  sourcemap: true,
  exports: false,
  publint: true,
  // ponytail: `@unocss/vite` は値の再 export のみ (そのまま横流し) のため
  // bundle しない。JS・DTS とも外部参照のままにする。
  external: ['@unocss/vite'],
});
