# Qwik Style Graph Compiler — 残作業計画

**Status:** Implementation in progress (M0–M5+α 完了、本書は未実装分の実装計画)  
**Target:** Qwik v2 + VITE+ (vite-plus)  
**Document type:** Remaining Work Plan (Detailed)  
**Naming:** `@qstyle/*` は説明用の仮称であり、正式パッケージ名ではない。

本書は 2026-09-06 時点の実装状況を反映し、**未実装の作業のみ**を実装可能な詳細度で記述する。
実装済み機能の設計・API 詳細は README と git log を参照。旧設計書の全文は git history (`bdbf00a` 以前の plan.md) から復元できる。

記載している関数名・行番号は現行実装 (`packages/` @ 未コミット状態) に基づく。実装の進行とともにずれるため、着手時に最新コードと突き合わせること。

---

## 目次

1. 目的・現状
- **Part A 配信基盤**: R1 Backend B / R2 chunking 実配線 / R3 clustering v2
- **Part B 機能残件**: R4 構文対応・品質
- **Part C テスト完成**: C0 テスト基盤 → unit 系不足分 → QWK → RTE → browser differential → PERF → fuzz
- **Part D 品質定義**: Release Gate / MVP completion criterion
- **Part E 優先順位・依存・リスク・判断事項・Post-MVP**

---

## 1. 目的 (変更なし)

Qwik の style 遅延ロード性を維持しつつ、サイト全体で CSS を解析・再構成し、

1. 意味的に同一な宣言の重複排除
2. ルート・遅延境界ごとの利用実態に基づく CSS chunk 構成
3. **初期表示で不要な CSS を配信しない**
4. content hash 付き immutable asset による長期キャッシュ
5. cascade / specificity / shorthand / source order の意味論を壊さない (correctness first)
6. 証明できないものは residual / untouched に回し silent failure にしない

**転送量・未使用 CSS・request 数・キャッシュ局所性・HTML 増加・resumability を含む総コストの最小化**が目的。非目標も変更なし。

---

## 2. 現在の実装状態 (要約・シンボル付き)

| 領域 | 状態 | 主シンボル |
|---|---|---|
| 4 パッケージ | 実装済み | `core` `qwik` `vite` `inspector` |
| authoring API 4 種 | 実装済み | `lowerStyleObject` / `lowerTaggedTemplate` / `composeCssProp` (`@qstyle/qwik`) |
| Style IR / hash | 実装済み | `createStaticAtom` `hashStaticAtom` (`core/atom.ts`) |
| semantic dedup | 実装済み | `core/dedup.ts` |
| safety analysis | 実装済み (実アプリ総合検証は未) | `core/safety.ts` |
| usage graph | 実装済み | `createUsageGraph` `recordUsage` `recordSource` `recordComponentRoute` `usageSignature` `jaccardSimilarity` (`core/usage.ts`) |
| chunk planner | 実装済み・asset 化済み (R1.2) | `planChunks` `chunkHash` `assetFileName` (`core/chunk.ts`)。**ただし usage graph との id 不整合あり (§4.1)** |
| Backend B (css-asset) | **R1.1–R1.3, R1.6 実装済み** | `qstyle:css-asset` plugin (`assets/qstyle.<hash>.css` + `qstyle.units.json` + `qstyle.routes.json` の asset 名解決)、transform の unit stub 注入、`@qstyle/qwik/client` `ensureModuleStyles`。R1.4/1.5/1.7/1.8/1.9 は未 |
| route manifest | 雛形 emit のみ | `buildRouteManifest` `serializeManifest` `resolveRouteAssets` `parseManifest` (`core/manifest.ts`)。`routes` option 未設定だと entries 空 |
| route-loader | 実装済み・未使用 | `ROUTE_LOADER_SOURCE` (`loadRouteStyles`) |
| transform / pack | 実装済み | `virtual:qstyle/pack/<id>.css`、`ingestUnit` `serializeUnitCss` `unitIdOf` |
| §39 dedup v1 | 実装済み | `vite/dedup.ts` `groupDuplicateCss` (post plugin `qstyle:dedup`) |
| dev per-module CSS | 実装済み | `devCss` `devKeys` + `configureServer` middleware + `handleHotUpdate` |
| determinism suite | 実装済み | HASH-001..006, 011, 012 |
| haven-web 統合 | 部分的 | icon / status-dot / terminal-chrome / settings-page を css prop 化 |

テスト **316 件 green** (core 111 / qwik 88 / inspector 8 / vite 109)。unit 系の P0 ギャップは大幅に埋まった (§7 参照)。lifecycle (QWK) / route (RTE) / browser 系は依然未実装。

---

# Part A — 配信基盤の完成

## 3. R1: Backend B (css-asset) の実装

最重要課題。**R1.1〜R1.3 + R1.6 は実装済み** (後述)。残りは R1.4/1.5/1.7/1.8/1.9。

### 3.1 背景・制約

