import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: './src/index.ts' },
  format: ['esm'], dts: true, sourcemap: true, minify: false, exports: false, publint: true,
});
