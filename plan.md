# qstyle 残作業 (完了したらこのファイルを削除する)

実装済みの経緯・設計詳細は git history (`58caa96` 以前の plan.md) と README 参照。
現状: 434 test green (unit 424 + size-report 7 + e2e C0 3) / Backend B R1.1〜R1.9 実装済み。

## A. 配信基盤の仕上げ

- **R1.8 済** inspector に backend 種別 + chunk plan の report 表示
  (`buildChunkReport`/`formatChunkReport` + css-asset generateBundle の debug log 配線)
- **R1.9 済** haven-web で `backend: 'css-asset'` + `routes` + `<QstyleLinks />` 有効化済み。
  静的部分は測定済み (`benchmarks/haven-web-2026-09-06.json`: chunk 4 件 349B、route 初期 2 requests ~220B、
  shared chunk 1 件が全 route で共有、`/assets/*` immutable header 済み)。
  runtime (初期 HTML bytes / navigation 追加 / リロード時 cache hit) は C0.1〜C0.3 で実証済み
  (PERF-004/005 相当。lifecycle fixture + Playwright)
- **R2 済** manifest に chunk 分類 (route-local / shared) を記録 (`classifyChunkUnits`、両 backend の chunkPlans)
- **R3 済** `ChunkOptions` に `similarityThreshold` (default 0.3) / `requestOverheadBytes` (default 512)。
  CHUNK-007/008/009 で固定 (route-local の shared への merge 拒否 / threshold 0 で v1 互換 / cost で通過)

## B. テスト完成

### B-1 browser 実機検証 (C0 基盤 → QWK/RTE/DYN)

lifecycle fixture (`fixtures/lifecycle`: qwik city・3 route・lazy・dynamic signal・legacy hooks)
+ Playwright (chromium)。実行: base build → adapter build (`scripts/build.mjs`) →
`pnpm exec playwright test -c fixtures/lifecycle/e2e/playwright.config.ts`。

- **C0 済** (e2e/c0-smoke.spec.ts 3 件): C0.1 SSR (q_ class + seagreen + prefetch marker) /
  C0.2 client nav (about の route-local chunk 追加・重複なし・darkmagenta) /
  C0.3 reload (transferSize 0 の immutable cache-hit + style 維持)
- C0 基盤整備で直した fixture/library 側の実バグ (いずれも E2E が検出):
  - layout に `<Slot />` が無く route 内容が q:template に残り adopt されない
  - Qwik City 規約 (`about/index.tsx` 形) に反する flat route は router に認識されない。
    同名 basename の区別のため vite 側 `moduleKey` を root 相対化 + suffix 照合 (`R2` test 追加)
  - 未 optimizer ライブラリの QRL は SSR/SSG で Q14 になる。`links` dist を
    `.qwik.mjs` 化し、app build の optimizer に manifest 登録させる (router と同方式)。
    client task は `_qrlSync` 自己完結 bootstrap (`qstyleRouteBootstrap` + source-lint test)
  - client nav で Qwik の head 差分が SSR 焼き link を剥がす → client render で
    `data-qstyle-vdom` 付き link を描き直して維持 (orphan と区別して重複防止)。
    bootstrap の manifest 解決は marker の `data-qstyle-base` を使う (nested route 対応)
  - adapter build の client 成果物を dist/ に寄せて server bundle と chunk 名を一致させる
- QWK-002 SSG (link bake): SSG render 自体は成功する (Q14 解消後) が、SSG worker が
  child process のため in-process の manifest が届かず link 焼き込みは未検証。
  `entry.ssr.tsx` の復元機構 + `QSTYLE_ROUTES_JSON` env 受け渡しの配線は済み。要 bake 検証
- 残りの matrix (C0 基盤の上に増やす):
  - QWK-004 back-forward / 005 lazy 初期不在 / 006 出現 / 007 再出現 / 008 繰返し / 009 nested 共有 / 010 useStyles$ 共存 / 011 scoped 共存 / 012 scoped 衝突 / 013 resume / 014 resume 後 signal / 015 nested lazy / 016 error recovery / 017 streaming SSR 順序 / 018 production build のみ (001/003 は C0 で実証済み)
  - RTE-004 dynamic route SSG / 005 client-only / 006 cached 再 fetch なし / 007 missing 1 回 fetch / 009 many atoms request 抑制 / 010 max chunk policy / 011 load order shuffled / 012 完了順逆転 — いずれも computed style 一致
  - DYN-012/013 signal update で stylesheet 追加なし / 014 SSR 初期値 / 015 resume 同値 / 021 pointer 高頻度更新
  - FOUC 判定 (prefetch on/off)

### B-2 unit 系残り (vite transform level)

vite transform level は済 (`b2-coverage.test.ts` 35 件。現行挙動と異なるものは「現状固定」として header に列挙)。
残りは core/qwik 側の unit (OBJ-019/020/021, SEL-004..007/017/018, CMP-006/016/018, TPL-016/018, DYN-009/011/018/022/023, CSS-004/005/011/012/014..018, SEC-001..004, FLB-001..005/008/009, HASH-009/010, DED-005/009/010/012, DIA-001/002/004/005/006/007/009/010, TYP-001..013)。

### B-3 browser differential matrix (§11)

baseline (qstyle OFF) / optimized (ON) の同一 app を 3 browser (chromium / webkit / firefox) で `getComputedStyle` 比較 + layout は bounding box + screenshot regression。B-1 の fixture を流用。

### B-4 PERF / size report / fuzz

- PERF-002/003/007/008/009/010 + DED-014 は vite transform level で済 (`b2-perf.test.ts` 7 件)。
  ついでに transform の O(n^2) (occurrence 毎の `lineStarts` 全走査) を修正し線形化 (10k で 16s → 0.1s)
- size-report script (`scripts/size-report.mjs` + `size-report.test.mjs` 7 件、root `pnpm test` に配線済み) — `benchmarks/` への versioned JSON 記録は未
- property-based + parser fuzz (fast-check): core `property.test.ts` + qwik `fuzz.test.ts` で green (vitest run に含まれる)

## C. 完了条件

Release Gate P0 (旧 §15) 全項目 + 旧 §16 MVP completion criterion を満たしたら **このファイルを削除** し、README に 1 行 (設計全文は git history) を残す。CI が無いため size report の CI artifact 化は「script で再現可能」をもって代替とする。
