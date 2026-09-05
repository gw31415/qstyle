# Qwik Style Graph Compiler
## 設計思想・詳細設計・実装計画

**Status:** Draft Design  
**Target:** Qwik v2 + Vite  
**Document type:** Architecture / Detailed Design / Implementation Plan  
**Naming:** `@qstyle/*` は説明用の仮称であり、正式パッケージ名ではない。

---

## 1. 目的

本プロジェクトは、Qwik の `useStyles$()` / `useStylesScoped$()` が提供する「コンポーネント単位で必要なスタイルを遅延ロードできる」性質を維持しつつ、サイト全体を横断して CSS を解析・再配置・共有・分割し、以下を同時に実現する CSS コンパイラおよび Vite plugin 群を構築することを目的とする。

1. サイト全体で意味的に同一なスタイル指定を重複させない。
2. CSS ファイルやコンポーネントを単位にせず、宣言・ルール・依存関係を意味論的に再構成する。
3. ルート・コンポーネント・遅延境界ごとの利用実態に基づいて CSS chunk を構成する。
4. 初期表示で不要な CSS を配信しない。
5. SSG 可能なスタイル依存は build-time に確定する。
6. 生成物は content hash 付き immutable asset とし、長期キャッシュを最大化する。
7. authoring API は Emotion に近い書き味を持つ `css` prop / `css()` / tagged template literal を提供する。
8. runtime 値を必要とするスタイルは CSS Custom Property に分離し、CSS 構造自体は共有可能な `ParametricAtom` として再利用する。
9. CSS の cascade / specificity / shorthand / source order などの意味論を壊す最適化は行わない。
10. 安全性を証明できないスタイルは Qwik の scoped style 等へ residual として残し、最適化不能を correctness failure にしない。
11. Tailwind CSS v4 等の外部 DSL は将来 frontend adapter として接続可能な構造だけを維持し、MVP では実装しない。

本プロジェクトの主眼は「CSS を小さくすること」だけではない。

**転送量、未使用 CSS、HTTP request 数、キャッシュ局所性、HTML の class/variable 増加、Qwik の resumability を含む総コストを最小化すること**を目的とする。

---

## 2. 非目標

初期段階では以下を非目標とする。

- CSS 言語の独自再実装
- Tailwind / UnoCSS 等の utility DSL adapter の MVP 実装
- Qwik の style lifecycle の置き換え
- runtime CSS-in-JS engine の実装
- 任意 CSS の強制的な完全 atomic 化
- すべての component に対する one-component-one-CSS-chunk
- one-atom-one-HTTP-request
- build ごとにサイト全体 CSS を単一巨大ファイルへ再結合すること
- dynamic selector / arbitrary runtime media query の完全静的化
- dev mode で production と同等の全サイト最適化を毎変更時に行うこと

---

# Part I — 設計思想

## 3. 基本原則

### 3.1 Correctness first

CSS の意味論を変更する可能性がある最適化は実施しない。

特に次を保護対象とする。

- cascade
- specificity
- source order
- `!important`
- shorthand / longhand interaction
- CSS Layers
- pseudo classes / pseudo elements
- selector relation
- media query
- container query
- `@supports`
- custom properties
- inheritance
- animation/keyframes dependencies
- font-face dependencies

最適化可能性が不明な場合は residual rule として保持する。

---

### 3.2 Build-time first, runtime minimum

静的に決定可能な処理はすべて build-time に寄せる。

runtime に残すのは原則として以下だけとする。

- 実際の動的値
- Qwik が本来 lazy-load する component style dependency
- client-only で初めて出現する component の style acquisition

runtime に CSS AST parser、style compiler、rule packer は持ち込まない。

---

### 3.3 Style identity と delivery identity を分離する

同じスタイルであることと、同じ HTTP chunk に入ることは別問題である。

```text
Style Semantic Identity
        │
        ▼
     Style Atom
        │
        ▼
 Usage / Route Graph
        │
        ▼
   Chunk Planning
        │
        ▼
CSS Asset Identity
```

したがって、

- atom hash
- rule hash
- chunk hash

を別々に定義する。

---

### 3.4 Source file ownership を捨て、provenance は保持する

CSS ファイル単位で chunking しない。

一方で、最適化判断のため以下の provenance は保持する。

```text
source location
   ↓
source module
   ↓
component
   ↓
lazy boundary
   ↓
route
```

これにより、CSS をグローバルに deduplicate しながら、必要な場所だけへ戻して配信できる。

---

### 3.5 Atomicization と network chunking を分離する

atomic CSS を作ることと HTTP request を細かくすることを混同しない。

内部表現は細かくする。

ネットワーク出力は適切にまとめる。

```text
many semantic atoms
       ↓
usage clustering
       ↓
few content-addressed style packs
```

---

### 3.6 Qwik を backend lifecycle として利用する

Qwik がすでに持つ、

- SSR 時の style 挿入
- component に紐づく style dependency
- lazy component loading
- resumability

を可能な限り利用する。

初期実装では Qwik-native style module / QRL backend を優先し、その後に raw hashed `.css` asset backend を追加する。

---

### 3.7 Frontend adapter architecture

MVP の frontend は Qwik TSX 内の `css` prop / `css()` / tagged template literal と、既存 `useStyles$()` / `useStylesScoped$()` 連携を扱う。

```text
Qwik authoring frontend ─┐
legacy Qwik CSS frontend ├─→ Style IR → Optimizer → Chunker → Backend
future adapters          ─┘
```

core optimizer は authoring syntax を知らず、Style IR のみを扱う。Tailwind CSS v4 等は将来 `future adapters` として接続するが、MVP の実装・品質ゲートには含めない。

## 4. 成功条件

本システムが成功している状態を以下とする。

### 4.1 Correctness

- plugin 無効時と有効時で visual / computed style が意味論的に一致する
- route navigation 後も style が欠落しない
- lazy component 出現時にも必要な style が取得される
- scoped selector semantics が壊れない

### 4.2 Performance

- 同一 semantic declaration が複数箇所から重複出力されない
- 初期 route に不要な CSS が大幅に減る
- shared style は cache reuse される
- 小さすぎる chunk の乱立を避ける
- build の局所変更で無関係 chunk hash が変化しにくい

### 4.3 Developer Experience

- Qwik の通常の `useStyles$()` / `useStylesScoped$()` が利用可能
- `css` prop / `css()` / template literal が同じ Style IR と composition semantics を共有する
- dev/HMR が実用的な速度
- source map / diagnostics が source location を保持
- optimizer が fallback した理由を inspect/debug mode で確認可能

---

# Part II — 全体アーキテクチャ

## 5. パッケージ構成

仮称:

```text
packages/
  core/
  qwik/
  vite/
  inspector/
```

### `@qstyle/core`

責務:

- Style IR
- canonicalization
- semantic hashing
- correctness analysis
- atomicization
- rule dedup
- dependency graph
- usage graph
- chunk cost model
- chunk planning
- deterministic serialization

### `@qstyle/qwik`

責務:

- `css` prop transform
- `css()` handle / composition transform
- tagged template literal transform
- runtime expression → RuntimeSlot / CSS Custom Property lowering
- Qwik TSX / style hook analysis
- `useStyles$()` / `useStylesScoped$()` interoperability
- component ownership
- scoped residual handling
- Qwik-native style backend
- Qwik City / SSG route linkage

### `@qstyle/vite`

責務:

- Vite plugin lifecycle
- virtual modules
- asset emission
- dev/prod mode switching
- cache invalidation
- HMR coordination
- manifest emission

### `@qstyle/inspector`

責務:

- atom provenance viewer
- chunk membership viewer
- dedup report
- residual reasons
- route CSS report
- cost model statistics

### 将来 adapter

Tailwind CSS v4 / UnoCSS 等を Style IR frontend として追加できる extension point は保持する。ただし MVP では package・compiler bridge・互換性テストを実装しない。

## 6. コンパイルパイプライン

```text
                         Qwik TSX
                            │
              ┌─────────────┼─────────────┐
              │             │             │
          css prop        css()       css`...`
              │             │             │
              └─────────────┼─────────────┘
                            ▼
                    Qwik Style Frontend
                            │
          existing useStyles*/CSS interop
                            │
                            ▼
                        Style IR
                            │
                  canonicalization
                            │
                  dependency linking
                            │
                 correctness analysis
                            │
            ┌───────────────┼────────────────┐
            │               │                │
      Static Atom     Parametric Atom    Residual Rule
            │               │                │
            └───────────────┼────────────────┘
                            ▼
                     Global Dedup
                            │
                            ▼
                      Usage Graph
                            │
             component / route / lazy boundary
                            │
                            ▼
                      Chunk Planner
                            │
                  cost / cache clustering
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
      Qwik native backend           CSS asset backend
              │                           │
              └─────────────┬─────────────┘
                            ▼
                     SSG manifest/linkage
                            │
                            ▼
                     content-hashed output
```

将来の utility DSL adapter も `Style IR` の入口にのみ追加し、optimizer/chunker/backend を変更しない。

# Part III — Style IR

## 7. IR の目的

IR は CSS AST そのものではない。