- Qwik optimizer は client build で `build.cssCodeSplit = false` を無条件設定 (`@qwik.dev/core/dist/optimizer.mjs:2720`)。vite/qwik の CSS 配管に乗った CSS はすべて単一 asset に統合され SSR HTML head にインラインされる。
- **アーキテクチャ決定 (実装済み)**: Backend B は vite/qwik の CSS バンドル配管に一切乗せず、plugin 自身が `generateBundle` で `this.emitFile({type:'asset'})` により直接出す。JS 側に CSS import が存在しないため `cssCodeSplit` と無関係で、chunk 粒度・dedup 適用 (hash 計算前)・file name を完全制御できる。

### 3.2 実装済みの構成 (R1.1〜R1.3 + R1.6)

- transform (build & `backend: 'css-asset'`): pack css import の代わりに module 先頭へ
  `import { ensureModuleStyles } from '@qstyle/qwik/client'; ensureModuleStyles([...unitIds]);` を注入 (unit id は transform 時点で確定。fileName の遅延バインディングは不要にした — JS bundle hash 完全性を保つため JS への後付け編集は行わない)
- `qstyle:css-asset` plugin (`enforce: 'post'`, `apply: 'build'`, 戻り配列の第 3 要素):
  `buildCssAssetPlan()` = `planChunks(graph, styles, opts)` → chunk の cssText join → `groupDuplicateCss` (chunk 内) → `chunkHash` → `assets/qstyle.<hash>.css` を emit
- `qstyle.units.json` (`{version:1, units:{unitId:[fileName]}}`): unit id → fileName の実行時解決用。client helper が 1 回だけ fetch して cache
- `qstyle.routes.json`: `options.routes` → modules → units → chunk fileName に解決 (qwik-native は従来どおり unit id ベース)
- `qstyle:dedup` に `assets/qstyle.*.css` の skip ガード (hash 計算後の再編集防止)
- `@qstyle/qwik/client` (`ensureModuleStyles`): SSR no-op、fetch 1 回 cache、`data-qstyle-href` + inflight map で二重 link 防止。exports `./client` 追加
- fixture: `fixtures/m0-css-asset/` (実 vite build で asset 出力・JS 非混入・units/routes.json 一致を検証)
- テスト: client 6 + vite plugin 7 + m0-proof 1 = 14 件追加
- README: css-asset の節を実装に合わせ書き直し、immutable cache header 推奨を追記

### 3.3 残ステップ

#### R1.4 SSR/SSG head link 注入 — `<QstyleLinks />` (M〜L) ← 次の作業

- 対象: `packages/qwik/src/` (新規 `links.tsx`)、`packages/vite/src/index.ts` (`virtual:qstyle/routes` の load)
- 変更:
  - vite 側: `load('virtual:qstyle/routes')` で `export const routes = {...manifest JSON...}` を返す (build 時に manifest から生成。dev では空)
  - qwik 側: `QstyleLinks` component が `useLocation()` の現在 path で routes を解決し `<link rel="stylesheet" href>` を描画。base URL は `loaderBaseUrl()` と同規則
  - root layout への設置手順を README に記載。SSG では静的 HTML に `<link>` が焼かれることを fixture build で検証
- 受け入れ基準: QWK-001/002 相当 (SSR/SSG で style 欠落なし) が fixture で確認できる

#### R1.5 client navigation loader 統合 (M)

- `useLocation().url.pathname` の変更を `useTask$`/`useVisibleTask$` で監視し `loadRouteStyles(route)` (route-loader, 実装済み・未使用) を呼ぶ。fetch 失敗時は console error + 続行 (crash しない)
- 受け入れ基準: QWK-003/004 相当

#### R1.7 preload / prefetch option (S〜M)

- `QstyleOptions` に `prefetch?: 'none' | 'hover' | 'load'` (default `'none'`)。`'hover'`: link hover 時に destination route の assets を先読み。`'load'`: idle 時に全 route assets 先読み。qwik 側 prefetch 機構との競合時は qwik 側に任せる旨を文書化
- 受け入れ基準: RTE-006、FOUC 解消の確認

#### R1.8 dev の挙動と Backend 差の明示 (S)

- dev は現状維持 (per-module CSS + middleware + HMR)。`backend` は build のみに影響する旨を README/inspector に記載 (README 一部対応済み)
- inspector に backend 種別と chunk plan (members × bytes × fileName) を表示する report を追加 (`__chunkPlans` getter は実装済み)

#### R1.9 haven-web 実測とドキュメント (M)

- haven-web に `qstyle({ backend: 'css-asset', routes: {...} })` と `<QstyleLinks />` を設定
- 測定: 初期 HTML bytes、初期 CSS asset bytes、navigation 追加 bytes、リロード時キャッシュヒット (playwright network log で自動化)
- 測定には §4.1 の usage 配線 (route 分離 chunk) が前提になることに注意

### 3.4 テストマッピング (更新)

