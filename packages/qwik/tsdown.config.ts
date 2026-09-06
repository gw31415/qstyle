import { defineConfig } from 'tsdown';

export default defineConfig({
  // client.ts は browser 専用の ./client subpath として単独配布する (plan.md §3.4 R1.6)。
  // links.tsx (R1.4/R1.5 の <QstyleLinks /> + client navigation loader) と
  // prefetch.ts (R1.7) も subpath として配布する。@qwik.dev/* は peer 依存で external。
  // links.tsx は QRL を含むため `.qwik.mjs` で出す。consumer の app build 時に
  // qwik optimizer が `*.qwik.mjs` を transform 対象にし、component / task の
  // symbol を q-manifest に登録する (素の `.mjs` だと SSR/SSG serialize 時に
  // Q14 qrlMissingChunk で落ちる。C0 基盤整備で実証済み)。
  entry: {
    index: './src/index.ts',
    client: './src/client.ts',
    'links.qwik': './src/links.tsx',
    prefetch: './src/prefetch.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  // exports は手管理 (package.json)。`exports: true` にすると entry 名
  // (`links.qwik`) がそのまま subpath になり `./links` が壊れるため使わない。
  exports: false,
  publint: true,
});