以下を可能にする semantic representation とする。

- 同一スタイルの比較
- dynamic/static 分離
- dependency analysis
- source-order constraint
- safe atomicization
- chunk reuse
- frontend 非依存

---

## 8. 基本型

概念型:

```ts
type StyleNode =
  | StaticAtom
  | ParametricAtom
  | RuleNode
  | ResidualRuleNode
  | ThemeVariableNode
  | RuntimeSlotNode
  | KeyframesNode
  | FontFaceNode
  | PropertyRegistrationNode
  | GlobalBaseNode;
```

---

## 9. StaticAtom

```ts
interface StaticAtom {
  kind: 'static-atom';

  property: CanonicalProperty;
  value: CanonicalValue;
  important: boolean;

  context: RuleContext;
  ordering: OrderingConstraints;

  provenance: ProvenanceSet;
}
```

例:

```text
color:red
display:flex
gap:8px
```

---

## 10. RuleContext

```ts
interface RuleContext {
  pseudo?: PseudoContext[];
  media?: CanonicalCondition;
  supports?: CanonicalCondition;
  container?: CanonicalCondition;
  layer?: LayerId;

  selectorRelation?: SelectorRelation;
}
```

`hover:text-red-500` と `text-red-500` は value が同じでも異なる context を持つため別 semantic identity となる。

---

## 11. ParametricAtom

runtime 値だけが動的で CSS 構造が静的な style を表す。

```ts
interface ParametricAtom {
  kind: 'parametric-atom';

  property: CanonicalProperty;
  valueTemplate: ValueTemplate;
  slots: RuntimeSlotId[];

  important: boolean;
  context: RuleContext;
  ordering: OrderingConstraints;

  provenance: ProvenanceSet;
}
```

例:

```text
width: Runtime<length>
```

出力:

```css
.q_x {
  width: var(--q-x);
}
```

runtime:

```html
<div class="q_x" style="--q-x:42px">
```

---

## 12. RuntimeSlot

```ts
interface RuntimeSlotNode {
  kind: 'runtime-slot';

  id: RuntimeSlotId;

  valueType:
    | 'number'
    | 'integer'
    | 'length'
    | 'percentage'
    | 'color'
    | 'angle'
    | 'time'
    | 'transform-function'
    | 'image'
    | 'custom';

  fallback?: CanonicalValue;
}
```

重要:

**source variable 名を semantic identity に含めない。**

```ts
transform: `translateX(${x}px)`
transform: `translateX(${offset}px)`
```

は同じ構造であれば同一 ParametricAtom になり得る。

---

## 13. ValueTemplate

複合 dynamic value を文字列ではなく AST として表現する。

例:

```text
transform:
  translate(
    Runtime<length>,
    Runtime<length>
  )
  scale(
    Runtime<number>
  )
```

出力:

```css
.q_transform {
  transform:
    translate(var(--q-x), var(--q-y))
    scale(var(--q-scale));
}
```

---

## 14. ThemeVariableNode

theme token 等、build output に含まれる CSS variable dependency。

```ts
interface ThemeVariableNode {
  kind: 'theme-variable';
  name: string;
  value: CanonicalValue;

  emission: 'when-used' | 'always';
}
```

区別:

```text
Theme Variable
  --color-red-500
  → shared CSS dependency

Runtime Slot
  --q-width
  → per element runtime value
```

---

## 15. ResidualRuleNode

安全な atomicization / dedup が保証できないルール。

例:

- selector topology が複雑
- shorthand/longhand ordering dependency
- source-order sensitive rule
- unsupported CSS construct
- third-party behavior preservationが必要

```ts
interface ResidualRuleNode {
  kind: 'residual-rule';

  cssAst: CssAstFragment;
  scope: 'global' | 'component';
  reason: ResidualReason;

  provenance: ProvenanceSet;
}
```

---

# Part IV — CSS の安全な最適化

## 16. Optimization levels

### Level 0 — Preserve

- parse
- minify
- exact rule dedup
- no atomicization

### Level 1 — Safe

- semantic declaration dedup
- safe atomicization
- rule sharing
- unsafe rules residual

標準モード。

### Level 2 — Strict

authoring 制約を強めてより完全な atomization を可能にする。

例:

- source-order dependent override 禁止
- ambiguous shorthand 禁止
- dynamic selector 制約
- predictable variant order

---

## 17. Atomicization 判定

以下すべてを満たす場合のみ atomize を許可する。

1. declaration の独立性を証明できる
2. shorthand/longhand 競合がない、または ordering constraint を保持可能
3. selector context を安全に再表現可能
4. specificity が変化しない、または class rewrite semantics が等価
5. CSS layer/order semantics を維持可能
6. custom property definition/use relationship を破壊しない

---

## 18. Ordering constraints

Style IR は単なる set ではなく partial order を持つ。

```ts
interface OrderingConstraints {
  after?: StyleNodeId[];
  before?: StyleNodeId[];
  group?: OrderingGroupId;
}
```

これにより、

```css
margin: 0;
margin-left: 10px;
```

などの順序依存を誤って並び替えない。

---

# Part V — Qwik 統合と MVP Authoring API

## 19. MVP public API の範囲

MVP の authoring surface は次の4つに限定する。

1. `css` prop + object syntax
2. `css()` + composition
3. `css` tagged template literal
4. dynamic value → CSS Custom Property / `ParametricAtom`

以下は MVP に含めない。

- `styled()`
- `recipe()` / variants API
- `keyframes()` の専用 helper
- `globalCss()` の専用 helper
- runtime CSS-in-JS engine
- Tailwind CSS v4 frontend adapter

Tailwind CSS v4 は将来同じ Style IR に接続する方針のみ維持する。

---

## 20. `css` prop + object syntax

最も基本的な記法。Emotion の object styles に近い形を採用する。

```tsx
export const Card = component$((props) => (
  <article
    css={{
      display: 'flex',
      gap: 8,
      width: props.width,

      '&:hover': {
        backgroundColor: 'var(--surface-hover)',
      },
    }}
  />
));
```

### 20.1 型

概念型:

```ts
type CssPrimitive = string | number;

type StyleObject = {
  [K in CSSProperty]?: CssPrimitive | RuntimeExpression;
} & {
  [selectorOrAtRule: string]: StyleObject | unknown;
};

type CssProp =
  | StyleObject
  | StyleHandle
  | false
  | null
  | undefined
  | readonly CssProp[];
```

実装では TypeScript の CSS property typing を利用し、既知 property の typo を compile/type error にできることを目標とする。custom property (`--foo`) は許可する。

### 20.2 number semantics

数値の扱いは曖昧にしない。

- unitless property は数値をそのまま serialize
- length を許す一般的 property は、MVP では Emotion/React に近い `px` 補完規則を採用する
- `0` は不要な単位を付けない
- 曖昧または規則化できない場合は string を要求する

unitless property table は versioned fixture で固定し、意図せぬ変更を breaking behavior として扱う。

### 20.3 nested selector / at-rule

```tsx
<div
  css={{
    color: 'black',
    '&:hover': { color: 'blue' },
    '& > svg': { width: 16, height: 16 },
    '@media (width >= 768px)': { padding: 16 },
    '@supports (display: grid)': { display: 'grid' },
    '@container (width >= 400px)': { gap: 12 },
  }}
/>
```

optimizer が安全に atomize できない selector/rule は `ResidualRuleNode` に落とす。記法上サポートすることと、atomic optimization 可能であることを分離する。

### 20.4 `class` / `style` coexistence

既存 JSX と共存する。

```tsx
<div class="legacy" css={{ color: 'red' }} style={{ opacity: 0.8 }} />
```

precedence は compiler が deterministic に維持する。MVP の原則は以下。

```text
external/class-authored CSS
        < css prop layer
        < explicit inline style
```

ただし `!important`、author layer、specificity 等 CSS 本来の cascade はそのまま優先される。「常に css prop が勝つ」という意味ではない。chunk 順序に依存せず同じ cascade order を再現する。

---

## 21. `css()` + composition

再利用可能なスタイルは `css()` で宣言する。戻り値は runtime class string ではなく compile-time `StyleHandle` とみなす。

```tsx
const base = css({
  display: 'flex',
  alignItems: 'center',
});

const selected = css({
  color: 'red',
});

<div css={[base, props.selected && selected]} />
```

### 21.1 composition semantics

配列は左から右に composition する。

```tsx
<div css={[a, b, c]} />
```

意味論上の優先順位は `a < b < c`。falsy 値 (`false`, `null`, `undefined`) は無視する。nested array は flatten する。

compiler は同一 property の競合について、単に class attribute の文字列順序に依存しない。Style IR に declaration order / layer constraint を保持し、chunk 分割後も同じ結果を保証する。

### 21.2 object と handle の混在

```tsx
<div
  css={[
    base,
    { width: props.width },
    props.selected && { boxShadow: '0 0 0 2px var(--focus)' },
  ]}
/>
```

を許可する。inline object も内部的には匿名 `StyleHandle` と同等の contribution として解析する。

### 21.3 static handle identity

同じ semantic style は宣言位置・変数名が違っても同一 Style IR node に deduplicate 可能とする。

