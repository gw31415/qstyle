# Plugin オプションリファレンス

```ts
qstyle({
  optimization: 'safe',
  backend: 'qwik-native',
  runtimeStyles: {
    strategy: 'custom-property',
    fallback: 'inline',
    promotion: 'cost-based',
  },
  composition: { falsy: 'ignore' },
  chunking: {
    strategy: 'usage-cluster',
    minChunkBytes: 1024,
    maxChunkBytes: 32 * 1024,
    similarityThreshold: 0.3,
    requestOverheadBytes: 512,
  },
  routes: { '/': ['/src/routes/index.tsx'] },
  diagnostics: 'warning',
  debug: false,
});
```

上は全既定値。不明な値 (例: `optimization: 'bogus'`) は build 失敗させる。

## `optimization`: `'preserve'` | `'safe'` (既定) | `'strict'`

- `'preserve'`: atomic 化せず宣言順のまま occurrence 単位で 1 block 化する。
  順序依存ペア (shorthand/longhand 等) は untouched になる。
- `'safe'` (既定): 最適化不能箇所は residual/untouched に落とし、`diagnostics` に従い警告する。
- `'strict'`: 最適化不能箇所を compile error にする。

## `backend`: `'qwik-native'` (既定) | `'css-asset'`

- `'qwik-native'`: module 単位の pack CSS を Vite/Qwik の CSS 配管に乗せる。
- `'css-asset'`: plugin 自身が chunk 単位の content-hash 付き CSS asset を直接 emit する。
  build のみに影響し、dev (serve) は `qwik-native` と同じ per-module CSS＋HMR のまま。
  詳細は [delivery.md](delivery.md)。

## `runtimeStyles`

- `strategy: 'custom-property'` (固定): 動的値は CSS カスタムプロパティに分離する。
- `fallback: 'inline'` (固定): 非 promote 値は `style` に inline で残す。
- `promotion: 'never'` | `'cost-based'` (既定) | `'always'`:
  `'never'` は動的値を常に inline のままにし、`'cost-based'` は module 内で共有される
  構造のみ class 化し、`'always'` は常に class 化する。

## `composition`

- `falsy: 'ignore'` (固定): 配列内の falsy は無視する。

## `chunking`

`css-asset` backend の chunk 分割と、`qwik-native` の chunk plan 記録に使う。

- `strategy: 'usage-cluster'` (固定): usage graph の類似度で clustering する。
- `minChunkBytes` (既定 1024) / `maxChunkBytes` (既定 32768): chunk の byte 上下限。
- `similarityThreshold` (既定 0.3): merge を許す最小 jaccard similarity。
- `requestOverheadBytes` (既定 512): 1 request の等価 overhead bytes。

## `routes`

route path → その route が描画する module path の list。route manifest
(`qstyle.routes.json`) の逆引き元。未指定時は entries 空。
`[param]` 形式の pattern は manifest 照合で解決される。

```ts
routes: { '/': ['/src/routes/index.tsx'] }
```

## `diagnostics`: `'silent'` | `'warning'` (既定) | `'error'`

- `'silent'`: 何も出さない。
- `'warning'` (既定): untouched 箇所を module×理由で session 内1回だけ警告する。
- `'error'`: untouched 箇所で即 throw する。

## `debug`

`true` で plugin 内部 log (収集・chunk plan レポート等) を出す。
