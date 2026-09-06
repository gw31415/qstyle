# dev / HMR・diagnostics・inspector

## dev (serve 時)

global dedup・chunking を行わず、module 単位の CSS をそのまま適用する。
backend (`qwik-native` / `css-asset`) によらず dev パイプラインは同一
(per-module CSS＋HMR)。

- transform 出力の class 名は occurrence 固定の alias (`qd_<file>_<slot>_<n>`)。
  content-hash (`q_...`) のままだと値編集のたび class が変わり、JS 更新が届かない
  SSR-only module の DOM が stale class のまま rule を失うため。
  prod は content-hash のまま。
- 対象ファイルの変更時は対応する virtual CSS (`virtual:qstyle/dev/<hash>.css`) のみ
  無効化し、無関係ファイルには干渉しない。
- HMR 通知の規則: 宣言の増減・値変更だけ (出力不変) なら `<link>` 差し替えの
  `css-update` のみ。出力が変わった場合 (occurrence 構造の変化・css の増減等) は
  DOM 更新が要るため client channel へ `full-reload` も送る。
- transform は source map (sourcesContent 付き) を返す。

## diagnostics

`diagnostics` option (`silent` / `warning` (既定) / `error`) に従う。
`warning` では untouched 箇所を module×理由で session 内1回だけ警告する (DIA-009)。
`optimization: 'strict'` は最適化不能箇所を compile error にする。

最適化不能の理由は `virtual:qstyle/residuals` と `@qstyle/inspector` で確認できる。
理由の一覧は [css.md](css.md#untouched-と-residual)。

## inspector

```ts
import { buildAtomReport, formatAtomReport } from '@qstyle/inspector';
import { formatResidualReport, summarizeResiduals } from '@qstyle/inspector';
import { formatLegacyReport } from '@qstyle/inspector';
```

atom の provenance・所属 chunk、residual 理由、chunk plan レポート
(`buildChunkReport` / `formatChunkReport`)、`useStyles$()` /
`useStylesScoped$()` の利用記録を整形する。

## legacy hooks との共存

`useStyles$()` / `useStylesScoped$()` は rewrite せず Qwik lifecycle に残し、
provenance のみ追跡する (`import X from './y.css?inline'` の default import と
hook の identifier 引数を解決できる範囲で記録する)。
