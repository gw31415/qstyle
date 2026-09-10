# 配信 (CSS の出し方・virtual modules)

CSS 配信は vite/qwik の標準配管のみを使う。qstyle 固有の client runtime
(fetch・link 注入・prefetch・navigation 監視) は持たない。

- transform が CSS を持つ各 module の先頭に side-effect import
  `import "virtual:qstyle/pack/<HASH>.css"` を注入する
- pack は module の unit set の hash で決定論的に同一視される
- vite/qwik が bundle 単位の CSS asset を出す。lazy bundle の CSS は
  chunk と一緒に直前読み込みになる
- dev (serve) は per-module CSS + HMR のまま (変更なし)

生成物:

- `dist/assets/*.css` — vite が出す bundle CSS (content-hash 付き、immutable 推奨)
- `dist/qstyle-manifest.json` — debug/inspector 用 metadata
  (modules・packs・chunkPlans)。ランタイムは読まない

`options.routes` は既定 `'auto'` で `<root>/src/routes` から自動検出される
(手動の route path → module paths 指定で上書き可)。manifest の chunk 分類
(route-local / shared / unrouted) の metadata にのみ使う。

## Virtual modules

- `virtual:qstyle/registry` — 収集済み id→CSS の対応表
- `virtual:qstyle/pack/<id>` — 個別 pack (side-effect import で同梱)
- `virtual:qstyle/manifest` — module→atom の対応表
- `virtual:qstyle/residuals` — 最適化不能理由の一覧 (inspector 表示用)
- `virtual:qstyle/dev/<hash>.css` — serve 時のみ。per-module CSS (Vite CSS HMR 対応)
