# qstyle 残作業 (完了したらこのファイルを削除する)

実装済みの経緯・設計詳細は git history (`58caa96` 以前の plan.md) と README 参照。
現状: 348 test green / Backend B R1.1〜R1.7 実装済み / route 分離 chunk 実証済み。

## A. 配信基盤の仕上げ

- **R1.8** inspector に backend 種別 + chunk plan (members × bytes × fileName × 分類) の report 表示 (`__chunkPlans` getter はある)
- **R1.9** haven-web で `backend: 'css-asset'` + `routes` + `<QstyleLinks />` を有効化し、初期 HTML bytes / 初期 CSS bytes / navigation 追加 / リロード時 cache hit を測定 (= PERF-004/005)
- **R2 残** manifest に chunk 分類 (route-local / shared) を記録
- **R3 clustering v2** `ChunkOptions` に `similarityThreshold` (default 0.3) / `requestOverheadBytes`、module locality を proxy とした invalidation penalty。route-local が shared に merge されて RTE-001 違反にならないこと (CHUNK 拡張で固定)

## B. テスト完成

### B-1 browser 実機検証 (C0 基盤 → QWK/RTE/DYN)

lifecycle fixture (qwik city・3 route・lazy component・dynamic signal・baseline 版 generator) + Playwright (chromium 優先)。

- QWK-001 SSR / 002 SSG (link bake) / 003 nav / 004 back-forward / 005 lazy 初期不在 / 006 出現 / 007 再出現 / 008 繰返し / 009 nested 共有 / 010 useStyles$ 共存 / 011 scoped 共存 / 012 scoped 衝突 / 013 resume / 014 resume 後 signal / 015 nested lazy / 016 error recovery / 017 streaming SSR 順序 / 018 production build のみ
- RTE-004 dynamic route SSG / 005 client-only / 006 cached 再 fetch なし / 007 missing 1 回 fetch / 009 many atoms request 抑制 / 010 max chunk policy / 011 load order shuffled / 012 完了順逆転 — いずれも computed style 一致
- DYN-012/013 signal update で stylesheet 追加なし / 014 SSR 初期値 / 015 resume 同値 / 021 pointer 高頻度更新
- FOUC 判定 (prefetch on/off)

### B-2 unit 系残り (vite transform level)

OBJ-019/020/021, SEL-004..007/017/018 (residual・OFF/ON 等価), CMP-006/016/018, TPL-016/018, DYN-009/011/018/022/023, CSS-004/005/011/012/014..018 (serialize 層。computed は B-3), SEC-001..004 (境界脱出), FLB-001..005/008/009 (version guard 含む), HASH-009/010, DED-005/009/010/012/014, DIA-001/002/004/005/006/007/009/010, TYP-001..013 (type harness)

### B-3 browser differential matrix (§11)

baseline (qstyle OFF) / optimized (ON) の同一 app を 3 browser (chromium / webkit / firefox) で `getComputedStyle` 比較 + layout は bounding box + screenshot regression。B-1 の fixture を流用。

### B-4 PERF / size report / fuzz

- PERF-002/003 (1000 件線形性) / 007 (局所 invalidation) / 008/009 (10k/100k 合成) / 010 (promotion cost)
- size-report script (`benchmarks/` に versioned JSON) — total/initial/nav CSS bytes, unused ratio, request 数, build time
- property-based + parser fuzz (fast-check): 順列不変・occurrence 不変・slot 値不変・traversal 順不変・crash/hang なし

## C. 完了条件

Release Gate P0 (旧 §15) 全項目 + 旧 §16 MVP completion criterion を満たしたら **このファイルを削除** し、README に 1 行 (設計全文は git history) を残す。CI が無いため size report の CI artifact 化は「script で再現可能」をもって代替とする。