| ステップ | 解除されるテスト |
|---|---|
| 実装済み (R1.1–1.3, 1.6) | RTE-001/002/003 の manifest 部分 (asset 名解決)、決定性 (build ×2 byte 等価) |
| R1.4 | QWK-001, QWK-002, RTE-004 |
| R1.5 | QWK-003, QWK-004, RTE-005, RTE-007 |
| R1.6 (browser 検証) | QWK-005, QWK-006, QWK-007, RTE-009 — C0.2 Playwright 基盤が必要 |
| R1.7 | RTE-006, FOUC 判定 |
| §4.1 usage 配線後 | HASH-007/008 (css-asset 版), RTE-002 (route 分離), PERF-004/005 |

### 3.5 リスクと対処 (更新)

- **Qwik 内部依存の増大**: head 注入は qwik city public API (`useLocation` / layout) のみ使用。`q-manifest.json` の解析等は行わない
- **SSR で assets JSON が client bundle に混入**: `virtual:qstyle/routes` は SSR/SSG 用。client には stub の unit id のみ渡る (現状実装も同じ)
- ~~rollup virtual module の遅延解決~~ → 不要になった (unit id 埋め込み方式で解決)

---

## 4. R2: Route-aware chunking の実配線

R1.2 が本体。ここでは planner 側の残課題を定義する。

### 4.1 現状 — **usage 配線の id 不整合 (最優先で修正)**

`planChunks` (`core/chunk.ts`) は §38 第一段階 (usage signature 完全一致) + min/max sizing + similarity>0 の最小 merge を実装済み。asset 化 (R1.2) で emit には接続済み。

しかし R1 実装中に発見: **usage graph には atom id で記録される** (`ingestUnit` 内 `recordUsage(member.atomId, ...)`) のに対し **planner へ渡す `styles` は unit id** (`collected` の key)。その結果すべての unit が「未使用 style」扱い (singleton pack, users=∅) となり、`jaccard(∅,∅)=1` で min (1KB) に達するまで全 unit が merge される。決定性・正確性 (§39 dedup の安全ガードは効く) には影響しないが、**route 分離 chunk が一切生成されない**。RTE-002、HASH-007/008 (css-asset 版)、PERF-004/005 はこの修正が前提。

修正方針 (いずれか、実装時に検討):
- 案 X: `ingestUnit` で unit まとめて `recordUsage(unitId, module)` を追加記録 (atom id の記録は provenance/inspector 用に残す)。planner は unit id の usage を見る
- 案 Y: planner に渡す `styles` を member atom id 単位に展開し、chunk plan の members を unit に逆マップする
- 案 X の方が graph への追記が単純。`usageSignature`/`groupByUsageSignature` は id 非依存なのでそのまま動く

### 4.2 実装項目 (順番)

0. **usage 配線の id 不整合修正** (§4.1) — CHUNK テストと HASH-007/008 (css-asset 版) を添えて
1. **route signature の活用** (`usage.ts` に `recordComponentRoute` あり):
   - chunk の users に route が含まれる場合、route-local chunk / shared chunk の分類を manifest に記録
   - `shared` 判定 = users が 2 route 以上、または usage signature に複数 component
3. **cost function v0** (§40 の縮約版、clustering v2 (R3) の前段):
   ```text
   chunkCost = bytes + requestOverhead(=512B 仮置き) + unusedRatio * bytes
   ```
   現状の min/max 運用と等価になることを確認してから重みを導入する (いきなり完全式を入れない)
4. **サイズ閾値の運用**: `DEFAULT_CHUNK_OPTIONS` (1KB / 32KB) をそのまま用い、haven-web 実測で調整。変更は versioned JSON (§12) に記録

### 4.3 完了条件

- HASH-007/008 (局所変更の hash 安定) が css-asset build で green
- RTE-009 (many small atoms で request 爆発しない)、RTE-010 (max chunk policy) green
- haven-web の chunk 構成レポート (inspector) で route 別 bytes / shared bytes が読める

---

## 5. R3: §39 clustering v2 (cost-based merge)

### 5.1 現状と目標

- v1 (`vite/dedup.ts`): 最終 CSS 上の同一宣言 group selector 化 (安全ガード付き)。chunk 内適用は R1.2 で統合済み
- core `chunk.ts` の `mergePacks`: similarity>0 の最小 merge のみ
- v2 の目標: **pack 粒度**での usage set 近似 merge を cost model で制御する

### 5.2 実装項目

1. `ChunkOptions` へ `similarityThreshold?: number` (default 0.3) と `requestOverheadBytes?: number` を追加。`mergePacks` が threshold 未満の merge を拒否
2. 安定性ペナルティ (§41 の proxy 版): merge 候補の unit 群が同一 module 由来でない場合、`invalidationPenalty` (仮置き = merge 後 bytes × 0.1) を cost に加算。Git history 連携は Post-MVP
3. 純関数のまま保ち、決定性規律 (sort 済み入力走査・packKey = sorted members) を維持
4. `strategy: 'usage-cluster'` (`QstyleOptions.chunking.strategy` 型に既存) を v2 有効化の窓口にする

