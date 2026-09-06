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

- `index.test.ts` — transform・dev/HMR・generateBundle・css-asset backend
- `b2-coverage.test.ts` — transform 挙動・security・determinism 系
- `b2-perf.test.ts` — PERF 回帰 (緩い assert＋計測 log)
- `dev-build-regression.test.ts` — HMR 分岐・configureServer・build 境界の回帰
- `dedup.test.ts` / `m0-proof.test.ts` / `route-asset-proof.test.ts`

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

## Benchmark

PERF budget は `benchmarks/budget.json`、実測 record は
`node scripts/size-report.mjs <dist> --out benchmarks/<name>.json` で取る。