---

## 22. `css` tagged template literal

CSS を直接書きたい場合の第一級 syntax。

```tsx
const card = css`
  display: flex;
  gap: 8px;

  &:hover {
    color: blue;
  }
`;

<div css={card} />
```

### 22.1 interpolation

MVP で認める interpolation は限定する。

- primitive literal
- statically resolved const
- `StyleHandle`
- runtime primitive expression → RuntimeSlot

```tsx
const style = css`
  width: ${props.width}px;
  color: ${props.color};
`;
```

は `ParametricAtom` へ lowering する。

任意関数を build-time evaluator として実行しない。

```tsx
css`color: ${getUnknownStyle()};`
```

のような expression は、静的に安全な runtime value slot として扱える場合のみ許可し、CSS 構造そのものを生成する interpolation は diagnostic とする。

### 22.2 object syntax との同値性

以下は Style IR 上で同一意味になることを要求する。

```tsx
css({ display: 'flex', gap: 8 })
```

```tsx
css`display:flex;gap:8px;`
```

serialization spelling が違っても canonicalization 後に同一 atom を共有できることを品質要件とする。

---

## 23. dynamic value → CSS Custom Property

値だけが runtime で CSS の構造が静的な場合、`ParametricAtom` を生成する。

入力:

```tsx
<div
  css={{
    width: props.width,
    color: props.color,
    transform: `translateX(${x.value}px)`,
  }}
/>
```

概念出力:

```css
.q_w { width: var(--q-w); }
.q_c { color: var(--q-c); }
.q_tx { transform: translateX(var(--q-x)); }
```

```tsx
<div
  class="q_w q_c q_tx"
  style={{
    '--q-w': props.width,
    '--q-c': props.color,
    '--q-x': `${x.value}px`,
  }}
/>
```

### 23.1 finite static expression

```tsx
css={{ color: active ? 'red' : 'gray' }}
```

のように有限個の静的候補として証明できる場合は、原則として CSS variable 化せず複数 StaticAtom + runtime class choice にする。

### 23.2 arbitrary runtime value

```tsx
css={{ color: props.userColor }}
```

のような任意値は RuntimeSlot とする。

### 23.3 compound value

```tsx
css={{
  transform: `translate(${x.value}px, ${y.value}px) scale(${scale.value})`,
}}
```

は value AST を静的部分と runtime slot に分ける。

### 23.4 runtime update

Signal/props 更新時に style pack を再取得・再生成しない。更新対象は custom property value のみとする。Qwik の resume semantics を壊す runtime helper を常駐させない。

### 23.5 inline fallback

構造の静的解析ができないが通常の inline style なら表現可能な場合は、safe mode では明示的な diagnostic を伴って inline style に fallback できる。runtime stylesheet injection には fallback しない。

---

## 24. 既存 `useStyles$()` / `useStylesScoped$()` との共存

既存 Qwik コードを壊さない。

```tsx
import legacy from './button.css?inline';

export const Button = component$(() => {
  useStylesScoped$(legacy);

  return (
    <button class="button" css={{ display: 'flex' }}>
      OK
    </button>
  );
});
```

MVP frontend は legacy style contribution の provenance を追跡し、可能な範囲で shared Style IR に統合する。ただし scoped semantics を安全に解除できないものは residual として Qwik lifecycle に残す。

Qwik runtime の style acquisition/resume lifecycle 自体は置き換えない。

---

# Part VI — 将来の Frontend Adapter

## 25. Tailwind CSS v4 等の位置づけ

MVP では Tailwind frontend を実装しない。

ただし次の architectural invariant は守る。

```text
future Tailwind/UnoCSS adapter
          │
          ▼
       Style IR
          │
   existing optimizer/chunker/backend
```

将来 adapter を追加するために、core IR・semantic hashing・usage graph・chunk planner が Qwik `css` syntax 固有の文字列や AST node を要求しないことを品質要件とする。MVP では adapter interface の最小型定義または設計コメントまでに留め、candidate compiler bridge、utility compatibility、Tailwind-specific tests は行わない。


# Part VII — 動的スタイル

## 26. 四分類

dynamic style は次の4つへ分類する。

| 種類 | 処理 |
|---|---|
| 完全静的 | StaticAtom |
| 有限状態 | 複数 StaticAtom |
| 値のみ runtime | ParametricAtom + CSS Custom Property |
| CSS 構造自体が runtime | runtime/residual fallback |

---

## 27. 有限状態

例:

```ts
type Intent = 'primary' | 'secondary' | 'danger';
```

これは runtime variable 化しない。

```text
primary   → static atom set
secondary → static atom set
danger    → static atom set
```

理由:

- キャッシュ可能
- selector/variant を完全静的化可能
- CSS variable より短い場合が多い
- browser style engine が通常 class として最適化可能

---

## 28. arbitrary runtime value

例:

```tsx
<div style={{ width: `${progress}%` }} />
```

optimizer が有益と判断した場合:

```css
.q_width {
  width: var(--q-width);
}
```

```tsx
<div
  class="q_width"
  style={{ '--q-width': `${progress}%` }}
/>
```

---

## 29. ParametricAtom の共有

以下は同一構造として共有可能。

```tsx
width={`${a}px`}
width={`${b}px`}
```

semantic identity:

```text
property = width
template = Runtime<length>
context = normal
```

実際の値は hash に含めない。

---

## 30. 複合値

入力:

```tsx
transform={`translate(${x}px, ${y}px) scale(${scale})`}
```

出力:

```css
.q_transform {
  transform:
    translate(var(--q-x), var(--q-y))
    scale(var(--q-scale));
}
```

---

## 31. pseudo state + dynamic value

例:

```css
.q_hover:hover {
  color: var(--q-hover-color);
}
```

runtime:

```html
<button
  class="q_hover"
  style="--q-hover-color:#f00">
```

これにより inline style だけでは実現できない pseudo selector 上の runtime value を共有 CSS として表現できる。

---

## 32. dynamic value promotion cost model

すべての inline style を ParametricAtom に変えるべきではない。

比較:

```html
style="width:42px"
```

vs

```html
class="q_w" style="--q-w:42px"
```

1回しか出ないなら前者が短い場合がある。

したがって promotion は cost model で判断する。

```text
benefit =
  repeated declaration bytes saved
+ CSS cache reuse
- extra class bytes
- custom property bytes
- additional CSS rule bytes
```

設定:

```ts
runtimeStylePromotion:
  'never'
  | 'cost-based'
  | 'always'
```

標準は `cost-based`。

---

## 33. CSS 構造自体が dynamic な場合

例:

```ts
const property = condition ? 'width' : 'height';
```

または、

- runtime selector
- runtime pseudo
- arbitrary runtime media breakpoint
- runtime `@supports` condition

は ParametricAtom では処理しない。

有限集合なら static expansion。

無限/任意なら runtime fallback。

---

# Part VIII — Usage Graph

## 34. graph model

```ts
interface UsageGraph {
  styleToComponents: Map<StyleNodeId, Set<ComponentId>>;
  componentToRoutes: Map<ComponentId, Set<RouteId>>;
  componentToLazyBoundaries: Map<ComponentId, Set<LazyBoundaryId>>;
}
```

---

## 35. usage signature

atom の利用集合を signature 化する。

```text
atom A → {Button, Card, Header}
atom B → {Button, Card, Header}
atom C → {Button, Card}
```

A/B は完全一致するため第一候補として同 pack に入れる。

---

## 36. route signature

SSG/route graph が利用可能な場合:

```text
atom A → {/, /about, /settings}
atom B → {/settings}
```

route-level separation に利用する。

---

# Part IX — Chunk Planning

## 37. 原則

1 atom = 1 request にしない。

1 component = 1 file に固定しない。

全サイト = 1 file にもしない。

---

## 38. 第一段階 grouping

usage set 完全一致。

```text
UsageSet(atom A) == UsageSet(atom B)
```

なら同じ candidate pack。

---

## 39. 第二段階 clustering

近い usage set を必要に応じて merge する。

指標例:

```text
Jaccard(A,B)
=
|users(A) ∩ users(B)|
/
|users(A) ∪ users(B)|
```

ただし Jaccard だけで決めない。

---

## 40. Cost function

概念式:

```text
ExpectedTotalCost =
    transferredCssBytes
  + requestOverhead * requestCount
  + cacheMissPenalty
  + unusedCssPenalty
  + htmlClassBytes
  + runtimeVariableBytes
  + invalidationPenalty
```

さらに route traffic weighting を将来追加可能。

```text
ExpectedTransferredBytes =
Σ routeProbability(route)
  * bytesRequired(route)
```

---

## 41. 安定性ペナルティ

頻繁に変更される local style を、大きな shared chunk に混ぜると cache invalidation が増える。

そこで、

```text
invalidationPenalty
```

を導入する。

将来的には Git history または incremental build history を利用可能だが、初期版は利用しない。

初期版では module locality と usage locality を proxy とする。

---

## 42. Chunk の deterministic naming

```text
style.<content-hash>.css
```

chunk hash は最終 serialize 済み CSS bytes から計算する。