### 5.3 新規テスト (CHUNK-XXX を新設)

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| CHUNK-001 | P0 | clean build ×2 | chunk 構成・hash 同一 |
| CHUNK-002 | P0 | usage 完全一致の unit 群 | 同一 chunk |
| CHUNK-003 | P0 | similarity 閾値未満 | merge しない |
| CHUNK-004 | P1 | max 超過 group | first-fit 分割が決定的 |
| CHUNK-005 | P1 | route A local 変更 | route B chunk hash 不変 (=HASH-007 と連動) |
| CHUNK-006 | P2 | 1000 unit 合成 | plan 時間が記録 budget 内 |

---

# Part B — 機能仕様の残件

## 6. R4: 構文対応の小項目・品質残件

いずれも現状は safe fallback (untouched / residual / diagnostic warning) 済み。機能化するか、明示 diagnostic に留めるかを個別に判断する。

### 6.1 template literal value 内の StyleHandle 参照 (`qwik/src/template.ts:116` 付近)

- 現状: M5b でも未対応 → interpolation 全体が runtime slot 化されるか untouched
- 選択肢: (a) `${handle}` を `static-fold` して composition atoms に展開 (b) unsupported diagnostic
- 推奨: (b) を先に (TPL-011 は prop 経由で既に green のため)、(a) は需要が出てから
- テスト: TPL-011 の補完、diagnostic 表示の DIA 系

### 6.2 条件式内 nested ternary (vite `index.ts` css prop scan, `:404` 付近)

- 現状: 対応せず untouched、warning なし
- 推奨: untouched 理由を `noteSkipped('nested conditional is not supported')` で明示 (DIA-002 の下位種)
- 規模: S

### 6.3 `css()` 第2引数 (`index.ts:1056` 付近)

- 現状: object literal の後に引数があれば未対応として無視
- 推奨: 型レベルで拒否 (`css(obj, x)` の overload を定義しない) + FLB-002 diagnostic
- 規模: S

### 6.4 parametric を含む handle の条件付き適用 (`index.ts:1502` 付近) / nested conditional (`:1514` 付近)

- 現状: untouched。理由は code comment にあるが user visible でない
- 推奨: noteSkipped 経由で diagnostic 表示のみ (DIA-001/002 系)。機能化は需要後
- 規模: S

### 6.5 compound slot の型推論 (`index.ts:2281` 付近)

- 現状: valueType 一律 `custom`。同一 static text なら推論と等価
- 推奨: 現状維持 (cost model は R3 後)。DED-010 で挙動を固定する test のみ追加

### 6.6 `@keyframes` 等 unsupported at-rule (css prop 内)

- 現状: `parseNestedKey` が受理せず residual → prop 全体 untouched。ユーザーは `useStyles$` 併用で回避 (haven-web status-dot / terminal-chrome が実例)
- 推奨: 現状維持。`keyframes()` helper は Post-MVP。README の workaround 記載を充実 (S)

### 6.7 generateBundle の CSS 編集と source map (`vite/dedup.ts`)

- 現状: 最終 asset のみ編集のため map 不整合の実害は小。R1.2 で css-asset 側は hash 計算前に dedup するため問題が消える
- 推奨: DIA-005 実装時に要否判定。不要ならこの項を閉じる

---

# Part C — テスト完成 (M11 / Release Gate)

## 7. C0: テスト基盤の整備 (先行)

テーブルのテスト群を実行するための infrastructure。本パートの全作業の前提。

### C0.1 lifecycle fixture app (新規 `fixtures/lifecycle/`)

- Qwik City の最小 app: 3 route (`/`, `/a`, `/b`)、共有 Header component、`/a` 配下に lazy component (client-only 出現)、dynamic signal で `width` を更新する component
- 各 css は css prop で書く (qstyle ON)。**baseline 版** (同意味の `useStyles$` CSS に置換) を generator script (`fixtures/lifecycle/gen-baseline.mjs`) で生成
- dev / preview 両方で起動できる `package.json` scripts

### C0.2 Playwright 導入 (新規 devDependency、workspace root)

- `playwright.config.ts`: `webServer` で `vite preview` (build 済み dist)、projects = chromium / webkit / firefox
- helper `test/compare.ts`:
  ```ts
  async function expectSameComputedStyle(page, selector, props: readonly string[], baselineURL, optimizedURL)
  ```
  fixture ごとに観測 property を宣言 (§11 の規約)。pseudo は `getComputedStyle(el, '::before')`
- CI: まだ CI が無いため、まず `pnpm test:e2e` の local 実行を整備。CI 化は P1 (§17)

### C0.3 browser differential fixture 対 (新規 `fixtures/browser/`)

- `baseline/` (qstyle OFF) と `optimized/` (ON) の同一 app。coverage 対象は §8 の unit 系テーマを画面に並べた gallery page (selector / cascade / dynamic / media)
- gallery 1 page で数十ケースを一度に検証し、実行時間を抑える

### C0.4 size report harness

- `scripts/size-report.mjs`: build 後 dist から §12 の計測値を JSON 出力。baseline/optimize 差分と前回比 (versioned JSON `benchmarks/last.json`) を持つ
- `pnpm report:size`。CI artifact 化は P1

