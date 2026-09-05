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
- 安全に atomize できない selector・値は untouched (黙って書き換えない)

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
- `backend: 'css-asset'` では hashed CSS + `qstyle.routes.json` を emit し、`virtual:qstyle/route-loader` の `loadRouteStyles(route)` で route 単位に `<link>` 注入できる

## Virtual modules

- `virtual:qstyle/registry` — 収集済み id→CSS の対応表
- `virtual:qstyle/pack/<id>` — 個別 pack (side-effect import で同梱)
- `virtual:qstyle/manifest` — module→atom の対応表
- `virtual:qstyle/residuals` — 最適化不能理由の一覧 (inspector 表示用)
- `virtual:qstyle/route-loader` — `loadRouteStyles(route)` (css-asset 用)
- `virtual:qstyle/dev/<hash>.css` — serve 時のみ。per-module CSS (Vite CSS HMR 対応)

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