```text
ChunkHash = H(finalSerializedCss)
```

---

## 43. Atom hash

atom hash は semantic structure から計算する。

```text
AtomHash = H(
  canonical property
  canonical value/template
  important
  selector context
  conditional context
  ordering semantics
)
```

chunk membership は含めない。

---

# Part X — SSG / Route Integration

## 44. 目的

SSG では route ごとに render される component graph を build-time に確定できる範囲が広い。

それを利用し、

```text
route → required style packs
```

manifest を生成する。

---

## 45. Route Style Manifest

例:

```json
{
  "/": [
    "base.81ad.css",
    "home.831c.css"
  ],
  "/settings": [
    "base.81ad.css",
    "forms.a831.css",
    "settings.18ab.css"
  ]
}
```

実際には logical name ではなく hash asset reference を使用する。

---

## 46. 初期 document

SSG/SSR 時に確実に必要な style は、

- inline
- `<link rel="stylesheet">`
- preload
- Qwik style head injection

のいずれか最適な backend policy で出力する。

初期 MVP は Qwik native lifecycle を優先する。

---

## 47. client-only component

SSG 時に存在しない component が後から出現する場合は、

```text
component
  ↓
style pack dependency
  ↓
Qwik lazy load
```

を維持する。

SSG manifest だけを唯一の style source にしない。

---

# Part XI — Backend

## 48. Backend A: Qwik-native

MVP 推奨。

virtual style module:

```text
virtual:qstyle/pack/<id>
```

概念:

```tsx
import pack from 'virtual:qstyle/pack/a?inline';
useStyles$(pack);
```

利点:

- Qwik style lifecycle を利用
- custom client runtime が不要
- SSR/head integration を Qwik に委譲
- 最初の correctness 実装が容易

欠点:

- 生 `.css` asset として理想的な network behavior にならない可能性
- bundler/Qwik optimizer の生成形式に影響される

---

## 49. Backend B: Hashed CSS assets

最終目標。

```text
assets/style.<hash>.css
```

Vite asset emission を利用する。

要件:

- content hash
- immutable caching
- final URL resolution
- SSG route manifest
- lazy component dependency mapping

---

## 50. Asset cache policy

ホスティング側の推奨:

```http
Cache-Control: public, max-age=31536000, immutable
```

content hash が URL に含まれるため、変更時は URL が変わる。

---

# Part XII — Vite Plugin Lifecycle

## 51. plugin phases

概念:

```text
configResolved
    │
buildStart
    │
module discovery
    │
resolveId / load
    │
transform
    │
graph finalization
    │
chunk planning
    │
render / virtual module generation
    │
generateBundle
    │
manifest emission
```

---

## 52. resolveId/load

virtual modules:

```text
virtual:qstyle/registry
virtual:qstyle/pack/<id>
virtual:qstyle/manifest
```

内部 ID は Vite convention に従って null-byte prefixed representation を利用する。

---

## 53. transform

Qwik/TSX transform で行うこと:

- style hook call の識別
- CSS import linkage
- source style usage provenance
- optional class rewrite
- runtime slot injection
- generated style pack import injection

---

## 54. generateBundle

- final pack serialization
- asset emission
- chunk metadata
- route manifest
- debug report
- deterministic hash validation

を行う。

---

# Part XIII — Dev / HMR

## 55. Dev mode policy

production optimization を毎回行わない。

dev:

```text
CSS/module local
+ exact dedup
+ stable debug names
+ source map
+ fast invalidation
```

production:

```text
whole-site analysis
+ semantic dedup
+ atomicization
+ usage clustering
+ route analysis
+ hashed output
```

---

## 56. Stable debug class

dev:

```text
q_Button_display_flex
```

のような可読名を選択可能。

prod:

```text
q_a81d
```

---

## 57. Incremental cache

cache key:

```text
source content hash
compiler version
config hash
frontend adapter version
target browsers
```

保存対象:

- parsed CSS IR
- frontend analysis result
- source module provenance
- dependency graph fragment

全サイト chunk planning は必要な時だけ再実施する。

---

# Part XIV — Diagnostics

## 58. Inspector

最低限以下を出力可能にする。

```text
qstyle inspect atom q_a81d
```

想定出力:

```text
Atom: q_a81d
Semantic:
  display:flex

Used by:
  Button
  Card
  Header

Routes:
  /
  /settings

Chunk:
  style.71bc9.css

Sources:
  button.css:12
  card.tsx:42 (css prop: display:flex)
```

---

## 59. Residual explanation

```text
button.css:34
not atomicized:
  shorthand/longhand ordering dependency
```

開発者が最適化不能理由を理解できるようにする。

---

# Part XV — Configuration

## 60. MVP configuration

```ts
qstyle({
  optimization: 'safe',
  backend: 'qwik-native',

  runtimeStyles: {
    strategy: 'custom-property',
    fallback: 'inline',
    promotion: 'cost-based',
  },

  composition: {
    falsy: 'ignore',
  },

  chunking: {
    strategy: 'usage-cluster',
    minChunkBytes: 1024,
    maxChunkBytes: 32 * 1024,
  },

  diagnostics: 'warning',
  debug: false,
});
```

数値は正式値ではなく設計例。MVP で public に露出させる option は、実際に挙動差を保証できるものだけに絞る。

## 61. Strict mode

```ts
qstyle({ optimization: 'strict' })
```

strict mode では、静的解析不能な CSS 構造や意味論を保持できない変換を compile error とする。safe mode は correctness-preserving residual / inline fallback を選ぶ。

## 62. Authoring API exports

MVP の export は原則として以下に限定する。

```ts
import { css } from '@qstyle/qwik';
```

`css` は overload により object function と tagged template literal の双方として利用可能にする案を第一候補とする。

```ts
const a = css({ display: 'flex' });
const b = css`display:flex;`;
```

JSX の `css` prop typing は package 側の型拡張で提供する。


# Part XVI — Security / CSP

## 63. inline custom property

ParametricAtom は inline `style="--q-x:..."` を利用するため、CSP `style-src` policy と競合する可能性がある。

そのため runtime dynamic style backend を抽象化する。

将来候補:

- inline style attribute
- serialized style variable map
- nonce-based style element
- CSS Typed OM / DOM style assignment

ただし初期版は Qwik/一般的 Web の inline style semantics を利用する。

CSP strict environment は明示的な compatibility mode とする。

---

# Part XVII — 品質定義・テスト戦略

## 64. 品質をテストで定義する

MVP の品質は「代表例が動く」ではなく、以下の release gate を満たすこととして定義する。

### Release Gate P0

1. 対象 fixture 全件で plugin OFF の基準実装と plugin ON の `getComputedStyle()` が意味論的に一致する。
2. SSR / SSG / client navigation / lazy component / resume 後に style 欠落・FOUC・二重適用が発生しない。
3. 同一入力からの clean build が byte-for-byte deterministic である。
4. 同一 semantic declaration の重複排除が correctness を壊さない。
5. dynamic value 更新で新規 stylesheet/style rule を生成しない。
6. chunk 分割・ロード順を変更しても Style IR が定義した cascade order が維持される。
7. parser/transform が未対応構文に遭遇した場合、silent miscompile せず residual/fallback または diagnostic になる。
8. typecheck、unit、integration、browser differential、production build test がすべて green。

### Release Gate P1

- HMR が state を不必要に破棄せず style 更新を反映する。
- source map / diagnostic が元 TSX の位置を指す。
- 局所変更で無関係 asset hash が変化しない。
- benchmark corpus で baseline より初期 CSS / total CSS のいずれも意図しない大幅悪化がない。

### Release Gate P2

- 大規模 fixture、property-based test、fuzz test、複数 browser matrix、長時間 incremental build test を通す。

テスト ID の `P0` は release blocking、`P1` は beta blocking、`P2` は継続品質とする。

---

## 65. テストレイヤー

各 fixture は可能な限り次の複数レイヤーで同時検証する。

```text
source
  ↓
parser/frontend unit
  ↓
Style IR golden
  ↓
transformed TSX golden
  ↓
generated CSS/manifest golden
  ↓
SSR/SSG HTML integration
  ↓
real browser computed-style differential
  ↓
size/hash/cache assertions
```

Golden snapshot だけで correctness を証明しない。最終判定には実 browser の CSS engine を使用する。

---