## 8. Unit 系の未実装テスト

test ID ベースの判定 (ID 未付与の暗黙カバーはこの限りではない)。

**実装済み**: OBJ-001..018,022..024 / SEL-001..003,008..016,021,022 (008/009/010/015 は不支持の現状固定) / CMP-001..005,007..011,014,015,017,020..022 / TPL-001..005,007..011,013..015,017 (006 は slot 化の現状固定) / DYN-001..010,016,017,019,020,024 / CSS-001..003,006..010,013 / DED-001..004,006..008,011,013 / HASH-001..006,011,012 / HMR-008 / DIA-003,008 / TYP-007 / SEC-005,008 / FLB-006,007,010 / PERF-001,006 / RTE-008

配置先の目安: 8.1–8.6 → 各 package の既存 test file に追記。8.7/8.8 → vite package + `fixtures/lifecycle`。

### 8.1 `css` prop / object syntax (3 件 — OBJ-019/020/021 は vite transform・型 harness 依存)

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| OBJ-019 | P0 | `css={false/null/undefined}` | DOM/CSS 影響なし |
| OBJ-020 | P1 | readonly object / `as const` | 型・transform 正常 |
| OBJ-021 | P1 | const alias | provenance を保持して解析 |

### 8.2 selector / pseudo / at-rule (6 件)

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| SEL-004 | P0 | `& > child` | child combinator 保持 (現状 residual。対応または residual 明示の検証) |
| SEL-005 | P0 | `& + sibling` / `& ~ sibling` | sibling relation 保持 (同上) |
| SEL-006 | P0 | descendant selector | scope/cascade 保持 |
| SEL-007 | P0 | attribute selector | quoting/escaping 保持 |
| SEL-017 | P0 | selector specificity conflict | plugin OFF/ON 同値 |
| SEL-018 | P0 | source-order-dependent equal specificity | chunk order と無関係に同値 |

注意: SEL-004/005 は現行 `parseNestedKey` が受理しない形式 (combinator)。residual 化の検証は vite transform 経由で行う (DIA-002 連動)。受理拡張は個別判断。

### 8.3 `css()` / composition (3 件)

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| CMP-006 | P0 | falsy entries | 無視される |
| CMP-016 | P1 | handle reused 1000 times | CSS 1回、DOM値のみ増加 |
| CMP-018 | P1 | circular module graph around handles | build を壊さず diagnostic |

### 8.4 tagged template literal (2 件)

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| TPL-016 | P1 | source map | interpolation 元位置を指す |
| TPL-018 | P1 | minified source input | transform 正常 |

### 8.5 Dynamic / ParametricAtom (10 件)

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| DYN-009 | P0 | media + dynamic value | media context 内で variable 参照 |
| DYN-011 | P0 | parent/child same variable-shaped atom | inheritance 衝突なし |
| DYN-012 | P0 | signal update 1回 | CSS rule追加なし、value のみ更新 (lifecycle fixture 必須) |
| DYN-013 | P0 | signal update 1000回 | stylesheet/rule count 増加なし (同上) |
| DYN-014 | P0 | SSR initial dynamic value | server HTML に初期値あり |
| DYN-015 | P0 | resume 後同値 | hydration/resume mismatch なし |
| DYN-018 | P0 | dynamic CSS structure | safe fallback/diagnostic |
| DYN-021 | P1 | rapidly changing pointer position | style asset fetch 0、DOM update のみ (R1 後) |
| DYN-022 | P1 | same parametric structure across modules | semantic atom 共有 |
| DYN-023 | P1 | slot ordering changes after unrelated edit | stable slot identity |

DYN-012〜015/021 は C0.1 fixture + Playwright で実装 (unit 不可)。

### 8.6 Cascade / CSS semantics (9 件)

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| CSS-004 | P0 | inherited property | inheritance 一致 |
| CSS-005 | P0 | non-inherited property | inheritance しない |
| CSS-011 | P0 | `:where()` zero specificity | baseline と一致 |
| CSS-012 | P0 | CSS layer order | baseline と一致 |
| CSS-014 | P0 | transition + dynamic variable | interpolation semantics 一致 |
| CSS-015 | P0 | `currentColor` / inheritance-dependent value | baseline と一致 |
| CSS-016 | P0 | invalid-at-computed-value custom property | browser semantics を変えない |
| CSS-017 | P1 | writing-mode/logical props | baseline と一致 |
| CSS-018 | P1 | direction RTL/LTR | baseline と一致 |

CSS-004〜018 は browser differential (§11) との重複が大きい。unit (serialize 結果の静的比較) と browser (computed style) の 2 層で実装する。

