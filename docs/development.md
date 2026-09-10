# 開発

## コマンド

```sh
pnpm -r build        # 全パッケージ build (tsdown)
pnpm -r typecheck    # tsc --noEmit
pnpm -r lint         # tsc --noEmit (型で lint 相当)
pnpm -r test         # vitest run (全パッケージ) + size-report
pnpm -r --parallel dev
```

## unit test

各パッケージの `src/*.test.ts` が vitest で実行される:

```sh
pnpm --filter @qstyle/vite test
```

主なスイート (`packages/vite/src`):

- `index.test.ts` — transform・dev/HMR・generateBundle
- `b2-coverage.test.ts` — transform 挙動・security・determinism 系
- `b2-perf.test.ts` — PERF 回帰 (緩い assert＋計測 log)
- `dev-build-regression.test.ts` — HMR 分岐・configureServer・build 境界の回帰
- `dedup.test.ts` / `m0-proof.test.ts`

## Browser test (fixtures/lifecycle)

```sh
cd fixtures/lifecycle
node scripts/build.mjs                    # optimized build (SSG + SSR server)
pnpm exec playwright test -c e2e/playwright.config.ts        # browser matrix
pnpm exec playwright test -c e2e/ssg.config.ts               # SSG bake (file assertions)

node scripts/gen-baseline.mjs             # qstyle OFF 等価 app を生成
(cd baseline && QSTYLE_SSG=0 node scripts/build.mjs)
pnpm exec playwright test -c e2e/differential.config.ts      # OFF vs ON 差分
```

baseline 差分は plugin OFF/ON の `getComputedStyle` 一致を見る。

## Release fail-closed 挙動 (first release の安全既定)

初回公開リリースに向けて、次の 3 つは黙って成功しない (設計意図。詳細は
[options.md](options.md) / [css.md](css.md)):

1. **hash 衝突**: 異なる入力が同じ生成 id (class / unit / pack / asset fileName /
   keyframes / global id / 生成 slot 変数 / dev key) になった場合、成果物の出力前に
   deterministic error (`StyleCollisionError`) で build が失敗する。同一入力の
   重複は dedupe される。32-bit hash 形式自体は変更していない。
   衝突ペアのテストは birthday search で特定した固定値
   (`packages/vite/src/collision.test.ts`) を使い、確率的探索に依存しない。
2. **custom property 名**: object / template / `@property` / 動的 property key の
   全入力経路が `@qstyle/core` の `isValidCustomPropertyName` (保守的 ASCII grammar
   + `--qstyle` 予約 namespace 拒否) を通る。不正な名前は residual/diagnostic に
   落ち、serialize された CSS には出ない。
3. **untouched css prop**: build 既定の `diagnostics` は `'error'`。dev は
   `'warning'` のまま。`'warning'` / `'silent'` の build 指定は legacy migration
   mode として明示指定のみ残る (style が失われ得る旨を警告)。

fixtures の build が新しい既定で失敗する場合は、fixture 側をサポート済み構文に
直すか、意図的に失敗を残す場合は `diagnostics: 'warning'` を明示しない —
まず分類 (no-op / static fallback / unsupported) を確認すること。

## Benchmark

PERF budget は `benchmarks/budget.json`、実測 record は
`node scripts/size-report.mjs <dist> --out benchmarks/<name>.json` で取る。
