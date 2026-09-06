# qstyle

Qwik 向け Style Graph Compiler。`css` prop / `css()` / tagged template で書いたスタイルを build 時に解析し、意味的に同一な宣言の重複排除・route 単位の分割・content-hash 付き immutable asset 化を行う。runtime に CSS パーサやコンパイラは持ち込まない。

> 実装・設計の全文は git history の plan.md (最終版: `e9b6135^`) を参照。
> MVP completion (Release Gate P0 / 旧 §15-16) 達成済み:
> unit 442 + browser 93 (chromium/webkit/firefox) + size-report 7 tests green。

## パッケージ

- `@qstyle/vite` — Vite plugin (transform・asset emission・dev/HMR)
- `@qstyle/qwik` — authoring API (`css` object / tagged template / `StyleHandle`)
- `@qstyle/core` — Style IR・canonicalization・hash・chunk planning (framework 非依存)
- `@qstyle/inspector` — atom/residual/legacy のレポート整形

## セットアップ

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { qstyle } from '@qstyle/vite';

export default defineConfig({
  plugins: [qstyle()],
});
```

```tsx
import { css } from '@qstyle/qwik';
```

### `css` prop の型 (consumer 側設定)

`css` prop を JSX で型付けするには、app 側に 1 ファイル用意する
(.published 版では @qstyle/qwik 側の augmentation で不要になる想定):

```ts
// src/qstyle.d.ts
import type { CssProp } from '@qstyle/qwik';

declare module '@qwik.dev/core/internal' {
  interface HTMLElementAttrs {
    css?: CssProp;
  }
}
```

## 書き方

### `css` prop (object)

```tsx
export const Card = component$((props) => (
  <article
    css={{
      display: 'flex',
      gap: 8,
      width: props.width, // 実行時値 → CSS カスタムプロパティに分離
      '&:hover': { backgroundColor: 'var(--surface-hover)' },
      '@media (width >= 768px)': { padding: 16 },
    }}
  />
));
```

- 数値は unitless 以外 `px` 補完、`0` は単位なし。custom property (`--x`) はそのまま
- `class` / `style` と共存可。既存 `style` には dynamic 値の代入だけ追記される
- ネストキー: `&:hover` (pseudo)、`&--mod` / `&.active` (連結)、`& svg` / `& a b` (子孫)、
  `& > svg` / `& + sib` / `& ~ sib` (combinator)、`&:hover, &:focus` (リスト)、
  `@media` / `@supports` / `@container` / `@layer`。`&` 再出現・`{ } ; < !` 混じりは untouched
- `@keyframes fade` / `@font-face` / `@property --x` は top-level のみ (nested は untouched)。
  keyframes 名は内容 hash (`qkf_xxxxxxxx`) に確定し、同一内容は重複排除される。
  `animation` / `animation-name` の同名参照は同一オブジェクト・同一モジュール内で書換えられる
  (template 内参照は同一リテラル内に co-locate すること。動的値との併用は untouched)

### `@keyframes` の書き方

```tsx
<div
  css={{
    '@keyframes fade': { from: { opacity: 0 }, to: { opacity: 1 } },
    animation: 'fade 1s ease',
  }}
/>
```

```tsx
const spin = css`
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  animation: spin 1s linear infinite;
`;
<div css={spin} />;
```

### `css()` と composition

```tsx
const base = css({ display: 'flex', alignItems: 'center' });
const selected = css({ color: 'red' });

<div css={[base, props.selected && selected]} />
```

- 配列は左→右に合成、同 property は後勝ち。falsy は無視、nested array は flatten
- 同一意味の handle は dedup される
- 条件付き (`cond && handle`、`c ? a : b`) は実行時 class 選択に展開される
- module をまたぐ handle 参照 (`import { base } from './styles'`) は未解決のまま残り、diagnostic が出る

### tagged template literal

```tsx
const card = css`
  display: flex;
  gap: 8px;
`;
<div css={card} />;