## 66. `css` prop / object syntax テスト

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| OBJ-001 | P0 | `display: 'flex'` | StaticAtom 生成、表示一致 |
| OBJ-002 | P0 | 複数 declaration | 全 declaration が保持される |
| OBJ-003 | P0 | camelCase property | 正しい kebab-case に serialize |
| OBJ-004 | P0 | vendor-prefixed property | 意味を保持して serialize |
| OBJ-005 | P0 | custom property `--x` | 名前を変更せず保持 |
| OBJ-006 | P0 | unitless number (`opacity`, `zIndex` 等) | 単位を付加しない |
| OBJ-007 | P0 | length number | 規定に従い `px` 化 |
| OBJ-008 | P0 | zero length | `0` として同値 |
| OBJ-009 | P0 | negative number | 符号を保持 |
| OBJ-010 | P0 | decimal / scientific-equivalent value | canonicalize 後意味一致 |
| OBJ-011 | P0 | CSS-wide keyword `inherit` | そのまま保持 |
| OBJ-012 | P0 | `initial` / `unset` / `revert` / `revert-layer` | semantics 保持 |
| OBJ-013 | P0 | CSS variable reference | dependency を壊さない |
| OBJ-014 | P0 | `calc()` / `min()` / `max()` / `clamp()` | value AST が壊れない |
| OBJ-015 | P0 | comma-separated value | token boundary 保持 |
| OBJ-016 | P0 | string quoting を含む `content` | escape 正常 |
| OBJ-017 | P0 | data URL / escaped URL | serialization 破壊なし |
| OBJ-018 | P0 | empty object | 不要 class/style を生成しない |
| OBJ-019 | P0 | `css={false/null/undefined}` | DOM/CSS 影響なし |
| OBJ-020 | P1 | readonly object / `as const` | 型・transform 正常 |
| OBJ-021 | P1 | const alias | provenance を保持して解析 |
| OBJ-022 | P0 | unknown property typo | type error または明確な diagnostic |
| OBJ-023 | P0 | invalid value syntax | silent emit しない |
| OBJ-024 | P1 | unicode identifier/string | source map と serialization 正常 |

---

## 67. selector / pseudo / at-rule テスト

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| SEL-001 | P0 | `&:hover` | hover 時 computed style 一致 |
| SEL-002 | P0 | `&:focus` / `:focus-visible` | focus semantics 保持 |
| SEL-003 | P0 | `&::before` / `&::after` | pseudo element style 一致 |
| SEL-004 | P0 | `& > child` | child combinator 保持 |
| SEL-005 | P0 | `& + sibling` / `& ~ sibling` | sibling relation 保持 |
| SEL-006 | P0 | descendant selector | scope/cascade 保持 |
| SEL-007 | P0 | attribute selector | quoting/escaping 保持 |
| SEL-008 | P0 | `:not()` / `:is()` / `:where()` | specificity semantics 保持 |
| SEL-009 | P0 | `:has()` | 対応 browser で semantics 保持 |
| SEL-010 | P0 | nested `&` | selector expansion 正常 |
| SEL-011 | P0 | `@media` | 条件内 style のみ適用 |
| SEL-012 | P0 | nested media + pseudo | context graph 正常 |
| SEL-013 | P0 | `@supports` | support 条件 semantics 保持 |
| SEL-014 | P0 | `@container` | container condition 保持 |
| SEL-015 | P1 | cascade layer context | layer order 保持 |
| SEL-016 | P0 | atomize 不可能な selector | residual 化し silent rewrite しない |
| SEL-017 | P0 | selector specificity conflict | plugin OFF/ON 同値 |
| SEL-018 | P0 | source-order-dependent equal specificity | chunk order と無関係に同値 |

---

## 68. `css()` / composition テスト

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| CMP-001 | P0 | single StyleHandle | object 直書きと同値 |
| CMP-002 | P0 | `[a,b]` non-conflict | 両方適用 |
| CMP-003 | P0 | `[a,b]` same property | `b` が composition 上後勝ち |
| CMP-004 | P0 | `[a,b,c]` multiple conflicts | 左→右 semantics 保持 |
| CMP-005 | P0 | nested arrays | flatten 後順序維持 |
| CMP-006 | P0 | falsy entries | 無視される |
| CMP-007 | P0 | conditional handle true/false | 対応 style のみ適用 |
| CMP-008 | P0 | handle + inline object | 同一 composition model |
| CMP-009 | P0 | object + handle + object | ordering constraint 保持 |
| CMP-010 | P0 | duplicate same handle | visual 同値、CSS 重複なし |
| CMP-011 | P0 | semantically identical different handles | atom dedup |
| CMP-012 | P0 | shorthand in earlier / longhand in later | CSS semantics 保持 |
| CMP-013 | P0 | longhand earlier / shorthand later | CSS semantics 保持 |
| CMP-014 | P0 | `!important` conflict | CSS priority 保持 |
| CMP-015 | P0 | nested selector conflicts | source semantics 保持 |
| CMP-016 | P1 | handle reused 1000 times | CSS 1回、DOM値のみ増加 |
| CMP-017 | P1 | handle imported across modules | semantic identity 安定 |
| CMP-018 | P1 | circular module graph around handles | Vite/Qwik build を壊さず diagnostic |

---

## 69. tagged template literal テスト

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| TPL-001 | P0 | static declarations | object syntax と同値 |
| TPL-002 | P0 | whitespace/comments 差 | canonical identity 同一 |
| TPL-003 | P0 | nested selector | semantics 保持 |
| TPL-004 | P0 | media/supports/container | context 保持 |
| TPL-005 | P0 | static primitive interpolation | static fold |
| TPL-006 | P0 | const interpolation | 安全に解決可能なら static fold |
| TPL-007 | P0 | runtime number interpolation | RuntimeSlot 化 |
| TPL-008 | P0 | runtime color/string interpolation | RuntimeSlot 化、CSS injection なし |
| TPL-009 | P0 | compound value with 2 slots | ValueTemplate 正常 |
| TPL-010 | P0 | same structure, different variable names | 同一 ParametricAtom |
| TPL-011 | P0 | StyleHandle interpolation | composition semantics 保持 |
| TPL-012 | P0 | interpolation が property name を生成 | unsupported diagnostic |
| TPL-013 | P0 | interpolation が selector を生成 | unsupported diagnostic/residual policy |
| TPL-014 | P0 | interpolation が at-rule condition を生成 | silent compile しない |
| TPL-015 | P0 | escaped backtick / `${` 相当 | parser 正常 |
| TPL-016 | P1 | source map | interpolation 元位置を指す |
| TPL-017 | P0 | object vs template equivalent CSS | semantic dedup |
| TPL-018 | P1 | minified source input | transform 正常 |

---

## 70. Dynamic / ParametricAtom テスト

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| DYN-001 | P0 | dynamic length | custom property slot 化 |
| DYN-002 | P0 | dynamic number | unit 破壊なし |
| DYN-003 | P0 | dynamic percentage | `%` 保持 |
| DYN-004 | P0 | dynamic color | 任意 valid color を反映 |
| DYN-005 | P0 | dynamic angle/time | unit semantics 保持 |
| DYN-006 | P0 | dynamic transform single slot | CSS rule immutable |
| DYN-007 | P0 | dynamic transform multiple slots | 各 slot 独立更新 |
| DYN-008 | P0 | `hover` + dynamic color | pseudo rule + variable 正常 |
| DYN-009 | P0 | media + dynamic value | media context 内で variable 参照 |
| DYN-010 | P0 | two elements same atom/different values | element-local custom property で衝突なし |
| DYN-011 | P0 | parent/child same variable-shaped atom | inheritance による意図せぬ衝突なし |
| DYN-012 | P0 | signal update 1回 | CSS rule追加なし、value のみ更新 |
| DYN-013 | P0 | signal update 1000回 | stylesheet/rule count 増加なし |
| DYN-014 | P0 | SSR initial dynamic value | server HTML に初期値あり |
| DYN-015 | P0 | resume 後同値 | hydration/resume mismatch なし |
| DYN-016 | P0 | finite conditional static values | ParametricAtom ではなく static branch 可 |
| DYN-017 | P0 | arbitrary runtime value | ParametricAtom |
| DYN-018 | P0 | dynamic CSS structure | safe fallback/diagnostic |
| DYN-019 | P0 | value containing `;`, `}` 等の攻撃的文字列 | property value 境界を脱出しない |
| DYN-020 | P0 | nullish runtime value | property removal/未設定 semantics を定義通り実行 |
| DYN-021 | P1 | rapidly changing pointer position | style pack fetch 0、DOM update のみ |
| DYN-022 | P1 | same parametric structure across modules | semantic atom 共有 |
| DYN-023 | P1 | runtime slot ordering changes after unrelated edit | stable slot identity |
| DYN-024 | P0 | custom property name collision with user `--q-*` | namespace/collision policy で安全 |

---

## 71. Cascade / CSS semantics テスト

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| CSS-001 | P0 | shorthand → longhand | baseline と一致 |
| CSS-002 | P0 | longhand → shorthand | baseline と一致 |
| CSS-003 | P0 | logical vs physical property interaction | baseline と一致 |
| CSS-004 | P0 | inherited property | inheritance 一致 |
| CSS-005 | P0 | non-inherited property | inheritance しない |
| CSS-006 | P0 | custom property inheritance | baseline と一致 |
| CSS-007 | P0 | fallback `var(--x, value)` | baseline と一致 |
| CSS-008 | P0 | `!important` | priority 保持 |
| CSS-009 | P0 | equal specificity source order | baseline と一致 |
| CSS-010 | P0 | different specificity | baseline と一致 |
| CSS-011 | P0 | `:where()` zero specificity | baseline と一致 |
| CSS-012 | P0 | CSS layer order | baseline と一致 |
| CSS-013 | P0 | animation property interactions | unsupportedなら residual、誤変換なし |
| CSS-014 | P0 | transition + dynamic variable | interpolation/transition semantics 一致 |
| CSS-015 | P0 | `currentColor` / inheritance-dependent value | baseline と一致 |
| CSS-016 | P0 | invalid-at-computed-value custom property case | browser semantics を変えない |
| CSS-017 | P1 | writing-mode/logical props | baseline と一致 |
| CSS-018 | P1 | direction RTL/LTR | baseline と一致 |

