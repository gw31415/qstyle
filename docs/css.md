# 書ける CSS の範囲とサポート境界

qstyle は `css` prop / `css()` / tagged template の 3 記法を受け付ける。
いずれも build 時に Style IR (StaticAtom / ParametricAtom / KeyframesRule /
GlobalAtRule) へ lowering され、安全に atomicize できないものは書き換えず
そのまま残す (untouched + diagnostic)。**黙って意味を変えることはない**のが原則。

型 (`@qstyle/qwik`)。宣言部分は Qwik の `style` (`CSSProperties`) と同じ出自
(csstype) を流用し、qstyle 固有のネスト・at-rule を足した closed typing。
未知 property・未対応 at-rule は型 error になり、LSP 補完が効く:

```ts
export type CssDeclarationValue = string | number | boolean | null | undefined;

export type StyleDeclarations = /* csstype */ Properties & PropertiesHyphen & {
  readonly [V in `--${string}`]?: CssDeclarationValue;
};

export interface KeyframesBody {
  readonly [frame: string]: StyleDeclarations; // from / to / 0% ...
}
export type FontFaceBody = /* csstype */ AtRule.FontFace & AtRule.FontFaceHyphen;
export type PropertyBody = /* csstype */ AtRule.Property & AtRule.PropertyHyphen;

export type NestedStyleValue = StyleObject | boolean | null | undefined;

export type StyleObject = StyleDeclarations & {
  readonly [K in `&${string}`]?: NestedStyleValue; // &:hover / & .tile / &--mod 等
  readonly [K in `@media${string}` | `@supports${string}` | `@container${string}` | `@layer${string}`]?: NestedStyleValue;
  readonly [K in `@keyframes${string}`]?: KeyframesBody;
  readonly '@font-face'?: FontFaceBody;
  readonly [K in `@property${string}`]?: PropertyBody;
};

export type CssProp =
  | StyleObject
  | StyleHandle
  | false
  | null
  | undefined
  | readonly CssProp[];
```

注意:

- Qwik の `ClassList` とも `style` (`CSSProperties`) とも別型
  (ネスト・条件・keyframes を扱うため)。`style` 属性の宣言集合だけ流用している。
- 値の falsy (`null` / `undefined` / 真偽値) は実行時に無視する
  (`cond && 'red'`・`c ? {...} : undefined` 形の条件値を型でも許す)。
- 未知 property は型 error だが、実行時は落とさず atom 化する
  (browser の前方互換 error recovery に委ねる。typo 指摘は型に任せる)。
- tagged template literal は対象外 (別途 LSP を用意する必要があるため)。

## 値の規則

- property 名は camelCase → kebab-case に正規化する (`backgroundColor` → `background-color`)。
  `ms` 始まりのみ小文字 vendor prefix として扱う (`msFlexAlign` → `-ms-flex-align`)。
- 数値: unitless property (一覧は `@qstyle/core` の `UNITLESS_PROPERTIES`。
  `opacity`・`z-index`・`font-weight`・`line-height`・`flex` 系・`order` 等) はそのまま、
  それ以外の length 系は `px` を補完する (`gap: 8` → `gap:8px`)。`0` は単位なし (`margin: 0` → `margin:0`)。
  custom property (`--x`) の数値は単位推測せずそのまま通す。
- 文字列値は前後 trim＋内部連続空白の単一化のみで素通しする
  (`var(--x)`・`calc()`・`min()`・カンマ区切り・quote・data URL 等の意味を変えない)。
- 末尾の `!important` は値ではなく important flag に分離する
  (`color: 'red !important'` → `color:red!important` として cascade 上正しく扱う)。
- custom property 名は case-sensitive (`--MyVar` はそのまま)。
- `null` / `undefined` / 真偽値は無視する。`__proto__` / `constructor` / `prototype` キーは無視＋警告する。
- 次は受け付けず residual (`unsupported-syntax`) + 警告になる:
  - property 名として不正なもの (大文字・空白混じり。`--*` 以外)
  - `behavior` / `-moz-binding` property、`expression(` / `url(javascript:` を含む値
  - quote・`url()` の外側で `<` `>` `;` `{` `}` を含む値

