import { defineConfig } from 'tsdown';

export default defineConfig({
  // client.ts は browser 専用の ./client subpath として単独配布する (plan.md §3.4 R1.6)。
  // links.tsx (R1.4/R1.5 の <QstyleLinks /> + client navigation loader) と
  // prefetch.ts (R1.7) も subpath として配布する。@qwik.dev/* は peer 依存で external。
  entry: ['./src/index.ts', './src/client.ts', './src/links.tsx', './src/prefetch.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  exports: true,
  publint: true,
});