---

## 72. Qwik lifecycle テスト

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| QWK-001 | P0 | SSR initial render | style 欠落なし |
| QWK-002 | P0 | SSG initial render | style 欠落なし |
| QWK-003 | P0 | client-side route navigation | destination style を必要時取得 |
| QWK-004 | P0 | back/forward navigation | style 重複/欠落なし |
| QWK-005 | P0 | conditional lazy component initially absent | 初期 CSS に不要 style を強制しない |
| QWK-006 | P0 | conditional component appears | 必要 style が適用される |
| QWK-007 | P0 | component disappears/reappears | style lifecycle 正常 |
| QWK-008 | P0 | same component repeated | style dependency 重複なし |
| QWK-009 | P0 | nested components sharing atom | CSS重複なし |
| QWK-010 | P0 | `useStyles$` coexistence |既存 style と競合せず semantics 保持 |
| QWK-011 | P0 | `useStylesScoped$` coexistence | scoped semantics 保持 |
| QWK-012 | P0 | scoped class collision across components | leak なし |
| QWK-013 | P0 | resume after SSR | runtime stylesheet engine 不要 |
| QWK-014 | P0 | dynamic signal after resume | custom property のみ更新 |
| QWK-015 | P1 | nested lazy boundaries | ownership/pack 解決正常 |
| QWK-016 | P1 | error boundary / rerender path | style state 破損なし |
| QWK-017 | P1 | streaming SSR が存在する構成 | style ordering を維持 |
| QWK-018 | P0 | production optimizer enabled | dev-only assumption に依存しない |

---

## 73. SSG / route / chunk loading テスト

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| RTE-001 | P0 | route A only style | route B 初期 CSS に混入しない |
| RTE-002 | P0 | shared style A/B | shared pack 化可能 |
| RTE-003 | P0 | route-specific + shared | manifest 正確 |
| RTE-004 | P0 | dynamic route SSG | 各生成 route dependency 正確 |
| RTE-005 | P0 | client-only style | SSG manifest だけを真実として欠落させない |
| RTE-006 | P0 | lazy pack already cached | 再 fetch 不要 |
| RTE-007 | P0 | missing pack on navigation | 1回だけ取得 |
| RTE-008 | P1 | route with no qstyle | 不要 asset link を出さない |
| RTE-009 | P1 | many small atoms | one-atom-one-request を避ける |
| RTE-010 | P1 | large route-specific CSS | max chunk policy 適用 |
| RTE-011 | P0 | chunk load order shuffled | computed style 一致 |
| RTE-012 | P0 | parallel chunk completion order reversed | computed style 一致 |

---

## 74. Dedup / canonicalization テスト

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| DED-001 | P0 | identical declaration same module | 1 semantic atom |
| DED-002 | P0 | identical declaration different modules | 1 semantic atom |
| DED-003 | P0 | object vs template equivalent | 1 semantic atom |
| DED-004 | P0 | whitespace/comments difference | identity 同一 |
| DED-005 | P0 | equivalent canonical color spelling | correctness が証明できる範囲で同一 |
| DED-006 | P0 | context different (`hover` vs base) | 別 identity |
| DED-007 | P0 | media context different | 別 identity |
| DED-008 | P0 | important difference | 別 identity |
| DED-009 | P0 | layer difference | ordering上必要なら別 context |
| DED-010 | P0 | runtime structure same/value different | ParametricAtom 共有 |
| DED-011 | P0 | runtime structure different property | 共有しない |
| DED-012 | P1 | declaration order irrelevantな独立 props | deterministic canonical order |
| DED-013 | P0 | order-sensitive declarations | 誤 canonicalize しない |
| DED-014 | P1 | 10k duplicate occurrences | CSS 出力が occurrence に比例しない |

---

## 75. Determinism / hash / cache stability テスト

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| HASH-001 | P0 | clean build ×2 | byte-for-byte 同一 |
| HASH-002 | P0 | source traversal order randomize | semantic/chunk hash 同一 |
| HASH-003 | P0 | CPU concurrency difference | 出力同一 |
| HASH-004 | P0 | OS path separator abstraction | semantic identity に絶対pathが混入しない |
| HASH-005 | P0 | comment-only change | production CSS hash 不変 |
| HASH-006 | P0 | unrelated component JS change | CSS hash 不変 |
| HASH-007 | P0 | route A local style change | 無関係 route B pack hash 不変 |
| HASH-008 | P0 | shared atom content change | 関係 pack のみ invalidate |
| HASH-009 | P1 | file rename with same semantics | semantic atom ID 安定方針に従う |
| HASH-010 | P1 | formatting/prettier change | CSS asset hash 不変 |
| HASH-011 | P1 | compiler version change | manifest に compiler version 記録 |
| HASH-012 | P0 | content changes | content-addressed asset hash は必ず変わる |

---

## 76. Dev / HMR / incremental build テスト

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| HMR-001 | P1 | static declaration edit | browser に即反映 |
| HMR-002 | P1 | dynamic expression edit | slot 更新 |
| HMR-003 | P1 | selector edit | old rule が残存しない |
| HMR-004 | P1 | handle shared by two components edit | 両利用箇所更新 |
| HMR-005 | P1 | remove style | stale CSS 消失 |
| HMR-006 | P1 | add new component | full restart 不要 |
| HMR-007 | P1 | syntax error → fix | error recovery 正常 |
| HMR-008 | P1 | unrelated JS edit | style graph 全再構築を避ける |
| HMR-009 | P2 | 1000 sequential edits | memory/cache leak なし |
| HMR-010 | P2 | large graph local edit | invalidation scope が局所的 |

---

## 77. Diagnostics / source map テスト

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| DIA-001 | P0 | unsupported dynamic property name | 元TSX行列を示す diagnostic |
| DIA-002 | P0 | unsupported dynamic selector | 理由を明示 |
| DIA-003 | P0 | unsafe shorthand ordering | residual reason を inspector で表示 |
| DIA-004 | P0 | malformed template CSS | 元 template location を表示 |
| DIA-005 | P1 | generated CSS sourcemap | source style へ追跡可能 |
| DIA-006 | P1 | composed handle | provenance が複数 source を保持 |
| DIA-007 | P1 | dedup atom | 全 source origins を確認可能 |
| DIA-008 | P0 | warning/error mode | config 通り severity 切替 |
| DIA-009 | P0 | same warning incremental rebuild | 無限重複表示しない |
| DIA-010 | P1 | production minification | diagnostics source position が維持される |

---

## 78. TypeScript API quality テスト

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| TYP-001 | P0 | valid CSS property | typecheck pass |
| TYP-002 | P0 | misspelled property | typecheck fail |
| TYP-003 | P0 | custom property | typecheck pass |
| TYP-004 | P0 | nested selector key | typecheck pass |
| TYP-005 | P0 | nested at-rule key | typecheck pass |
| TYP-006 | P0 | `css()` object | StyleHandle inference |
| TYP-007 | P0 | `css` tagged template | StyleHandle inference |
| TYP-008 | P0 | css prop handle | JSX typecheck pass |
| TYP-009 | P0 | css prop array/falsy | JSX typecheck pass |
| TYP-010 | P0 | clearly invalid css prop primitive | typecheck fail |
| TYP-011 | P1 | declaration file emit | consumer project で利用可 |
| TYP-012 | P1 | TS strict mode | implicit any 等なし |
| TYP-013 | P1 | monorepo/project references | 型重複や augmentation collision なし |

---

## 79. Security / serialization テスト

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| SEC-001 | P0 | runtime string に `;color:red` | declaration boundary 脱出不可 |
| SEC-002 | P0 | runtime string に `</style>` | stylesheet injection 不可 |
| SEC-003 | P0 | quotes/backslashes/newlines |正しく escape/DOM assignment |
| SEC-004 | P0 | untrusted URL-like value | qstyle が追加の code execution surface を作らない |
| SEC-005 | P0 | generated custom property name | source由来文字列で任意 name injection しない |
| SEC-006 | P1 | strict CSP fixture | incompatibility を silent failure にしない |
| SEC-007 | P1 | nonce environment | legacy/Qwik style と干渉しない |
| SEC-008 | P0 | prototype-like object keys | object traversal で prototype pollution を起こさない |

---

## 80. Failure / fallback テスト

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| FLB-001 | P0 | unknown but valid CSS syntax | residual 可能なら residual |
| FLB-002 | P0 | parser unsupported syntax | diagnostic、誤CSSを出さない |
| FLB-003 | P0 | runtime structure analyzable as inline style only | inline fallback |
| FLB-004 | P0 | runtime selector | error/residual policy、runtime stylesheet生成なし |
| FLB-005 | P0 | runtime property name | error/inline policyを明示 |
| FLB-006 | P0 | plugin transform exception | build fail with actionable message |
| FLB-007 | P0 | corrupt cache | cacheを捨てて正しいrebuild |
| FLB-008 | P1 | unsupported Qwik version | version checkで明示 error |
| FLB-009 | P1 | unsupported Vite version |明示 error |
| FLB-010 | P0 | optimization proof failure | preserve correctness, not best-effort rewrite |

