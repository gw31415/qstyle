# qstyle

Qwik 向け Style Graph Compiler。`css` prop / `css()` / tagged template で書いたスタイルを build 時に解析し、意味的に同一な宣言の重複排除・route 単位の分割・content-hash 付き immutable asset 化を行う。runtime に CSS パーサやコンパイラは持ち込まない。

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
- ネストキー: `&:hover` (pseudo)、`& svg` / `& .tile` (子孫セレクタ, 単純セレクタのみ)、
  `@media` / `@supports` / `@container`。それ以外の selector は untouched (黙って書き換えない)

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

route 単位の読み込みは別経路として `virtual:qstyle/route-loader` の
`loadRouteStyles(route)` が残っている (`qstyle.routes.json` の asset 名解決を利用)。

**hosting 推奨**: asset 名は content hash 付きなので
`Cache-Control: public, max-age=31536000, immutable`
を `assets/qstyle.*.css` に設定すること (`@qstyle/core` の
`IMMUTABLE_CACHE_HEADER` に同値を定義済み)。

**未実装** (plan.md R1.4/R1.5): SSR/SSG 向けの `<QstyleLinks />` head link 注入と
client navigation での自動 route style 取得は未実装。初期表示の head link は
現在のところ `ensureModuleStyles` (module 評価時) または `loadRouteStyles` の
手動呼び出しで賄う。

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
