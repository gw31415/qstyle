# 動作環境・インストール

## 動作環境

- Node.js `>=22.13`
- pnpm `>=12` (repo は `pnpm@12.2.1` で管理)
- TypeScript: 各パッケージは `tsdown` で build、型チェックは `tsc --noEmit`

## 対応バージョン (peer dependencies)

| peer | 要件 | 備考 |
| --- | --- | --- |
| `@qwik.dev/core` | `^2.0.0-beta.43` (major 2) | `@qstyle/vite`・`@qstyle/qwik` が要求。範囲外は diagnostics に従い警告/throw (黙って通さない) |
| `@qwik.dev/router` | `^2.0.0-beta.43` (major 2) | `@qstyle/qwik` が要求 (`QstyleLinks` 等の route 連携用) |
| `vite` | `^8.0.0` (major 8) | `@qstyle/vite` が要求 |

## インストール

```sh
pnpm add @qstyle/vite @qstyle/qwik
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { qstyle } from '@qstyle/vite';

export default defineConfig({
  plugins: [qstyle()],
});
```

`css` prop の型付けは app 側に `src/qstyle.d.ts` を 1 ファイル用意する
(詳細は [README](../README.md#css-prop-の型-consumer-側設定)):

```ts
import type { CssProp } from '@qstyle/qwik';

declare module '@qwik.dev/core/internal' {
  interface HTMLElementAttrs {
    css?: CssProp;
  }
  // SVG 要素 (`<svg>` / `<path>` 等) は HTMLElementAttrs を経由しないため別途必要。
  interface SVGAttributes<T extends Element = Element> {
    css?: CssProp;
  }
}
```
