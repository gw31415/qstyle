# qstyle

Qwik 向け Style Graph Compiler。`css` prop / `css()` / tagged template で書いたスタイルを build 時に解析し、意味的に同一な宣言の重複排除・route 単位の分割・content-hash 付き immutable asset 化を行う。runtime に CSS パーサやコンパイラは持ち込まない。

## パッケージ

- `@qstyle/vite` — Vite plugin (transform・asset emission・dev/HMR)
- `@qstyle/qwik` — authoring API (`css` object / tagged template / `StyleHandle`)
- `@qstyle/core` — Style IR・canonicalization・hash・chunk planning (framework 非依存)
- `@qstyle/inspector` — atom/residual/legacy のレポート整形
- `@qstyle/unocss` — Tailwind 方式 `class` の build 時解決 (UnoCSS parse。optional)

動作環境の詳細は [docs/requirements.md](docs/requirements.md) を参照。

## セットアップ

```sh
pnpm add @qstyle/vite @qstyle/qwik
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { qwikRouter } from '@qwik.dev/router/vite';
import { qwikVite } from '@qwik.dev/core/optimizer';
import { qstyle } from '@qstyle/vite';

export default defineConfig({
  plugins: [
      qwikRouter(),
      qstyle(),      // qstyle は qwikVite より前に置く
      qwikVite(),
  ],
});
```

```tsx
import { css } from '@qstyle/qwik';
```

### Tailwind 方式 `class` の置換 (optional)

`@qstyle/unocss` が自前の Vite plugin (`UnoCSS()`) を出す。
引数は `@unocss/vite` と同じ物を受け付けるため、関数入替えだけで使える。
`qstyle()` より前に置くと、`class` ユーティリティを `css` prop へ翻訳し、
qstyle 本体の配管 (dev/HMR・chunk・asset) に載せる。`@unocss/vite` は不要。
qstyle 本体はこの plugin の存在を知らない。

```sh
pnpm add @qstyle/unocss
```

```ts
// vite.config.ts — UnoCSS() を入れ替えるだけ。引数は同じ。default import も同じ形
import UnoCSS from '@qstyle/unocss';
import presetWind4 from '@unocss/preset-wind4';
// import UnoCSS from '@unocss/vite';
plugins: [qwikRouter(), UnoCSS({ presets: [presetWind4()] }), qstyle(), qwikVite()],
```

```tsx
<div class="flex gap-4 hover:bg-red-500" />
// ↓ build/dev とも等価
<div css={{ display: 'flex', gap: 'calc(var(--spacing) * 4)', '&:hover': { ... } }} />
```

既定 (削減モード) では解決した utility 名を転送物から消す
(静的 class は `css` へ、動的 class・verbatim 級は短縮 alias `qu_<hash>` へ)。
実行時に class 名を参照するコードとの非互換はルールとして許容する。
従来通り class を残す互換モードは `UnoCSS({ preserveClass: true })`。

詳細は [docs/unocss.md](docs/unocss.md)。

### `css` prop の型 (consumer 側設定)

`css` prop を JSX で型付けするには、app 側に 1 ファイル用意する:

```ts
// src/qstyle.d.ts
import type { CssProp } from '@qstyle/qwik';

declare module '@qwik.dev/core/internal' {
  interface HTMLElementAttrs {
    css?: CssProp;
  }
  interface SVGAttributes<T extends Element = Element> {
    css?: CssProp;
  }
}
```

transform はタグ非依存のため、型さえ通れば HTML / SVG いずれの要素でも使える。

## クイックスタート

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

## 使い方

### `css()` と composition

```tsx
const base = css({ display: 'flex', alignItems: 'center' });
const selected = css({ color: 'red' });

<div css={[base, props.selected && selected]} />
```

配列は左→右に合成し、同 property は後勝ち。falsy は無視される。
条件付き (`cond && handle`、`c ? a : b`) は実行時 class 選択に展開される。

### tagged template literal

```tsx
const card = css`
  display: flex;
  gap: 8px;
`;
<div css={card} />;

// interpolation は runtime slot になる
const dyn = css`
  width: ${w}px;
`;
```

object と template の等価な宣言は同一 atom に重複排除される。

### `@keyframes`

```tsx
<div
  css={{
    '@keyframes fade': { from: { opacity: 0 }, to: { opacity: 1 } },
    animation: 'fade 1s ease',
  }}
/>
```

keyframes 名は内容 hash (`qkf_xxxxxxxx`) に確定し、同一内容は重複排除される。
`animation` / `animation-name` の同名参照は同一オブジェクト・同一モジュール内で書き換えられる。

### 有限状態の分岐は class 選択になる

```tsx
<div css={{ color: active ? 'red' : 'gray' }} />
```

静的な複数 atom + 実行時 class 選択になる。任意値 (`props.userColor`) のみ CSS 変数化される。

## ドキュメント

- [docs/requirements.md](docs/requirements.md) — 動作環境・インストール・対応バージョン
- [docs/css.md](docs/css.md) — 書ける CSS の範囲とサポート境界 (値・ネスト・keyframes・動的値・composition・untouched 条件)
- [docs/options.md](docs/options.md) — plugin オプションリファレンス
- [docs/delivery.md](docs/delivery.md) — backend・virtual modules・route 単位配信・hosting
- [docs/dev.md](docs/dev.md) — dev/HMR の動作・diagnostics・inspector・legacy hooks
- [docs/development.md](docs/development.md) — 開発コマンド・テスト・browser test・benchmark

## 開発

```sh
pnpm -r build
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```
