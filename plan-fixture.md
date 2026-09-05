# qstyle — 目標と計画、現時点での進捗

**作成日:** 2026-09-06
**参照文書:** [plan.md](./plan.md) (設計思想・詳細設計・実装計画の全文)
**本書の役割:** plan.md の目標・マイルストーンを軸に、現時点の実装進捗と残課題を固定する作業ステータス文書。

---

## 1. 目標

Qwik の `useStyles$()` / `useStylesScoped$()` が持つ「コンポーネント単位で必要なスタイルを遅延ロードできる」性質を維持しつつ、サイト全体を横断して CSS を解析・再配置・共有・分割する Style Graph Compiler を構築する。

主要な成功条件 (plan.md §1, §4):

1. サイト全体で意味的に同一なスタイル指定を重複させない (意味論的 dedup)。
2. ルート・コンポーネント・遅延境界ごとの利用実態に基づいて CSS chunk を構成し、初期表示で不要な CSS を配信しない。
3. authoring API は Emotion に近い書き味の `css` prop / `css()` / tagged template literal。
4. runtime 値は CSS Custom Property に分離し、CSS 構造は共有可能な `ParametricAtom` として再利用。
5. CSS の cascade / specificity / shorthand / source order の意味論を壊さない (Correctness first)。
6. 安全性を証明できないスタイルは residual として残し、silent failure にしない。
7. 生成物は content hash 付き immutable asset とし、長期キャッシュを最大化。

## 2. 計画 (plan.md Part XVIII のマイルストーン)

| MS | 内容 | 成功条件の骨子 |
|----|------|----------------|
| M0 | Feasibility / 機械検証 | `css={{display:'flex'}}` の最小 proof が production build で動作。Qwik lifecycle を置き換えず style dependency を追加できる |
| M1 | Core IR / canonicalization | StaticAtom / RuleContext / Provenance / ResidualRuleNode / 正規化 / deterministic hash / 完全 dedup。OBJ・CSS・DED の P0 unit test |
| M2 | `css` prop object syntax | object → atom への transform、nested selector / at-rule 対応 |
| M3 | `css()` + composition | handle 合成、order 非依存の composition semantics |
| M4 | tagged template literal | interpolation、object syntax との同値性 |
| M5 | ParametricAtom / dynamic values | RuntimeSlot / ValueTemplate / CSS Custom Property への分離 |
| M6 | Safe global optimization | shorthand map / ordering groups / declaration firewall |
| M7 | Usage graph | usage signature / route signature / grouping |
| M8 | Chunk planner | deterministic chunk 構成、cost function |
| M9 | Hashed CSS assets / SSG manifest | content hash asset + route manifest |
| M10 | Dev/HMR / incremental cache | dev mode policy、キャッシュ無効化 |
| M11 | Quality hardening / RC | Release Gate P0–P2、determinism suite |

## 3. 現時点での進捗 (2026-09-06 時点)

### 3.1 全体状態

- 4 パッケージ構成が実装済み: `@qstyle/core` / `@qstyle/qwik` / `@qstyle/vite` / `@qstyle/inspector`。
- **テスト 247 件すべてパス** (core 97 / qwik 51 / vite 91 / inspector 8、2026-09-06 にホストで再検証済み)。
- M0 の proof (`fixtures/m0-minimal`、`m0-proof.test.ts`) が production build で manifest / atom class / pack css を出力することを継続検証中。
- plan.md の authoring API 4 機能 (css prop object / `css()` / tagged template / dynamic values) の transform カバレッジは実装完了 (コミット `427d3bb`)。

### 3.2 マイルストーン別の達成状況

| MS | 状態 | 根拠 |
|----|------|------|
| M0 | ✅ 完了 | fixtures/m0-minimal + m0-proof.test.ts が green |
| M1 | ✅ 完了 | core IR・canonicalization・hash 実装済み。determinism は M11 suite で継続検証 |
| M2–M4 | ✅ 完了 | `feat(vite): complete MVP transform coverage` (`427d3bb`)。object / composition / template のテスト群 green |
| M5 | ✅ 完了 | M5a–M5c (ParametricAtom/RuntimeSlot/ValueTemplate、template runtime、CSS var slot 注入) |
| M6 | ✅ 実装済み | shorthand map・ordering groups・declaration firewall (`cc8928d`)。実アプリでの検証はこれから |
| M7 | ✅ 実装済み | usage graph / signature / grouping (`642185e`) |
| M8 | ✅ 実装済み | deterministic chunk planner (`a257578`) |
| M9 | ✅ 実装済み | content-hash assets + route manifest (`29b74d6`) + provenance/route asset 解決 (`fb2aab5`) |
| M10 | ✅ 実装済み (core 側) | incremental cache (`adee244`)。Vite dev/HMR 統合の実アプリ検証は未 |
| M11 | 🔶 継続中 | determinism suite (HASH-001..012) は green (`c4ad7eb`)。Release Gate P0–P2 の全体評価は未着手 |

