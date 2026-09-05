import { defineConfig } from 'tsdown';

export default defineConfig({
  // client.ts は browser 専用の ./client subpath として単独配布する (plan.md §3.4 R1.6)。
  entry: ['./src/index.ts', './src/client.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  exports: true,
  publint: true,
});