---

## 81. Performance / size 品質テスト

各 benchmark fixture で次を記録する。絶対値だけでなく baseline と差分を保存する。

- total generated CSS bytes: raw / gzip / brotli
- initial route CSS bytes
- route navigation additional CSS bytes
- unused CSS ratio per route
- HTML class bytes
- HTML custom property bytes
- number of CSS/style requests
- number of StyleAtoms / ParametricAtoms / ResidualRules
- dedup ratio
- clean build time
- incremental build time
- HMR latency
- peak RSS

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| PERF-001 | P1 | 100 identical static styles | CSSほぼ1件分 |
| PERF-002 | P1 | 1000 identical static styles | output CSS 線形増加しない |
| PERF-003 | P1 | 1000 dynamic widths | 1 parametric structure + values |
| PERF-004 | P1 | route-local 50KB CSS | unrelated route 初期転送に混入しない |
| PERF-005 | P1 | shared 10KB CSS across routes | cache reuse |
| PERF-006 | P1 | many tiny atoms | request explosion しない |
| PERF-007 | P1 | one component local edit | incremental invalidation 局所化 |
| PERF-008 | P2 | 10k components synthetic | build completes within recorded budget |
| PERF-009 | P2 | 100k style occurrences | memory growthを計測・閾値化 |
| PERF-010 | P1 | parametric promotion overhead | HTML増加を含む total cost で評価 |

初期の数値閾値は feasibility benchmark 後に固定し、以後の regression budget は repository に versioned JSON として保存する。

---

## 82. Browser differential matrix

最低限の対象は、その時点で Qwik が公式に対象とする evergreen browser 群から決める。MVP release candidate では少なくとも Chromium / WebKit / Firefox の現行系を実ブラウザで実行する。

比較方法:

1. baseline fixture: qstyle transform を使わず意味的に同じ CSS を適用
2. optimized fixture: qstyle ON
3. state/pseudo/media/container 条件を操作
4.対象 element の必要 property を `getComputedStyle()` で比較
5. pseudo-element は `getComputedStyle(el, '::before')` 等を利用
6. layout-sensitive fixture は bounding box も比較
7. visual-only差異の可能性がある fixture は screenshot regression を追加

`getComputedStyle()` 全 property の単純文字列比較は browser normalization 差があるため、fixture ごとに観測 property を宣言する。

---

## 83. Property-based / fuzz テスト

P2 として以下を導入する。

### Property-based

- static declaration set の順列を生成し、安全と判定した集合で canonical output が同値
- duplicate style occurrence 数を変えても CSS semantic set が変わらない
- runtime slot の値だけ変えても generated stylesheet bytes が変わらない
- source module traversal order を変えても output hash が変わらない
- composition tree の array nesting を変えても flatten 後順序が同じなら結果同一

### Parser fuzz

- template literal CSS parser
- selector parser
- declaration/value parser
- interpolation boundary
- unicode/escape sequence

不正入力で crash/hang/OOM しないことを検証する。

---

## 84. Regression corpus

発見した bug は必ず最小 fixture に縮小し、ID付き regression test として永久保存する。カテゴリ例:

```text
regressions/
  cascade/
  shorthand/
  scoped/
  composition/
  template/
  dynamic/
  qwik-lifecycle/
  ssg/
  hmr/
  hashing/
  serialization/
```

「修正コードだけ入れて fixture を追加しない」変更は禁止する。

---

## 85. Test fixture 標準形式

各 fixture は可能なら以下を持つ。

```text
fixture-name/
  input/
    src/...
  expected/
    ir.json
    transformed.tsx
    styles.css
    manifest.json
  assertions.ts
  browser.spec.ts
  metadata.json
```

`metadata.json`:

```json
{
  "priority": "P0",
  "features": ["css-prop", "dynamic"],
  "observedProperties": ["width", "color"],
  "requiresBrowser": true
}
```

Golden の更新は明示コマンドに限定し、通常 test run が自動更新してはならない。

---

## 86. MVP completion criterion

MVP 完了は次のすべてを満たした時点とする。

- P0 test が全件 pass
- known correctness failure = 0
- unsupported case はすべて明示 diagnostic / residual / inline fallback のいずれか
- Chromium/WebKit/Firefox differential suite pass
- clean-build determinism suite pass
- SSR/SSG/navigation/lazy/resume suite pass
- dynamic signal update で stylesheet mutation count = 0
- baseline benchmark と比較した size report を CI artifact として生成
- API examples 1〜4 が typecheck + build + browser test を通る
- Tailwind adapter は実装されていないこと（MVP scope creep を防ぐ）


# Part XVIII — 実装計画

## 87. Milestone 0 — Feasibility / mechanical verification

目的:
Qwik v2 / Vite の実際の transform・SSR・SSG・style lifecycle を最小 fixture で確認し、設計上の仮定を固定する。

実装/検証:

- Vite plugin skeleton
- Qwik TSX transform ordering
- JSX `css` prop を plugin が安全に認識・書換可能か
- virtual style module injection
- Qwik `useStyles$` / `useStylesScoped$` coexistence
- SSR / SSG / navigation / lazy component fixture
- source map の変換保持

成功条件:

- `css={{display:'flex'}}` の最小 proof が production build で動く
- Qwik lifecycle を置き換えず style dependency を追加できる
- P0 lifecycle smoke tests の土台が動く

---

## 88. Milestone 1 — Core IR / canonicalization

実装:

- StaticAtom
- RuleContext
- Provenance
- ResidualRuleNode
- declaration/value canonicalization
- deterministic semantic hash
- exact semantic dedup

成功条件:

- OBJ / CSS / DED の static P0 unit tests
- clean-build deterministic IR

---

## 89. Milestone 2 — `css` prop object syntax

実装:

- JSX `css` prop parser/transform
- style object type surface
- property/value lowering
- nested selector / at-rule lowering
- class/style coexistence
- safe residual path

成功条件:

- OBJ-* P0
- SEL-* P0
- TYP-* P0 の object 関連
- browser differential で supported static cases diff = 0

この時点が **MVP Feature 1**。

---

## 90. Milestone 3 — `css()` / composition

実装:

- compile-time StyleHandle
- module provenance
- array/nested-array composition
- falsy elimination
- composition order constraints
- conflict/cascade handling

成功条件:

- CMP-* P0
- shorthand/longhand conflict suite pass
- repeated handle による CSS duplication なし

この時点が **MVP Feature 2**。

---

## 91. Milestone 4 — tagged template literal

実装:

- `css` tagged template parser
- static interpolation
- StyleHandle interpolation
- object/template 共通 canonical IR
- source map

dynamic interpolation は次 milestone の RuntimeSlot に接続する stub まで。

成功条件:

- TPL-* の static P0
- object/template equivalent fixture が dedup

この時点が **MVP Feature 3**。

---

## 92. Milestone 5 — ParametricAtom / dynamic values

実装:

- RuntimeSlot
- ValueTemplate
- CSS Custom Property lowering
- compound runtime value
- finite static conditional classification
- signal/props update binding
- safe inline fallback
- runtime value serialization hardening

成功条件:

- DYN-* P0
- SEC dynamic serialization P0
- 1000 updates で stylesheet/rule count 増加なし
- SSR→resume mismatch なし

この時点が **MVP Feature 4**。

---

## 93. Milestone 6 — Safe global optimization

実装:

- safe declaration atomicization
- ordering constraints
- global semantic dedup
- residual reason diagnostics

成功条件:

- CSS-* / DED-* P0
- unsupported CSS を silent miscompile しない

---

## 94. Milestone 7 — Usage graph / Qwik lifecycle

実装:

- style → component
- component → lazy boundary
- component → route
- SSG dependency extraction

成功条件:

- QWK-* P0
- RTE dependency P0

---

## 95. Milestone 8 — Chunk planner / Qwik-native backend

実装:

- exact usage-set grouping
- deterministic pack creation
- min/max chunk sizing
- Qwik native virtual modules

成功条件:

- one-atom-one-request を回避
- load order differential pass
- route unused CSS を削減

この時点で最初の deployable alpha。

---

## 96. Milestone 9 — Hashed CSS assets / SSG manifest

実装:

- Vite asset emission
- content hashes
- immutable output naming
- Route Style Manifest
- SSG link/preload strategy

成功条件:

- HASH-* P0
- RTE-* P0
- unrelated style change の cache invalidation 局所化

---

## 97. Milestone 10 — Dev/HMR / diagnostics

実装:

- incremental Style IR cache
- HMR invalidation
- stable debug identity
- inspector / residual explanation
- source map polish

成功条件:

- HMR-* P1
- DIA-* P0/P1

---

## 98. Milestone 11 — Quality hardening / release candidate

実装:

- browser matrix
- property-based tests
- fuzzing
- benchmark corpus
- regression budgets
- large fixture

