import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  exports: true,
  publint: true,
  // ponytail: `@unocss/vite` は値の再 export のみ (そのまま横流し) のため
  // bundle しない。JS・DTS とも外部参照のままにする。
  external: ['@unocss/vite'],
});
