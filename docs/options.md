# Plugin オプションリファレンス

```ts
qstyle({
  optimization: 'safe',
  backend: 'css-asset',
  runtimeStyles: {
    strategy: 'custom-property',
    fallback: 'inline',
    promotion: 'always',
  },
  composition: { falsy: 'ignore' },
  chunking: {
    strategy: 'usage-cluster',
    minChunkBytes: 1024,
    maxChunkBytes: 32 * 1024,
    similarityThreshold: 0.3,
    requestOverheadBytes: 512,
  },
  routes: 'auto',
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

## `backend`: `'qwik-native'` | `'css-asset'` (既定)

- `'qwik-native'`: module 単位の pack CSS を Vite/Qwik の CSS 配管に乗せる。
- `'css-asset'` (既定): plugin 自身が chunk 単位の content-hash 付き CSS asset を直接 emit する。
  読み込み速度・キャッシュ優先のため既定。route 単位分割 + immutable asset になる。
  build のみに影響し、dev (serve) は `qwik-native` と同じ per-module CSS＋HMR のまま。
  詳細は [delivery.md](delivery.md)。

## `runtimeStyles`

- `strategy: 'custom-property'` (固定): 動的値は CSS カスタムプロパティに分離する。
- `fallback: 'inline'` (固定): 非 promote 値は `style` に inline で残す。
- `promotion: 'never'` | `'cost-based'` | `'always'` (既定):
  `'never'` は動的値を常に inline のままにし、`'cost-based'` は module 内で共有される
  構造のみ class 化し、`'always'` (既定) は常に class 化する。既定 `always` は動的値も
  確定 class + content-hash asset に寄せ、HTML 肥大化を抑えキャッシュヒット率を上げる。

## `composition`

- `falsy: 'ignore'` (固定): 配列内の falsy は無視する。

## `chunking`

`css-asset` backend の chunk 分割と、`qwik-native` の chunk plan 記録に使う。

- `strategy: 'usage-cluster'` (固定): usage graph の類似度で clustering する。
- `minChunkBytes` (既定 1024) / `maxChunkBytes` (既定 32768): chunk の byte 上下限。
- `similarityThreshold` (既定 0.3): merge を許す最小 jaccard similarity。
- `requestOverheadBytes` (既定 512): 1 request の等価 overhead bytes。

## `routes`

route path → その route が描画する module path の list、または `'auto'` (既定)。
未指定/`'auto'` 時は `<root>/src/routes` を走査して自動検出する
(Qwik City 規約。`src/routes/about/index.tsx` と同 dir の co-located file → `/about`)。
さらに build 時の module graph を辿り、各 entry から import 連鎖で到達する
component (static/dynamic 不問) をその route に含める。手動指定時は連鎖展開せず
指定のまま使う。root 不明・dir 不在時は entries 空。
`[param]` 形式の pattern は manifest 照合で解決される。

```ts
routes: 'auto', // 既定
routes: { '/': ['/src/routes/index.tsx'] }, // 手動上書き
```

## `diagnostics`: `'silent'` | `'warning'` (既定) | `'error'`

- `'silent'`: 何も出さない。
- `'warning'` (既定): untouched 箇所を module×理由で session 内1回だけ警告する。
- `'error'`: untouched 箇所で即 throw する。

## `debug`

`true` で plugin 内部 log (収集・chunk plan レポート等) を出す。