### 8.7 Dedup / determinism / HMR / diagnostics (28 件)

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| DED-005 | P0 | equivalent canonical color spelling | 証明できる範囲で同一 identity |
| DED-009 | P0 | layer difference | ordering 上必要なら別 context |
| DED-010 | P0 | runtime structure same/value different | ParametricAtom 共有 |
| DED-012 | P1 | order-independent props | deterministic canonical order |
| DED-014 | P1 | 10k duplicate occurrences | 出力が occurrence に比例しない |
| HASH-007 | P0 | route A local style change | 無関係 route B chunk hash 不変 (css-asset 版。R1.2 依存) |
| HASH-008 | P0 | shared atom content change | 関係 chunk のみ invalidate (同上) |
| HASH-009 | P1 | file rename with same semantics | semantic atom ID 安定 |
| HASH-010 | P1 | formatting change | CSS asset hash 不変 |
| HMR-001 | P1 | static declaration edit | browser に即反映 (dev + Playwright) |
| HMR-002 | P1 | dynamic expression edit | slot 更新 |
| HMR-003 | P1 | selector edit | old rule が残存しない |
| HMR-004 | P1 | shared handle edit | 両利用箇所更新 |
| HMR-005 | P1 | remove style | stale CSS 消失 |
| HMR-006 | P1 | add new component | full restart 不要 |
| HMR-007 | P1 | syntax error → fix | error recovery 正常 |
| HMR-009 | P2 | 1000 sequential edits | memory/cache leak なし |
| HMR-010 | P2 | large graph local edit | invalidation が局所的 |
| DIA-001 | P0 | unsupported dynamic property name | 元TSX行列を示す diagnostic |
| DIA-002 | P0 | unsupported dynamic selector | 理由を明示 |
| DIA-004 | P0 | malformed template CSS | 元 template location を表示 |
| DIA-005 | P1 | generated CSS sourcemap | source style へ追跡可能 |
| DIA-006 | P1 | composed handle | provenance が複数 source を保持 |
| DIA-007 | P1 | dedup atom | 全 source origins を確認可能 |
| DIA-009 | P0 | same warning incremental rebuild | 無限重複表示しない |
| DIA-010 | P1 | production minification | diagnostics source position 維持 |

DIA-001/002/004/009 は R4 の diagnostic 明示化 (§6.2/6.4) とペアで実装する。

### 8.8 TypeScript / security / fallback (18 件)

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| TYP-001..006 | P0 | property 型 / nested key 型 / `css()`・template 推論 | typecheck 挙動が仕様どおり (type-test harness: `tsc --noEmit` を expect-type で) |
| TYP-008..010 | P0 | css prop handle / array / invalid | typecheck 挙動 |
| TYP-011 | P1 | declaration file emit | consumer で利用可 (haven-web が実例) |
| TYP-012 | P1 | TS strict mode | implicit any 等なし |
| TYP-013 | P1 | monorepo/project references | augmentation collision なし |
| SEC-001 | P0 | runtime string に `;color:red` | declaration boundary 脱出不可 |
| SEC-002 | P0 | runtime string に `</style>` | stylesheet injection 不可 |
| SEC-003 | P0 | quotes/backslashes/newlines | 正しく escape/DOM assignment |
| SEC-004 | P0 | untrusted URL-like value | code execution surface を作らない |
| SEC-006 | P1 | strict CSP fixture | incompatibility を silent failure にしない |
| SEC-007 | P1 | nonce environment | legacy/Qwik style と干渉しない |
| FLB-001 | P0 | unknown but valid CSS syntax | residual 可能なら residual |
| FLB-002 | P0 | parser unsupported syntax | diagnostic、誤CSSを出さない |
| FLB-003 | P0 | inline style のみ解析可能な構造 | inline fallback |
| FLB-004 | P0 | runtime selector | runtime stylesheet 生成なし |
| FLB-005 | P0 | runtime property name | error/inline policy を明示 |
| FLB-008 | P1 | unsupported Qwik version | version check で明示 error |
| FLB-009 | P1 | unsupported Vite version | 明示 error |

SEC-001〜004 は DYN-019 と同じ攻撃文字列 corpus を共有する。

## 9. Qwik lifecycle テスト (全 18 件未実装・ほぼ P0)

実装: C0.1 fixture + C0.2 Playwright。R1 完了後に一括で通せるように fixture は先行して作る。

| ID | Pri | ケース | 期待結果 | 依存 |
|---|---|---|---|---|
| QWK-001 | P0 | SSR initial render | style 欠落なし | R1.4 |
| QWK-002 | P0 | SSG initial render | style 欠落なし | R1.4 |
| QWK-003 | P0 | client-side route navigation | destination style を必要時取得 | R1.5 |
| QWK-004 | P0 | back/forward navigation | style 重複/欠落なし | R1.5 |
| QWK-005 | P0 | conditional lazy component initially absent | 初期 CSS に不要 style を強制しない | R1.6 |
| QWK-006 | P0 | conditional component appears | 必要 style が適用される | R1.6 |
| QWK-007 | P0 | component disappears/reappears | style lifecycle 正常 | R1.6 |
| QWK-008 | P0 | same component repeated | style dependency 重複なし | — |
| QWK-009 | P0 | nested components sharing atom | CSS 重複なし | — |
| QWK-010 | P0 | `useStyles$` coexistence | 既存 style と競合せず semantics 保持 | — (現状でも検証可) |
| QWK-011 | P0 | `useStylesScoped$` coexistence | scoped semantics 保持 | — |
| QWK-012 | P0 | scoped class collision across components | leak なし | — |
| QWK-013 | P0 | resume after SSR | runtime stylesheet engine 不要 | R1.4 |
| QWK-014 | P0 | dynamic signal after resume | custom property のみ更新 | R1.4 + DYN 系 |
| QWK-015 | P1 | nested lazy boundaries | ownership/pack 解決正常 | R1.6 |
| QWK-016 | P1 | error boundary / rerender path | style state 破損なし | R1.5 |
| QWK-017 | P1 | streaming SSR 構成 | style ordering を維持 | R1.4 |
| QWK-018 | P0 | production optimizer enabled | dev-only assumption に依存しない | build 全般 |

