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
qstyle 固有の `preserveClass` のみ解釈する (engine config には渡さない)。

### `preserveClass`: `boolean` (既定 `false`)

- `false` (既定・削減モード): 解決した token を転送物から消す。
  実行時に utility class 名を参照するコード
  (`querySelector('.flex')`・外部 CSS での `.flex` 指定等) との
  非互換はルールとして許容する (class 名に依存しないこと)。
- `true` (互換モード): 従来動作。解決した class を残し、
  verbatim CSS も原文 selector のまま出す。

## 責務分界 (棲み分け)

- `@qstyle/unocss`: engine (内蔵・user config 駆動)・config 読込・翻訳意味論・
  verbatim 配信用 virtual CSS の専責。`unocss` に触る唯一の package。
- `@qstyle/core`: 無関係 (atom/IR のみ)。
- `@qstyle/vite` 本体: 無改変。`css` prop として来た物だけ処理する。
- `@unocss/vite` は不要 (dev・build とも)。`uno.config.ts` はデフォルト発見で読む。

## 翻訳規則

削減モード (`preserveClass: false`。既定) の規則。互換モード (`true`) では
規則 3.・5.・6. の class 除去と alias 書換を行わず、原文のまま残す。

1. 静的 `class="..."` リテラルは要素単位で翻訳する (`class={...}` 動的式・
   `{...spread}` 混じりの attr 自体は触らない。中身は規則 6. で扱う)。
2. token を engine (`uno.generate()`) で解決する。値の焼き込みはしない
   (var 参照・media 長は engine 出力のまま)。
3. 全 token が atom 化できた要素は `css={{...}}` object へ翻訳する
   (context は `&:hover` / `@media ...` ネストにする)。変換した token は
   class から除き、未知 token は残す。
4. 既存 `css` prop がある場合は配列に追記する (`css={[既存, {...翻訳}]}`。
   明示の author コードを後勝ちにする)。
5. atom 化不能だった matched token がある要素は class 上の該当 token を
   短縮 alias (`qu_<hash8>`) に置換し、verbatim CSS
   (`virtual:qstyle-uno/c/<hash>.css`) の selector も同一 alias へ書き換える
   (宣言内容・順序・詳細度は不変のため描画は同一。原文名だけが転送物から消える)。
   未知 token (`unmatched`。user CSS 由来) は残す。
   `q_` / `qd_` (qstyle 本体) と alias 済み (`qu_<hash8>`) は対象外。
   engine 出力の `:where(` は `:is(` に置換する (matching 同一、specificity のみ
   上がる)。`:where()` (0) は preflight の `*` (0) と同点になり、dev の遅延
   注入順で勝敗が変わって divide 等がちらつくため。順序に依らず utility が勝つ。
6. 動的 `class={...}` / `className={...}` の配列は、静的文字列要素の
   union を解決し、atom 化できれば `css` へ hoist する
   (静的要素を配列から除去。全要素が静的なら attr ごと削除)。
   hoist は動的要素の utilities と property が重ならない場合のみ行い
   (重なれば順序を保証できないため alias に落とす)、
   動的側が verbatim 級を含む場合も alias に落とす。
   静的要素に matched と未知/予約の混じりがある場合も hoist しない
   (css と class の二重適用で cascade が変わるため)。
   hoist できない静的要素・三項の枝・template 静的部分・
   `{name: cond}` object 形の quoted key は 5. と同じく alias 化する。
   identifier key (`{name: cond}` / shorthand) は binding のため書換えず、
   原文 selector の CSS のみ供給する。class 供給 const の ident key も同様。
   class 式から参照される top-level の `const/let/var` 初期化子の文字列も
   alias 化する (`Record<Variant, string>` の値等。型は `string` のまま)。
   object literal 初期化子は class 式中の `Name.prop` 参照に絞って書き換える。
   関数混じり (`=>` を含む) の初期化子・top-level 以外の宣言は対象外。
   要素参照 (`m[variant]`) で読まれる const の初期化子は class 文字列のみを
   含むこと (混じりはルール違反。member 参照は prop 絞り込みで安全)。
   class 値位置にないリテラル (三項の条件式・`===` の比較対象・call 引数・
   `aria-label` 等) は書き換えない。同一 token が値位置とそれ以外に
   現れた場合は全体を原文のままにし、原文 selector の CSS を出す
   (黙って壊さない。dead CSS になり得るため class 供給 const に寄せることが推奨)。
   `qu_<8hex>` 形は削減モードの予約名前空間のため user utility との
   衝突時は互換モードを使うこと。
7. theme / properties / base / opaque (`@keyframes` 等) は同じく virtual CSS
   に出し、対象 module から import する (内容 hash のため module 間で共有される)。
8. 同一競合キー (property+context+important) は unocss 出力順の後勝ちで 1 件に
   絞る。同一 property 群・異 property 間の順序危険の判定は atom 化時と同じ
   (`orderRiskProperty` 等)。危険な場合は 5. に落とす。
9. `css()` 呼び出し形は出さない (`css={{...}}` object のみ)。`css` 識別子の
  binding 衝突は起きない。

## 検証

- 代表 token の翻訳 (`flex`、`hover:bg-red-500`、`md:grid`、`p-4 p-2` の後勝ち)。
- 未知 token の残留、削減モードの alias 置換 + virtual CSS 内容 (原文名の消失)。
- 互換モード (`preserveClass: true`) の原文維持。
- 既存 css prop との配列合成、動的 class・Record の alias 化、冪等性。
- dev/build の `getComputedStyle` 一致 (既存 differential 流用)。