## ネスト

ネストキーは上から順に解決される。深いネストは context を合成する
(`@media` 内の `&:hover` 内の `& .tile` 等)。

| キー | 意味 | 出力例 (class `.q_abc`) |
| --- | --- | --- |
| `&:hover`、`&:focus-visible`、`&::before` | pseudo (引数は空白なし単純形のみ。`&:not(.foo)` 可) | `.q_abc:hover{...}` |
| `&:is(.a, .b)`、`&:has(> img)` | suffix として素通し | `.q_abc:is(.a, .b){...}` |
| `&--mod`、`&.active`、`&[type="text"]` | `&` 直結 (直後の空白有無で連結/子孫を決める) | `.q_abc--mod{...}` |
| `& svg`、`& .tile` | 子孫 (単純1段のみ) | `.q_abc svg{...}` |
| `& a b`、`& > svg`、`& + sib`、`& ~ sib` | suffix として素通し | `.q_abc > svg{...}` |
| `&:hover, &:focus` | リスト (各要素に class を付与。`, &` 以降の `&` は1個剥がす) | `.q_abc:hover,.q_abc:focus{...}` |
| `@media (...)`、`@supports (...)`、`@container ...` | 条件 text をそのまま wrap | `@media (...){.q_abc{...}}` |
| `@layer base` (dotted・無名可) | layer wrapper。nested は `.` 結合 (`a` + `b` → `a.b`) | `@layer base{.q_abc{...}}` |

注意:

- suffix に `{` `}` `;` `<` `!` を含むもの、`&` が残るもの (`&:hover &`・`&& svg`)、
  空要素を含むリストは受理せず residual (`unsupported-selector`) + 警告になる。
- `@media` 等の条件 text は検証せず素通しする。
- `@layer` の prelude が layer 名 (`ident(.ident)*`・空) でないものは residual になる。
- `@scope` / `@starting-style` 等の上表に無い at-rule は residual (`unsupported-at-rule`) になる。
- 対応する値が plain object でないネスト (`'&:hover': 'red'` 等) も residual になる。

## `@keyframes` / `@font-face` / `@property`

top-level のキーとして書く (nested は residual)。object・template 両記法で書ける。

```tsx
css({
  '@keyframes fade': { from: { opacity: 0 }, to: { opacity: 1 } },
  animation: 'fade 1s ease',
});
```

```tsx
css`
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  animation: spin 1s linear infinite;
`;
```

```tsx
css({
  '@font-face': { fontFamily: 'MyFont', src: 'url(/a.woff2)' },
  '@property --brand': { syntax: '"<color>"', inherits: 'false', initialValue: 'red' },
});
```

規則:

- keyframes 名は ident のみ (`[A-Za-z_][\w-]*`。`@KEYFRAMES` 等の大文字 prefix 可、quote 名不可)。
- フレームは `from` / `to` / `0%` とそのカンマ並びのみ (小文字正規化)。
  フレームは数値順にソートして emit する (`from`=0、`to`=100)。
- フレーム内・`@font-face` / `@property` 内の宣言は static な string/number のみ。
  interpolation・handle・ネスト混じりは block 全体が residual になる。空 block も residual。
- `@property` の prelude は `--*` のみ。`@font-face` の prelude は空のみ。
- 出力名は内容 hash でグローバル安定 (`@keyframes qkf_xxxxxxxx`、`qg_xxxxxxxx` 相当の global)。
  同一内容は別名でも同一出力に重複排除される。同名で内容が異なる定義は先勝ち＋警告する。
- `animation` / `animation-name` 値中の定義名トークン (空白・カンマ区切りの完全一致) は
  確定名へ書き換える。`none` / `inherit` / `initial` / `unset` / `revert` / `revert-layer`
  および部分一致 (`fadein`)・関数内 (`var(--fade)`) は書き換えない。