## 10. Route / chunk loading テスト (RTE-008 以外未実装)

| ID | Pri | ケース | 期待結果 | 依存 |
|---|---|---|---|---|
| RTE-001 | P0 | route A only style | route B 初期 CSS に混入しない | R1.1–R1.3 |
| RTE-002 | P0 | shared style A/B | shared chunk 化可能 | R2 |
| RTE-003 | P0 | route-specific + shared | manifest 正確 | R1.3 |
| RTE-004 | P0 | dynamic route SSG | 各生成 route dependency 正確 | R1.4 |
| RTE-005 | P0 | client-only style | SSG manifest だけを真実として欠落させない | R1.5/R1.6 |
| RTE-006 | P0 | lazy asset already cached | 再 fetch 不要 | R1.7 |
| RTE-007 | P0 | missing asset on navigation | 1回だけ取得 | R1.5 |
| RTE-009 | P1 | many small atoms | one-atom-one-request を避ける | R2 |
| RTE-010 | P1 | large route-specific CSS | max chunk policy 適用 | R2 |
| RTE-011 | P0 | chunk load order shuffled | computed style 一致 | R1 完了後 |
| RTE-012 | P0 | parallel chunk completion order reversed | computed style 一致 | R1 完了後 |

RTE-011/012 の実装方法: manifest の asset 順を入れ替えた build を 2 種作り computed style を比較 (ordering constraint §19-4 の検証)。

## 11. Browser differential matrix (未実装)

C0.3 fixture 対 + C0.2 config。Chromium / WebKit / Firefox の現行系:

1. baseline (qstyle OFF・意味的に同一の CSS) と optimized (ON) を同一入力から生成
2. state / pseudo / media / container 条件を操作
3. 対象 element の必要 property を `getComputedStyle()` で比較
4. pseudo-element は `getComputedStyle(el, '::before')`
5. layout-sensitive fixture は bounding box も比較
6. visual-only 差異の可能性がある fixture は screenshot regression (`toHaveScreenshot`)

`getComputedStyle()` 全 property の単純比較は browser normalization 差があるため、fixture ごとに観測 property を宣言する。実行時間は gallery page 集約で 1 browser あたり数分以内を目標。

## 12. Performance / size (PERF-002..005, 007..010 未実装)

C0.4 harness で計測 (絶対値 + baseline 差分 + 前回比):

- total generated CSS bytes (raw / gzip / brotli)
- initial route CSS bytes / navigation additional bytes
- unused CSS ratio per route
- HTML class / custom property bytes
- CSS request 数 / atom 数 / dedup ratio
- clean build / incremental build 時間、HMR latency、peak RSS

| ID | Pri | ケース | 期待結果 |
|---|---|---|---|
| PERF-002 | P1 | 1000 identical static styles | output CSS 線形増加しない |
| PERF-003 | P1 | 1000 dynamic widths | 1 parametric structure + values |
| PERF-004 | P1 | route-local 50KB CSS | unrelated route 初期転送に混入しない (R1.9 実測) |
| PERF-005 | P1 | shared 10KB CSS across routes | cache reuse (R1.9 実測) |
| PERF-007 | P1 | one component local edit | incremental invalidation 局所化 |
| PERF-008 | P2 | 10k components synthetic | build が記録 budget 内 |
| PERF-009 | P2 | 100k style occurrences | memory growth 計測・閾値化 |
| PERF-010 | P1 | parametric promotion overhead | HTML増加込みの total cost で評価 |

閾値は benchmark 後に `benchmarks/budget.json` として固定。

## 13. Property-based / fuzz (未実装・P2)

Property-based (`fast-check` 想定):

- static declaration set の順列 → 安全集合で canonical output 同値
- duplicate occurrence 数を変えても semantic set 不変
- runtime slot 値だけ変えても stylesheet bytes 不変
- traversal order を変えても output hash 不変
- composition tree の nesting を変えても flatten 後順序が同じなら同一結果

Parser fuzz (template / selector / declaration / interpolation boundary / unicode・escape):
不正入力で crash / hang / OOM しない。time budget 付きで実行。

## 14. Regression corpus 運用

bug は最小 fixture に縮小し ID 付き regression test として `packages/*/src/*.test.ts` または `fixtures/` に永久保存。「修正コードだけ入れて fixture を追加しない」変更は禁止。