// interpolation は runtime slot になる (変数名ではなく構造で共有される)
const dyn = css`
  width: ${w}px;
`;
```

object と template の等価な宣言は同一 atom に dedup される。`css={css`...`}` の直接埋め込みも可。

### 有限状態の分岐は class 選択になる

```tsx
<div css={{ color: active ? 'red' : 'gray' }} />
```

`ParametricAtom` 化せず、静的な複数 atom + 実行時 class 選択になる。任意値 (`props.userColor`) のみ CSS 変数化される。

## オプション

```ts
qstyle({
  optimization: 'safe', // 'preserve' | 'safe' | 'strict'
  backend: 'qwik-native', // | 'css-asset'
  runtimeStyles: {
    strategy: 'custom-property',
    fallback: 'inline',
    promotion: 'cost-based', // 'never' | 'cost-based' | 'always'
  },
  composition: { falsy: 'ignore' },
  chunking: {
    strategy: 'usage-cluster',
    minChunkBytes: 1024,
    maxChunkBytes: 32 * 1024,
  },
  routes: { '/': ['/src/routes/index.tsx'] }, // route manifest 用の逆引き
  diagnostics: 'warning', // 'silent' | 'warning' | 'error'
  debug: false,
});
```

- `preserve`: atomic 化せず宣言順のまま 1 block 化 (Level 0)。順序依存ペアは untouched
- `strict`: 最適化不能箇所を compile error にする (safe は residual/untouched + 警告)
- `promotion: 'never'` は dynamic 値を inline のままにし、`cost-based` (既定) は module 内共有構造のみ class 化する
- `backend: 'css-asset'` (Backend B): 下記「配信 (backend: 'css-asset')」参照。build のみに影響し、dev (serve) は `qwik-native` と同じ per-module CSS + HMR パイプラインのまま

## Virtual modules

- `virtual:qstyle/registry` — 収集済み id→CSS の対応表
- `virtual:qstyle/pack/<id>` — 個別 pack (side-effect import で同梱。qwik-native のみ)
- `virtual:qstyle/manifest` — module→atom の対応表
- `virtual:qstyle/residuals` — 最適化不能理由の一覧 (inspector 表示用)
- `virtual:qstyle/route-loader` — `loadRouteStyles(route)` (css-asset 用)
- `virtual:qstyle/dev/<hash>.css` — serve 時のみ。per-module CSS (Vite CSS HMR 対応)

## 配信 (backend: 'css-asset')

Qwik optimizer は client build で `build.cssCodeSplit = false` を強制するため、
vite/qwik の CSS 配管に乗せた CSS はすべて単一 asset に統合され SSR HTML に
インラインされる。`backend: 'css-asset'` はこの配管に一切乗せず、plugin 自身が
chunk planner の結果 (usage clustering + min/max sizing) に従って
content-hash 付き CSS asset を直接 emit する。chunk 内の宣言 dedup (§39 v1) は
hash 計算前に適用済み。

生成物:

- `dist/assets/qstyle.<hash>.css` — chunk 単位の CSS asset (hash は最終 bytes 由来)
- `dist/qstyle.units.json` — unit id → asset file name の逆引き index
  (`{ "version": 1, "units": { "q_xxxxxxxx": ["assets/qstyle.<hash>.css"] } }`)
- `dist/qstyle.routes.json` — route → 必要 asset file names (`routes` option 未指定時は entries 空)

lazy 読み込み (実装済み): transform が CSS を持つ各 module の先頭に
`import { ensureModuleStyles } from '@qstyle/qwik/client'; ensureModuleStyles([...unitIds])`
を注入する。JS bundle には unit id のみが埋め込まれ (chunk の file name は
transform 時点で確定しないため)、`ensureModuleStyles` が `qstyle.units.json` を
1 回だけ fetch して unit id → file name を解決し、未読の `<link rel="stylesheet">`
を head に追加する (同一 href の二重追加なし、SSR では no-op、fetch 失敗時は
console.error のみで crash しない)。

route 単位の配信 (実装済み): root layout に `<QstyleLinks />` (`@qstyle/qwik/links`) を
置くと、現在 route の assets を `<link rel="stylesheet">` として描画する。

- SSG (build 時の in-process render): plugin が `globalThis.__QSTYLE_ROUTES__` に
  manifest を設定するため、link が静的 HTML に焼かれる
- SSR runtime / client: `useQstyleRouteStyles()` (QstyleLinks が内部で呼ぶ) が
  `qstyle.routes.json` を 1 回 fetch して link を注入。client navigation
  (`useLocation().url.pathname` 変化) ごとに destination route の assets を
  追加で読み込む (二重 fetch・二重 link なし)
- prefetch: `<QstyleLinks prefetch="hover" />` で link hover 時に、`"load"` で
  idle 時に route assets を先読み (default `"none"`)

```tsx
import { QstyleLinks } from '@qstyle/qwik/links';

export default component$(() => (
  <>
    <QstyleLinks prefetch="hover" />
    <Slot />
  </>
));
```

route 単位の低レベル API として `virtual:qstyle/route-loader` の
`loadRouteStyles(route)` も残っている (`qstyle.routes.json` の asset 名解決を利用)。

**hosting 推奨**: asset 名は content hash 付きなので
`Cache-Control: public, max-age=31536000, immutable`
を `assets/qstyle.*.css` に設定すること (`@qstyle/core` の
`IMMUTABLE_CACHE_HEADER` に同値を定義済み)。

**実機検証済み** (Playwright・chromium/webkit/firefox): SSR/SSG link bake・client
navigation・lazy component 直前読み込み・resume・immutable cache hit・load 順逆転
での computed style 一致。`fixtures/lifecycle/e2e/` 参照。
`options.routes` は手動指定 (route path → module paths。`[param]` pattern は
manifest 照合で解決)。

## Inspector

```ts
import { buildAtomReport, formatAtomReport } from '@qstyle/inspector';
import { formatResidualReport, summarizeResiduals } from '@qstyle/inspector';
import { formatLegacyReport } from '@qstyle/inspector';
```

atom の provenance・所属 chunk、residual 理由、`useStyles$()` / `useStylesScoped$()` の利用記録を整形する。legacy hooks 自体は rewrite せず Qwik lifecycle に残す。

## Dev / HMR

serve 時は global dedup・chunking を行わず、module 単位の CSS をそのまま適用する。対象ファイルの変更時は対応する virtual CSS のみ無効化し、無関係ファイルには干渉しない。transform は source map (sourcesContent 付き) を返す。

## 開発

```sh
pnpm -r build
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

### Browser test (fixtures/lifecycle)

```sh
cd fixtures/lifecycle
node scripts/build.mjs                    # optimized build (SSG + SSR server)
pnpm exec playwright test -c e2e/playwright.config.ts        # 24 tests x 3 browsers
pnpm exec playwright test -c e2e/ssg.config.ts               # SSG bake (file assertions)

node scripts/gen-baseline.mjs             # qstyle OFF 等価 app を生成
(cd baseline && QSTYLE_SSG=0 node scripts/build.mjs)
pnpm exec playwright test -c e2e/differential.config.ts      # OFF vs ON 差分
```

baseline 差分は Gate P0.1 (plugin OFF/ON の `getComputedStyle` 一致)。
PERF budget は `benchmarks/budget.json`、実測 record は
`node scripts/size-report.mjs <dist> --out benchmarks/<name>.json`。