成功条件:

Part XVII の MVP completion criterion を全て満たす。

---

## 99. Post-MVP — Tailwind CSS v4 adapter

MVP release 後に検討する。実装順・仕様は MVP の Style IR が安定してから別設計として確定する。

現時点で保証するのは、frontend adapter が Style IR contribution を渡せる拡張点だけである。MVP milestone、Must-have、P0 test には含めない。


# Part XIX — 優先順位

## 100. MVP Must-have

1. `css` prop object syntax
2. `css()` + composition
3. `css` tagged template literal
4. dynamic value → `ParametricAtom` / CSS Custom Property
5. correctness-preserving Style IR
6. provenance
7. deterministic semantic dedup
8. residual / inline fallback
9. Qwik SSR/SSG/lazy/resume lifecycle compatibility
10. usage graph
11. Qwik-native production backend
12. release-blocking P0 test suite

## 101. MVP Should-have

- route-aware chunking
- raw hashed CSS assets
- cost-based clustering
- inspector
- detailed source maps
- performance budgets

## 102. Post-MVP

- Tailwind CSS v4 adapter
- UnoCSS adapter
- `recipe()`
- `styled()`
- `keyframes()` helper
- `globalCss()` helper
- auto `@property`
- historical change-frequency based chunk planning
- traffic-weighted optimizer
- CSP-specialized runtime variable backend
- cross-project shared content-addressed style registry


# Part XX — リスク

## 103. CSS correctness risk

最大リスク。

対策:

- safe mode default
- residual fallback
- partial ordering
- browser differential tests
- aggressive optimization は opt-in

---

## 104. Qwik build internals dependency

Qwik optimizer/bundler の内部挙動へ過剰依存すると version update で壊れる。

対策:

- public Vite/Qwik integration surface を優先
- version-specific glue を `@qstyle/qwik` に隔離
- core は Qwik 非依存

---

## 105. Future adapter coupling risk

将来 Tailwind 等を追加する際に frontend 固有 semantics が core に漏れると、MVP の安定した IR が壊れる。

対策:

- core は frontend-neutral IR のみ受ける
- adapter interface は最小 contribution protocol に限定
- Tailwind 固有 compiler API は Post-MVP package 内に隔離
- MVP では Tailwind 実装を先取りしない


## 106. HTML bloat

atomic class と runtime custom property により HTML が増える可能性。

対策:

- cost model
- atom promotion threshold
- class short hash
- excessive atomization を避ける

---

## 107. Too many chunks

細粒度 style identity をそのまま asset にすると request explosion。

対策:

- atom/chunk separation
- min chunk size
- usage clustering
- request overhead cost

---

## 108. Cache invalidation amplification

shared chunk に変更頻度の異なる style を混ぜると cache miss が増える。

対策:

- locality-aware chunking
- invalidation penalty
- deterministic stable grouping

---

# Part XXI — 設計上の重要判断

## 109. 「CSS file optimizer」ではなく「Style Graph Compiler」

CSS file 単位では component ownership、route ownership、runtime slot、lazy boundary を表現できない。したがって最初から graph compiler として設計する。

## 110. Authoring syntax と Style IR を分離する

MVP は `css` prop / `css()` / template literal の3つの静的 authoring surface を提供するが、core optimizer はそれらを区別しない。すべて同じ Style IR contribution に lowering する。

これにより object syntax と template literal の同一 declaration を cross-syntax dedup できる。

## 111. Dynamic style は CSS generation ではなく parameter binding

runtime の仕事は style structure を作ることではなく、build-time に確定した style structure の slot に値を入れることとする。

```text
build:   width: var(--q-w)
runtime: --q-w = 320px
```

CSS asset は immutable のまま維持される。

## 112. Composition order は class string order に依存させない

atomic class の DOM 上の順番は CSS cascade の優先順位を保証しない。`css={[a,b]}` の `a < b` は Style IR の ordering constraint として表現し、chunk 分割やキャッシュ状態に関係なく同じ結果を保証する。

## 113. SSG は optimization hint であって唯一の真実ではない

SSG route graph だけに依存すると client-only component が壊れる。static route dependency と lazy component dependency を併存させる。

## 114. Tailwind は Post-MVP adapter

MVP の4機能が frontend-neutral Style IR 上で安定してから、Tailwind CSS v4 等を別 frontend として追加する。MVP の public API、milestone、release gate には含めない。


# Part XXII — MVP の具体的なスコープ

## 115. MVP public authoring examples

### Feature 1 — `css` prop object syntax

```tsx
<div
  css={{
    display: 'flex',
    gap: 8,
    '&:hover': { opacity: 0.8 },
  }}
/>
```

### Feature 2 — `css()` + composition

```tsx
const base = css({ display: 'flex' });
const active = css({ color: 'red' });

<div css={[base, props.active && active]} />
```

### Feature 3 — tagged template literal

```tsx
const card = css`
  display: flex;
  gap: 8px;
`;

<div css={card} />
```

### Feature 4 — dynamic values

```tsx
<div
  css={{
    width: props.width,
    transform: `translateX(${x.value}px)`,
  }}
/>
```

production では shared ParametricAtom + element-local CSS Custom Property へ変換する。

## 116. 明示的に MVP 外

- Tailwind CSS v4 adapter（将来接続可能であることのみ設計に残す）
- `styled()`
- `recipe()`
- dedicated global/keyframes authoring API
- runtime stylesheet injection engine
- utility DSL の互換性層

## 117. MVP release definition

MVP は「4 syntax が demo で動く」時点ではない。Part XVII の P0 release gate と MVP completion criterion を満たし、production Qwik SSG app で deterministic/correct/cacheable output を生成できる時点を MVP release とする。


# Part XXIII — MVP の理想的な利用像

開発者:

```tsx
import { component$ } from '@qwik.dev/core';
import { css } from '@qstyle/qwik';

const base = css({
  display: 'flex',
  gap: 8,
  borderRadius: 8,
});

export const Card = component$((props: {
  width: number;
  accent: string;
  active: boolean;
}) => {
  return (
    <article
      css={[
        base,
        css`
          border-color: ${props.accent};

          &:hover {
            transform: translateY(-1px);
          }
        `,
        {
          width: props.width,
          opacity: props.active ? 1 : 0.6,
        },
      ]}
    >
      ...
    </article>
  );
});
```

compiler 内部:

```text
css prop / css() / template literal
              │
              ▼
          Style Graph
              │
      ┌───────┼────────┐
      │       │        │
   Static   Param    Residual
    Atom     Atom     Rule
      │       │        │
      └───────┼────────┘
              ▼
      semantic dedup
              │
      usage/chunk planning
              │
              ▼
    hashed immutable styles
```

runtime:

```text
Qwik resumes
    │
dynamic value changes
    │
CSS Custom Property value only updates
    │
no stylesheet regeneration / no CSS refetch
```


# 結論

本設計の中心は、以下の4点である。

1. **CSS をファイルではなく semantic graph として扱う。**
2. **style identity と network chunk identity を分離する。**
3. **静的構造と runtime 値を分離し、runtime 値は ParametricAtom の slot として扱う。**
4. **Qwik は lifecycle/backend integration に限定し、authoring syntax 固有の semantics を core optimizer に持ち込まない。**

これにより、

- StyleX 的な全サイト重複排除
- Qwik 的な component/lazy-boundary style loading
- Emotion に近い authoring ergonomics (`css` prop / `css()` / template literal)
- SSG route-level tree-shaking
- hashed immutable caching
- dynamic style reuse
- correctness-preserving residual fallback

を一つのコンパイラアーキテクチャ上で両立できる。

---

# Appendix A — 外部仕様として前提にする事項

設計時点で以下を前提とする。

- Qwik は `useStyles$()` により component が必要とする style を style lifecycle に登録できる。
- Qwik の `useStylesScoped$()` は component 固有の scope を selector に付与する。
- Qwik/Qwik City は SSG により route HTML を build-time に生成できる。
- Vite plugin は virtual module、transform、bundle metadata、asset emission を利用可能。

これらの framework-specific assumption は `@qstyle/qwik` / `@qstyle/vite` に局所化し、`@qstyle/core` の永続的設計前提にしない。

---

# Appendix B — 実装着手時の最初の検証項目

実装開始前に、対象バージョンを固定した fixture repository で以下を機械的に確認する。

1. Qwik の `useStyles$()` / `useStylesScoped$()` の実 build output
2. 同一 style module を複数 component が参照した場合の output
3. SSR / SSG の `<head>` style behavior
4. SPA navigation 後の style acquisition
5. client-only conditional component の style acquisition
6. Vite plugin の Qwik plugin に対する ordering
7. transform 前後で取得可能な Qwik component boundary
8. JSX `css` prop 型拡張と Qwik JSX transform の競合有無
9. tagged template literal transform 後の source map 保持
10. Vite の emitted CSS asset URL resolution
11. asset hash の deterministic behavior
12. runtime CSS Custom Property 更新時の Qwik resume behavior

この検証結果をもって Milestone 0 の design assumptions を更新し、その後に Core IR を固定する。

