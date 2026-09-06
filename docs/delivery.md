# 配信 (backend・virtual modules・route 単位配信)

## backend の違い

Qwik optimizer は client build で `build.cssCodeSplit = false` を強制するため、
vite/qwik の CSS 配管に乗せた CSS はすべて単一 asset に統合され SSR HTML に
インラインされる。

- `backend: 'qwik-native'`: module 単位の pack CSS を import graph 経由で
  Vite/Qwik の配管に乗せる。lazy bundle の CSS は直前読み込みになる。
- `backend: 'css-asset'` (既定): この配管に一切乗せず、plugin 自身が chunk planner の結果
  (usage clustering＋min/max sizing) に従って content-hash 付き CSS asset を直接 emit する。
  chunk 内の宣言 dedup (§39 v1) は hash 計算前に適用済み。
  build のみに影響し、dev (serve) は `qwik-native` と同じ per-module CSS＋HMR のまま。

`backend: 'css-asset'` の生成物:

- `dist/assets/qstyle.<hash>.css` — chunk 単位の CSS asset (hash は最終 bytes 由来)
- `dist/qstyle.units.json` — unit id → asset file name の逆引き index
  (`{ "version": 1, "units": { "q_xxxxxxxx": ["assets/qstyle.<hash>.css"] } }`)
- `dist/qstyle.routes.json` — route → 必要 asset file names (`routes` option 未指定時は entries 空)

lazy 読み込み: transform が CSS を持つ各 module の先頭に
`import { ensureModuleStyles } from '@qstyle/qwik/client'; ensureModuleStyles([...unitIds])`
を注入する。JS bundle には unit id のみが埋め込まれ (chunk の file name は
transform 時点で確定しないため)、`ensureModuleStyles` が `qstyle.units.json` を
1 回だけ fetch して unit id → file name を解決し、未読の `<link rel="stylesheet">`
を head に追加する (同一 href の二重追加なし、SSR では no-op、fetch 失敗時は
console.error のみで crash しない)。

## route 単位の配信

root layout に `<QstyleLinks />` (`@qstyle/qwik/links`) を置くと、
現在 route の assets を `<link rel="stylesheet">` として描画する。

```tsx
import { QstyleLinks } from '@qstyle/qwik/links';

export default component$(() => (
  <>
    <QstyleLinks prefetch="hover" />
    <Slot />
  </>
));
```

- SSG (build 時の in-process render): plugin が `globalThis.__QSTYLE_ROUTES__` に
  manifest を設定するため、link が静的 HTML に焼かれる
- SSR runtime / client: `useQstyleRouteStyles()` (QstyleLinks が内部で呼ぶ) が
  `qstyle.routes.json` を 1 回 fetch して link を注入。client navigation
  (`useLocation().url.pathname` 変化) ごとに destination route の assets を
  追加で読み込む (二重 fetch・二重 link なし)
- prefetch: `<QstyleLinks prefetch="hover" />` で link hover 時に、`"load"` で
  idle 時に route assets を先読み (default `"none"`)

route 単位の低レベル API として `virtual:qstyle/route-loader` の
`loadRouteStyles(route)` も残っている (`qstyle.routes.json` の asset 名解決を利用)。

`options.routes` は既定 `'auto'` で `<root>/src/routes` から自動検出される
(手動の route path → module paths 指定で上書き可。`[param]` pattern は
manifest 照合で解決)。

## Virtual modules

- `virtual:qstyle/registry` — 収集済み id→CSS の対応表
- `virtual:qstyle/pack/<id>` — 個別 pack (side-effect import で同梱。qwik-native のみ)
- `virtual:qstyle/manifest` — module→atom の対応表
- `virtual:qstyle/residuals` — 最適化不能理由の一覧 (inspector 表示用)
- `virtual:qstyle/route-loader` — `loadRouteStyles(route)` (css-asset 用)
- `virtual:qstyle/dev/<hash>.css` — serve 時のみ。per-module CSS (Vite CSS HMR 対応)

## hosting 推奨

asset 名は content hash 付きなので
`Cache-Control: public, max-age=31536000, immutable`
を `assets/qstyle.*.css` に設定すること (`@qstyle/core` の
`IMMUTABLE_CACHE_HEADER` に同値を定義済み)。