### 3.3 直近の作業 (未コミット、`~/qstyle` = `workspace/` に同一の状態で存在)

opencode セッション「実装の続き」(2026-09-06 深夜、TODO 全件完了) による変更 10 ファイル:

- **core**: `RuleContext.descendant` (`& span.x` 形式の子孫セレクタ、plan.md §10) を IR に追加。`serializeParametricDecl` を切り出し、parametric rule へ descendant 接尾対応。
- **qwik**: `parseNestedKey` が `& selector` を受理。
- **vite**: 直列化 (wrapRuleContext + parametric wrap) に descendant 接尾。テスト拡張 (index.test.ts, m0-proof.test.ts)。
- **README**: consumer 側 `css` prop JSX 型 (`src/qstyle.d.ts` 経由) の手順を記載。
- **テスト**: hash / 直列化 / lowering / e2e transform を追加 → 上記 247 件に含む。

**→ この 10 ファイルは未コミット。次の git 操作でコミットすべき。**

### 3.4 実アプリ (haven-web) での統合状況

- `container_env/haven-web` に qstyle を link install し、Icon コンポーネントを qstyle 化、設定ページ (lazy) 1 要素を qstyle 化。build + type check は成功。
- 未コミット 8 ファイル (icon.tsx / settings-page.tsx / vite.config.ts / package.json / pnpm-workspace / lock / qwik router パッチ / 新規 `src/qstyle.d.ts`)。

### 3.5 未解決の技術課題

1. **lazy CSS 配信が Qwik の設計と衝突** (最重要)。
   実ビルドの検証で、CSS がすべて 1 アセットに集約され head inline されることを確認。原因は Qwik optimizer が client build で `build.cssCodeSplit = false` を無条件に設定すること (`@qwik.dev/core/dist/optimizer.mjs:2720`)。qwik 側に CSS chunking のオプションは見つかっていない (cssChunking 等で検索ヒットなし)。「初期表示で不要な CSS を配信しない」という目標 2 を Qwik-native backend (Backend A) で達成するには、Backend B (hashed CSS assets + 自前の injection) への切り替え、または qwik 内部への依存 (plan.md §104 のリスク) の受入れが必要。**設計判断が未決。**
2. **haven-web の lint 修正 66 ファイルが現行ツリーに存在しない。**
   2026-09-06 に実施した lint 修正 (`pnpm run check` 0 errors / 0 warnings、テスト 114/114、branded ID 化、ssh2 の pnpm patch-commit 等) は、workspace が qstyle コピーで置き換えられる際に失われた。**復元可能**: opencode スナップショット (プロジェクト `47e6440b` の snapshot リポジトリ、ツリー `9d2e9def38e76f2dac6985c90c573cd299fb5504`) に修正完了時点の全ツリーが残っている。git オブジェクトとして取り出せる。
3. haven-web 側の qstyle 統合変更 8 ファイルも未コミット。

### 3.6 次のアクション (優先順)

1. `workspace/` (qstyle) の未コミット 10 ファイルをコミット。
2. opencode スナップショットから haven-web の lint 修正を復元し、`pnpm run check` 0 warnings を再確認の上コミット。
3. haven-web の qstyle 統合 8 ファイルをコミット。
4. 課題 1 (cssCodeSplit) について Backend A vs Backend B の設計判断を行い、plan.md §44–50 を更新。
5. M11 へ向けて Release Gate P0 (correctness / lifecycle) を実アプリ fixture で走らせる。

> **実施上の申し添え:** 上記の計画・手段は拘束しない。目標 (plan.md §1 の成功条件、特に lazy CSS 配信の実現) を達成できるなら、実装者はより有効な方法を自由に選定してよい。計画を外す場合は、その判断理由を変更内容とともに報告すること。
