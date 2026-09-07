# `@qstyle/unocss` 仕様 — class→css prop 翻訳 plugin

`class="..."` に書かれた Tailwind 方式のユーティリティを `css` prop へ翻訳する
Vite plugin (`UnoCSS()`) を出す。`qstyle()` より前に置くと、翻訳後の `css`
prop が qstyle 本体の配管 (dev/HMR・dedup・chunk・asset) に載る。
qstyle 本体はこの plugin の存在を知らない。
`@unocss/vite` からの移行は import 元の変更のみ
(`import UnoCSS from '@unocss/vite'` → `import UnoCSS from '@qstyle/unocss'`)。

## 引数

`UnoCSS(options?)`。`options` は `@unocss/vite` と同じ物を受け付ける
(`QstyleUnoOptions | string`。`QstyleUnoOptions` は `VitePluginConfig` と構造互換)。
inline config は `uno.config.ts` に merge され、文字列は config path として扱う。
いずれも `@unocss/vite` の loader と同一意味論。
vite 固有の出力制御 (`mode` 等) は qstyle 配管が担うため無視する。

## 責務分界 (棲み分け)

- `@qstyle/unocss`: engine (内蔵・user config 駆動)・config 読込・翻訳意味論・
  verbatim 配信用 virtual CSS の専責。`unocss` に触る唯一の package。
- `@qstyle/core`: 無関係 (atom/IR のみ)。
- `@qstyle/vite` 本体: 無改変。`css` prop として来た物だけ処理する。
- `@unocss/vite` は不要 (dev・build とも)。`uno.config.ts` はデフォルト発見で読む。

## 翻訳規則

1. 静的 `class="..."` リテラルのみ対象にする (`class={...}` 動的式・
   `{...spread}` 混じりは触らない)。
2. token を engine (`uno.generate()`) で解決する。値の焼き込みはしない
   (var 参照・media 長は engine 出力のまま)。
3. 全 token が atom 化できた要素は `css={{...}}` object へ翻訳する
   (context は `&:hover` / `@media ...` ネストにする)。変換した token は
   class から除き、未知 token は残す。
4. 既存 `css` prop がある場合は配列に追記する (`css={[既存, {...翻訳}]}`。
   明示の author コードを後勝ちにする)。
5. atom 化不能だった matched token がある要素は翻訳せず、原文 rules を
   virtual CSS (`virtual:qstyle-uno/c/<hash>.css`) として出し、class は触らない。
   engine 出力の `:where(` は `:is(` に置換する (matching 同一、specificity のみ
   上がる)。`:where()` (0) は preflight の `*` (0) と同点になり、dev の遅延
   注入順で勝敗が変わって divide 等がちらつくため。順序に依らず utility が勝つ。
6. theme / properties / base / opaque (`@keyframes` 等) は同じく virtual CSS
   に出し、対象 module から import する (内容 hash のため module 間で共有される)。
7. 同一競合キー (property+context+important) は unocss 出力順の後勝ちで 1 件に
   絞る。同一 property 群・異 property 間の順序危険の判定は atom 化時と同じ
   (`orderRiskProperty` 等)。危険な場合は 5. に落とす。
8. `css()` 呼び出し形は出さない (`css={{...}}` object のみ)。`css` 識別子の
  binding 衝突は起きない。

## 検証

- 代表 token の翻訳 (`flex`、`hover:bg-red-500`、`md:grid`、`p-4 p-2` の後勝ち)。
- 未知 token の残留、verbatim 要素の class 不変 + virtual CSS 内容。
- 既存 css prop との配列合成、動的 class の skip、冪等性。
- dev/build の `getComputedStyle` 一致 (既存 differential 流用)。