---

# Part D — 品質定義

## 15. Release Gate

### P0 (release blocking)

1. 対象 fixture 全件で plugin OFF と plugin ON の `getComputedStyle()` が意味論的に一致
2. SSR / SSG / client navigation / lazy component / resume 後に style 欠落・FOUC・二重適用なし
3. clean build が byte-for-byte deterministic
4. 同一 semantic declaration の dedup が correctness を壊さない
5. dynamic value 更新で新規 stylesheet/style rule を生成しない
6. chunk 分割・ロード順を変更しても cascade order が維持される
7. 未対応構文は silent miscompile せず residual / fallback / diagnostic
8. typecheck、unit、integration、browser differential、production build test がすべて green

### P1 (beta blocking)

- HMR が state を不必要に破棄せず style 更新を反映
- source map / diagnostic が元 TSX 位置を指す
- 局所変更で無関係 asset hash が変化しない
- benchmark corpus で baseline 比較の意図しない大幅悪化なし

### P2 (継続品質)

- 大規模 fixture、property-based、fuzz、複数 browser matrix、長時間 incremental build

## 16. MVP completion criterion

- P0 test 全件 pass
- known correctness failure = 0
- unsupported case はすべて明示 diagnostic / residual / inline fallback のいずれか
- Chromium/WebKit/Firefox differential suite pass
- clean-build determinism suite pass
- SSR/SSG/navigation/lazy/resume suite pass
- dynamic signal update で stylesheet mutation count = 0
- baseline 比較 size report を CI artifact 化
- API examples 1〜4 が typecheck + build + browser test 通過
- Tailwind adapter は実装されていないこと

---

# Part E — 優先順位・依存・リスク・判断

## 17. 実行順序と依存グラフ (2026-09-06 更新)

```text
[完了] R1.1〜R1.3 + R1.6 (Backend B 骨格: asset emit / units.json / stub / client helper)
[完了] unit 系不足分の大半 (§8.1〜8.6 の core/qwik 分 45 件 + 実装バグ 4 件修正)

次の一手:
§4.1 usage 配線の id 不整合修正            ← R2 の前提。これがないと route 分離 chunk が出ない
  └─ R1.4 <QstyleLinks /> (SSR/SSG head link) → R1.5 (client navigation) → R1.7 (prefetch)
C0.1/C0.2 fixture・Playwright 整備         ← 上記と並行 (QWK-008〜012, DYN-012〜015 は R1 非依存)
R2 残 (route signature / cost v0) → R3 (clustering v2)
R1.8 (inspector/README) → R1.9 haven-web 実測 (§4.1 修正後でないと意味がない) → PERF-004/005
§8.7/8.8 (HMR/DIA/TYP/SEC/FLB) → browser differential (§11) → PERF 残 → fuzz (P2)
```

haven-web 側残作業: `qstyle({ backend: 'css-asset', routes: {...} })` 設定、`<QstyleLinks />` 設置 (R1.4 の後)、css prop 採用の拡大 (実データでの dedup/chunking 検証)。

## 18. リスク (継続)

- **CSS correctness risk (最大)**: safe mode default、residual fallback、browser differential tests で抑止
- **Qwik build internals dependency**: Backend B は qwik city public API (`useLocation` / layout) のみ使用し、`q-manifest.json` 解析等は行わない。version-specific glue は `@qstyle/qwik` に隔離、core は Qwik 非依存を維持
- **rollup virtual module の遅延解決** (R1.6): spike で最初に検証。不可なら案 B (unit id 埋め込み + client 側 index 参照)
- **chunk 再分割の安定性**: min/max 境界変化の影響が route 局所に留まることを HASH-007/008 で固定
- **HTML bloat**: cost model・promotion threshold・short hash で抑制
- **Too many chunks**: min chunk size・usage clustering・request overhead cost
- **Cache invalidation amplification**: locality-aware chunking・invalidation penalty・stable grouping
- **vite-plus (VITE+) 互換警告**: Qwik β43 が serve で `emitFile` を呼ぶ警告は既知・実害なし。Qwik 側修正を待つ

## 19. 設計上の重要判断 (変更なし・継続)

1. 「CSS file optimizer」ではなく「Style Graph Compiler」— 宣言・依存関係の意味論的再構成が本体
2. Authoring syntax と Style IR を分離 — cross-syntax dedup の基盤
3. Dynamic style は CSS generation ではなく parameter binding — CSS asset は immutable
4. Composition order は class string order に依存させない — ordering constraint は IR が保持
5. SSG は optimization hint であって唯一の真実ではない — client-only 依存と併存
6. Backend A (qwik-native) を correctness 実装の基盤とし、Backend B で network 最適化を完成する二段構え

## 20. Post-MVP (引き続き範囲外)

Tailwind CSS v4 adapter、UnoCSS adapter、`recipe()`、`styled()`、`keyframes()` helper、`globalCss()` helper、auto `@property`、change-frequency based chunk planning、traffic-weighted optimizer、CSP-specialized runtime variable backend、cross-project shared content-addressed style registry。