- 書き換え範囲: 同一オブジェクト内は常に解決する。object 記法では同一モジュール内の
  別 occurrence 定義も解決する (local 定義優先)。template 内参照は同一リテラル内に
  co-locate すること。未定義名は外部 keyframes 参照とみなして触らない。
- `animation` / `animation-name` に動的値・条件値を使い、同一スコープに `@keyframes`
  定義がある場合は untouched + 警告になる (確定名を静的に書けないため)。

## 動的値

top-level property の値に JS 式を書ける。受理する式は identifier / member chain のみ
(`props.width`・`a?.b`・`items[0].h`)。call・ternary (後述の有限形を除く)・template・
spread・comment 混じりは parse 不能として untouched になる。

- 静的な値: そのまま atom 化する。
- 任意値 (`props.userColor` 等): `ParametricAtom` 化 (共有可能な構造＋slot) するか、
  `style` に inline 残しする。`promotion` option (`never` / `cost-based` (既定) / `always`)
  に従い、module 内で共有されない単発構造は inline のままになる。
  slot var 名は生成 id のみ (`--qstyle-<hash6>-<i>`) で source 識別子は使わない。
- 有限静的 ternary (`color: active ? 'red' : 'gray'`): 両枝が string/number/`null` の
  場合のみ、静的な複数 atom＋実行時 class 選択に展開する (CSS 変数化しない)。
  `null` 枝は「class なし」を意味する。nested ternary は untouched。
- object 構文内の template literal 値 (`` transform: `translateX(${x}px)` ``): 静的部分と
  slot の交互列として複合 ParametricAtom に落とす。
- nested (dotted path) の動的値 (`'&:hover': { width: w }` の `w`) は context 付き slot を
  生成できないため untouched になる。
- 同一 property への static×dynamic、構造の異なる dynamic 同士の競合は untouched になる
  (cascade 順を保証できないため)。

## composition (`css()` と配列)

- `css()` は完全 static の object のみ module-scope handle 化の対象になる
  (dynamic・residual 混じりは登録せず、利用側で解決する)。
- 配列は左→右に合成し、同 property (property＋context＋important 一致) は後勝ち。
  falsy (`false` / `null` / `undefined`) は無視、nested array は flatten する。
- 意味的に同一な handle は dedup される。
- 条件付き (`cond && handle`、`c ? a : b`): 無条件部と分離し、static は class、
  dynamic は parametric class＋条件 spread に展開する。条件付き parametric handle の
  適用・ネスト conditional 等の複雑形は untouched。
- module をまたぐ handle 参照 (`import { base } from './styles'`) は未解決のまま残り、
  diagnostic が出る。

## tagged template literal

- 静的な string/number interpolation は fold する (`gap: ${8}px` → `gap:8px`)。
- 値内の runtime interpolation は ParametricAtom の slot になる
  (直後の単位 text から `length` / `percentage` / `angle` / `time` 等を推測、他は `custom`)。
- property 名・selector 条件・単独の interpolation、値内の StyleHandle 参照は
  residual + 警告になる。template 内の handle 埋め込み (`${base};`) は splice される。
- nested block 内の StyleHandle interpolation は未対応 (residual)。
- object との等価宣言は同一 semantic hash になる。

## untouched と residual

最適化不能箇所は書き換えず残し、理由を `ResidualRuleNode.reason` に記録する。
実際に emit される理由は次の4種:

- `unsupported-selector` — 対応外セレクタ・`&` 再出現等
- `unsupported-at-rule` — 対応外 at-rule・nested の `@keyframes` 等
- `unsupported-value` — 値として扱えないもの (object/array 等)・keyframes 内の動的値等
- `unsupported-syntax` — 構文として不正なもの・空 block・不正フレーム等

(`shorthand-ordering` / `source-order-sensitive` / `third-party-preservation` /
`unknown` は将来用の予約語彙で、現状 emit されない。)

`diagnostics` option (`silent` / `warning` (既定) / `error`) に従い警告・throw する。
`optimization: 'strict'` は最適化不能箇所を compile error にする。
`optimization: 'preserve'` は atomic 化せず宣言順のまま 1 block 化する
(順序依存ペアは untouched)。
