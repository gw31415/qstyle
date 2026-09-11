# qstyle 設計整合性・CSS配信・性能改善計画

作成日: 2026-09-11（JST）。状態: 調査済み、以下の改善は未実装。

**実装時は [Qstyle 1.0実装仕様](native-style-compiler-spec.md) を優先する。** 追加指定により互換性維持の制約を撤廃し、新API、ordered IR、hash、native lowering、検証gate、移行順序を確定した。本書は調査証拠と要件の記録として保持する。M0–M7は新仕様のD0–D7へ具体化している。

さらに、初期inlineを同containerの別page/lazy componentから本文再取得なしで共有すること、サイト全体の意味付き宣言を一意化すること、有限モデル内で生成class数を厳密最小化することを追加した。旧計画の「重複を理由付きで許容」は撤廃。現行Qwikの新instanceにはstyle QRLの取得前guardがないため、Qwik側の対応を新たな前提条件とする。hard navigationのHTTP cacheとinline再利用の限界は新仕様§7に明記した。

本書は、qstyleを「Qwikのresumabilityを維持し、CSSを意味を変えずに削減し、必要な時点に配信するビルド時ライブラリ」にするための実行計画である。今回は分析・計画書作成が対象であり、製品コードの修正、公開、デプロイは行っていない。

既存の [PLANS.md](../PLANS.md) は前回の安全性修正の完了記録を含むため置き換えない。そこで完了した衝突検出・カスタムプロパティ名検証・build時のfail-closedを維持したまま、本書の未完了作業を進める。既存計画に記載された過去のテスト件数は今回の実行結果とは別の記録である。

## 1. 調査範囲と結論

| 対象 | 調査時のコミット | 役割 |
| --- | --- | --- |
| `/Users/ama/qstyle` | `dfc245a5da1a634111f0f88ebede03b3d658759a` | 本体。5パッケージとlifecycle fixture |
| `/Users/ama/qwik-on-viteplus` | `7ae8e47fe59adbd227060deccac0735e5b99d4c1` | Qwik + Vite Plusの単純なconsumer |
| `/Users/ama/haven-web` | `297ab1de142a305177ace3281ae33761459eb350` | UnoCSSを含むconsumer |

**現状は、CSSのビルド時変換とQwikへの委譲はあるが、全体最適化・遅延配信・リロードなしHMRを同時に保証する設計にはなっていない。** とくに、配信計画はmetadataにしか反映されず、実際のQwikビルドでは別ルート・未表示コンポーネントのCSSまで初期HTMLに含まれる。さらに数値の動的スタイルには単位欠落の実不具合がある。

「コード上確認」は実装経路を確認した事項、「実測」は今回ビルドまたはブラウザで再現した事項、「要検証」は成立条件を追加実験で確かめる事項として記す。全サイト・全ブラウザ・実デプロイでの保証を、単体テストの成功から推定しない。

## 2. 要件を曖昧にしないための契約

| ID | 必須契約 | 合否の観測方法 |
| --- | --- | --- |
| R1 意味保存 | CSS値、優先順位、selector、条件、animation、動的値の意味を維持する | 独立した通常CSS版とのcomputed style差分。SSR→resume→更新→遷移でも一致 |
| R2 削減 | 同一宣言・共有スタイルを識別し、実際に配信するCSS/HTML/JSの合計費用を減らす | IRの件数ではなく最終成果物とnetworkを計測。共有化で意味が変わらない |
| R3 遅延 | 初期renderに不要なroute/component固有CSSを初期HTMLと初期取得対象に含めない | 未表示コンポーネント固有ruleがHTML/CSSOM/初期取得assetにない。表示時に間に合う |
| R4 キャッシュ | 同じ公開URLは常に同じ最終内容。未変更の配信単位は再buildしてもURLを維持する | 二度のbuild、部分変更、別絶対パスでのbuild、cold/warm navigationを比較 |
| R5 SSR/SSG | route初期renderに必要なCSSだけをQwik標準のSSR/SSG出力で供給し、JS実行前から正しく表示する | 標準のinline/asset参照を尊重し、SSGファイルとlive SSR応答を別々に検証。JS無効時とstreaming時の表示を確認 |
| R6 HMR | 通常のCSS編集と対応する構造編集でページnavigationを起こさず更新する | document instance、入力値、signal、focus、scrollを維持し、full-reload通知0件 |
| R7 runtime | qstyleのparser、registry、CSS loader、navigation監視をclientに出さない | client bundleのimport到達解析とnetwork。Qwik標準API/QRLで処理する |
| R8 一貫性 | core → Qwik → Vite → UnoCSS → consumerの契約が一致する | 同一fixtureをdev/build/SSR/SSG/preview、UnoCSS有無で検証 |

### 確定方針: routeの初期描画に必要なCSSをQwik標準で供給する

2026-09-11の追加指定により、qstyleが担当するのはスタイルの最適化と使用境界への依存付けまでとする。各routeの初期描画に必要なCSSへ対象を絞り、その埋め込み・取得・resume時の再利用はQwik標準のstyle処理に任せる。QwikのCSS分割設定やinline閾値を強制変更して解決する方針は採らない。

初期描画の対象は、そのrouteで実際にrenderされるroot、適用layout、page、共有componentと、それらに必要なtheme/preflight/keyframes等の依存である。URLからimport可能な全moduleの集合ではない。同じrouteから参照できても、クリック後に初めてrenderするcomponentや別route専用のCSSは含めない。SSRではそのrequest、SSGではその生成ページのrender結果に対応させる。

「初期描画に必要」は画面上端に見える要素だけを意味しない。初期render済みの画面外要素、hover/focus、media条件、theme等も正しく動くよう必要なruleを保持する。一度のCSS coverage計測や初期viewportだけを根拠に削除しない。

生成するstyle依存をQwikのcomponent/style QRL境界へ関連付け、サーバーでrenderした範囲のstyleを標準処理が供給できるようにする。遷移先やclient初出componentも同じ仕組みを使う。独自route loaderやHTMLへの後付けCSS注入は追加しない。具体的なloweringの成立性はM3で検証するが、この責務分担は比較候補ではなく採用方針とする。

### 最適化の優先順位と避けられないトレードオフ

優先順位は **意味保存 → 初期表示・resumeの正しさ → 遅延境界 → 転送量とキャッシュ → ビルド時間** とする。「CSSファイル数が少ない」「1宣言1class」「CSS requestが0件」のいずれも単独では成功条件ではない。

SSGで埋め込んだCSSはHTMLの一部として届くため、その部分を独立したCSS URLのブラウザキャッシュから省略することはできない。埋め込みを維持する対象を初期render必須CSSに限定し、後から必要になるCSSはhash付きの独立した配信単位として再利用する。HTMLキャッシュとCSS assetキャッシュは別々に評価する。SSR済みスタイルをresumeで再取得する設計は避ける。

「必要になるまで遅延」はまずrender需要を基準にする。Qwikのprefetchを有効にした本番設定では先行取得が起こり得るので、prefetch無効の契約試験と、prefetch有効の実用性能試験を分離する。先行取得を遅延成功と数えず、未使用転送量を記録する。

ゼロruntimeは「動的なclass選択やstyle値の評価を一切実行しない」という意味ではない。それらはQwikに渡す通常の式として必要である。ただしqstyleの共有clientライブラリ・独自CSS管理機構は生成しない。StyleXのアルゴリズムやAPIをそのまま複製することは要件に含めない。

## 3. 確認した問題と影響

### F1 / P0: 動的な数値のlengthが無効なCSSになる（実測）

`fixtures/lifecycle/src/components/dyn-box.tsx:14` の `width: width.value` は、CSSに `width:var(--qstyle-ae415d-0)`、DOMに `style="--qstyle-ae415d-0:100"` を生成する。クリックすると変数は101になるが、Chromiumで幅は1256pxのまま。数値に必要な単位がなく、widthとして有効になっていない。

`packages/core/src/units.ts:71` の静的値には単位規則がある。動的な値も、unitless・length・custom property・文字列を区別して同じ契約に合わせる必要がある。`100px`→`101px`だけでなく、`0`、負数、`50%`、`auto`、`calc()`、`var()`、null/undefinedによる解除も検証する。単純に全値へ`px`を連結すると文字列値を壊す。

### F2 / P0: 遅延CSSが初期HTMLへ含まれる（実測）

今回のlifecycle buildは **CSS 1ファイル、887 bytes、gzip 512 bytes**。`assets/DTTS_25H-style.css` に全ルートと遅延componentのruleが入り、homeの初期HTMLはその内容を `<style data-src="/assets/DTTS_25H-style.css">` として埋め込む。

homeにlazy DOMが存在しない段階で `.q_0b3db21c`（LazyPanelのlavender）と `.q_9ae85514`（LazyInnerのoutline）がCSSOMに存在し、別ルートaboutの `.q_7defb6f6` も含まれる。lazy表示前後ともstylesheet requestは0件だった。表示自体は成功するが、R3を満たさない。

根拠は `packages/vite/src/index.ts:4597` のmodule先頭へのCSS side-effect import、`fixtures/lifecycle/src/components/lazy-panel.tsx` と生成物。moduleへのstatic importとQwikのcomponent/QRL境界を同一視できない。Vite一般のCSS code splitting説明を、このQwik構成の保証として使わない。

原因を依存コードでも確認した。インストールされたQwik beta.43の `packages/qwik/node_modules/@qwik.dev/core/dist/optimizer.mjs:2720` は非CSR経路で `build.cssCodeSplit=false` を設定する。同ファイル `:1248` の `inlineStylesUpToBytes` 既定は20,000で、`:2805` はその閾値未満のstylesheetをinlineにする。今回の887 bytesはこの条件に入る。したがって「ViteにCSS importを渡せばQwikでもlazyになる」という前提が成立していない。大きいconsumerでは外部linkになり得るため、全サイトで常にinlineと一般化しない。閾値を変えるだけでは、全体CSSを必要な境界へ分割する問題は解決しない。

### F3 / P1: chunk plannerと実配信が接続されていない（コード上確認）

`packages/vite/src/index.ts:4662` 以降の `planChunks()` はmanifestを書くだけで、CSS assetを分割しない。`docs/options.md` も `chunking` と `routes` が配信に影響しないことを明記している。`minChunkBytes` や `requestOverheadBytes` を変更しても最終配信を最適化できない。

module単位のpackはunit集合全体を連結する。同一packは共有できても、異なるpackに部分的に共通する宣言を全配信先で一度だけ所有させる契約ではない。`index.ts:4698` のpost処理もassetごとのgroupingであり、複数assetをまたぐ重複除去ではない。現在の1ファイルfixtureだけでは将来の分割後の重複量は評価できない。

### F4 / P1: 構造変更はHMRではなく遅延full reloadに依存（コード上確認）

`packages/vite/src/index.ts:2585` 以降の `refreshDevCss` はCSS-only変更に `css-update` を送るが、変換結果が変わると `index.ts:2716` で `full-reload` を送る。既定700msはQwik側との競合を避ける待機時間であり、stateを保ったHMRの実装にはならない。

devのoccurrence alias、上流UnoCSS transform、Qwik optimizer、client/SSR module graphの更新を同じ編集世代に揃える必要がある。値変更だけ通るテストでは不十分。style追加・削除、要素挿入、分岐変更、連続保存、parse errorからの復帰を対象にする。

### F5 / P0–P1: UnoCSSの安全性・cascade・更新契約が本体と異なる（コード上確認）

| 問題 | 根拠 | 対応 |
| --- | --- | --- |
| `qu_<hash8>` aliasに衝突検出がない | `packages/unocss/src/plugin.ts:390` | tokenの論理identityを登録し異なるtokenの同一aliasを拒否 |
| CSS hashの既存値を本文比較せず再利用する | 同 `:1793`、`sharedCssByHash` はmodule-global | 本体と同じ衝突契約。build/dev/environment間でscopeと寿命を定義 |
| `:where()` を一律 `:is()` に変換する | 同 `:80` と `:1796` | matchingが同じでもspecificityが変わる。layer/preflight順序で解決し、宣言の意味を勝手に変えない |
| config/resolverが一度のPromiseで固定される | 同 `:1748–1789`、configResolvedはroot設定のみ | config依存ファイル監視、resolver/memoの世代更新、利用module再変換、古いvirtual CSS撤去を実装 |
| config読込失敗がwarn + 無変換になる | 同 `:1782` | buildでは適用不能をerrorにする。devはエラー表示と回復が必要 |
| `class` と `css` の優先順が文書と不一致 | 同 `:2050`、`docs/unocss.md` 翻訳規則4 | 実装は属性順で後勝ち。公開契約を決め、両順序のfixtureと文書を揃える |
| API引数の受理と挙動互換が混同される | `QstyleUnoOptions` とdocsの「import元の変更のみ」 | 無視するmode等、動的文字列、class名依存コードの非互換を明示 |

優先順については、実際のplugin transformでも `class="audit" css={{color:"blue"}}` はblue後勝ち、属性順を逆にするとutilityのred後勝ちになることを確認した。新仕様ではこの挙動を破壊的に変更し、属性の記述順ではなくutility→css配列→明示styleの合成順を固定する。importantやselector specificityのCSS規則は維持する。

未知utilityをすべてerrorにすると利用者独自のclassまで拒否する。unknown user class、有限に解決可能なutility、動的で列挙不能なutility、config自体の失敗を区別する。有限列挙はbuild時に解決し、列挙不能はsafelist等の明示契約または診断にする。

### F6 / P1: hash付きURLの意味とbuild後処理を検証できていない（要検証）

IR/unitのhash、virtual packのhash、最終asset URLのhashは異なる。32-bitのclass hashを長くするだけで最終配信キャッシュは改善しない。

`index.ts:4698` は `generateBundle` でCSS本文を変更する。ファイル名確定・Qwikのmanifest/inline内容採取より後に変更される可能性があり、最終本文・asset名・埋め込み内容が一致するかを確認する必要がある。`unitTagNames` / `condUnitIds` などCSS外の情報でも最適化結果が変わり得る。現時点では同一URL・異なる本文が本番で起きたと断定しない。

最終内容の決定後にhashと依存参照を確定するphase設計にする。後からファイル名だけ付け替える修正は、HTML・Qwik manifest・bundle graphの参照切れを起こすため採らない。

### F7 / P1: 検証資産が現在の配信方式から取り残されている（実測）

- `fixtures/lifecycle/e2e/ssg.config.ts:17` は存在しない `ssg-bake.spec.ts` を指定し、`--list` は `No tests found` で終了する。
- `qwk-matrix.spec.ts:39` はURLに `qstyle` があるCSSだけを数える。現在のhash assetやQwikのQRL配信を見落とす。初期DOMがないことは初期CSSがない証明にならない。
- `c0-smoke.spec.ts:64` と `qwk-matrix.spec.ts:140` はstylesheet link必須を仮定し、正常なinline CSSを失敗扱いする。
- rootの `pnpm test` はbrowser matrixを実行しない。今回unit testsが成功しても上記F1/F2は残った。
- `benchmarks/*2026-09-06.json` は旧version 1、`qstyle.*.css` / route asset集計。現行 `scripts/size-report.mjs` はversion 2で総CSSとmetadataを集計するため、旧数値は現行のbaselineに使えない。
- `size-report.mjs` の `--compare` は差分表示であり予算超過を失敗にしない。`manifest.packs` は現状collected unit群なので、reportの `packCount` は実配信pack数ではない。
- CSSファイルだけの集計では、SSR/SSG HTML内のCSS、style/class属性、QRLのCSS文字列、Qwik serialization量を見落とす。

### F8 / P1: consumerの参照版が揃っていない（コード上確認）

qstyle本体とqwik-on-viteplusは0.2.0系、haven-webは `@qstyle/qwik:^0.1.0`、`@qstyle/unocss:^0.1.0`、`@qstyle/vite:^0.1.1` を参照する。どちらも本体workspaceへの直接linkではない。0.xのminor差があるため、haven-webでの成功を本体0.2.0の検証とみなせない。

haven-webの `vite.config.ts:17` 付近には旧 `links.qwik.mjs`、`css-asset` backend、route分割のコメントが残る。公開tarball版とローカル開発版を区別し、同じ候補tarballを2サンプルに導入するconsumer試験が必要。単なるTypeScript aliasだけではpackage exports・sideEffects・梱包不備を検出できない。

具体的には `../haven-web/src/root.tsx:3` の `@qstyle/qwik/links` と `:29` の `<QstyleLinks prefetch="hover" />` は0.2.0のexportsに存在しない。依存版だけを上げると解決不能になるため、今回の目標であるruntime-less構成への移行では呼び出しも一緒に変更する。旧runtime維持を目標にはしない。

両consumerは `pnpm-workspace.yaml` でViteを `@voidzero-dev/vite-plus-core@0.3.0` にoverrideし、Qwik Router beta.43へpatchを適用している。本体fixtureのVite 8.2.2と同一条件ではない。patch適用後のadapterも検証対象とし、peer warningの抑制を互換性の証明にしない。

haven-webのCloudflare adapterは `cloudflarePagesAdapter()`、qwik-on-viteplusは `ssg.include:["/*"]` とoriginを明示している。havenのSSGページ生成は未検証なので、SSG対象routeを明示して出力件数を検証する。利用者固有データを含むrouteは一律SSGにせずSSR対象として分類する。originは環境ごとの設定値とする。

qwik-on-viteplusは `src/entry.ssr.tsx:29` 付近でQwik preloaderを無効化しているが、haven-webは旧QstyleLinksのhover prefetchも使う。初期転送・遷移時間を比べる際にはこの差を揃える。haven-webのUIは主にutility classなので、直接css propのfixtureの代わりにはならない。

### F9 / P2: 正しく動いている部分と未測定部分

本体のcollision registry、保守的なcustom property名validator、build既定errorは既に存在し、今回のunit suiteも成功した。これらを「これから実装」として二重計上しない。SSGのinline出力、通常の表示、複数回のsignal更新でstylesheetを増やさない経路も確認できた。

実デプロイのLCP/INP/CLS、CDN・browserキャッシュ命中、圧縮レスポンス、モバイルCPU、Firefox/WebKit、全consumerの実行結果は未測定。改善幅をmsや%で断定しない。専用Chrome DevTools trace toolはこのセッションにはなく、今回はローカルPlaywrightと成果物検証を用いた。

2つのconsumerはソース・lockfile・設定の監査までで、今回それらのbuild/previewは実行していない。実行結果の表はqstyle本体と同梱lifecycle fixtureについての結果である。

### F10 / P0–P1: CSS値とsemantic identityの追加不整合（実行確認）

| 現象 | 根拠と今回のprobe | 方針 |
| --- | --- | --- |
| quoted string内の空白が変わる | `packages/core/src/units.ts:53`、`atom.ts:13`。`createStaticAtom({property:'content',value:'"a  b"'})` が `"a b"` を返す | CSS tokenを認識する正規化へ。`keyframes.ts`、parametric text fragment、UnoCSSにも適用 |
| parametric fallbackがhashに入らない | `packages/core/src/parametric.ts:37,137,161`。fallbackが10pxと20pxでhashは同じ `q_714c7b2b`、出力CSSは異なる | CSSに残るfallbackをidentityへ含める。runtime値とfallbackを混同しない |
| 同値contextのobject key順でhashが変わる | `packages/core/src/atom.ts:67`。media→pseudoとpseudo→mediaで `q_adead825` / `q_12adf481` | object field順をcanonicalにする。selector/at-rule配列の意味ある順序は保存 |
| UnoCSS verbatimのwrapperが消える | `packages/unocss/src/resolve.ts:785`。`resolve(['md:grid'],{verbatimOnly:true})` が `.md\:grid{display:grid;}`、aliasありでは `@media (min-width:48rem)` を保持 | aliasなしでもwrapperを再構築し、nested wrapperのsource offsetも検証 |

fallbackについて証明できたのはcore APIでの「同一hash・異なるCSS」であり、Viteの衝突検出を通り抜けて本番表示が誤ることまで確認したわけではない。誤った統合でも意図しないbuild errorでも契約の不整合となるため、identityを修正する。

wrapper欠落はresponsive以外のsupports/layerにも波及する可能性がある。互換モードだけでなく、order conflictからverbatimに戻る経路を含めて検証する。`parseCssRules` の不完全入力終了が完全parseと区別されない点も、部分CSSだけを成功扱いしないよう修正する。

### F11 / P2: 公開core APIと解析器の境界を追加で確認する

- `packages/core/src/safety.ts:274` はcustom propertyをordering groupから除外する。ただし通常の `css={[{'--x':'red'},{'--x':'blue'}]}` は今回のVite transformで正しくblue後勝ちとなり、逆順もred後勝ちだった。したがって通常compositionの確定バグとはしない。低レベルatom列・template重複宣言・条件付き合成で順序保証を試験する。
- `packages/core/src/safety.ts:340` の24-bit ordering group IDと `packages/core/src/chunk.ts:270` の24-bit planner IDは、衝突の影響範囲を整理する。後者は現在metadataであり、実配信packの32-bit IDとは別。M4で配信に接続する前に登録・衝突検出を追加する。
- `packages/core/src/dedup.ts` がStaticAtom専用であること自体を不具合としない。parametric/keyframes/global等の各公開経路で、どの層がidentityを検証するかを一覧化する。直接coreを使う場合の保証範囲を明示する。
- `createStaticAtom` は通常property/valueの検証がparametric constructorより薄い。低レベルの信頼済みIR用APIなのか、未検証入力を受理する公開APIなのかを定義し、宣言境界・NaN/Infinity等のテストを揃える。
- 手書きJSX/CSS scannerのbinding、import alias、shadowing、comment、escape、nested expression、cross-module handle、sourcemapをfixtureで固定する。AST/token parserへの置換はこれらの不具合修正と段階的に行い、文字列置換の例外を追加し続けない。
- UnoCSSの `resolve.ts:386` は特定の `@supports color-mix` のfallbackを削除する。対応browser baselineを文書化し、そのbaselineを外す設定ではfallbackを保持する。実際の対応ブラウザを超える「同値」とは呼ばない。
- resolverはtoken集合ごとに `uno.generate` を実行しmemoを保持する。組合せが多い場合の呼出回数・heapを計測し、意味を維持できる範囲でbatch化する。無効化できないmemoを高速化として採用しない。

調査時に挙がった「最終asset名がSHA-256/SHA-1先頭と一致しない」という観測は、Viteがその形式を契約していないため不具合の証拠として採用しない。F6では同一URLと最終内容の対応という実際の契約を検証する。また動的widthの実出力は `var(--slot)` であり、`var(--slot)px` ではない。後者を修正案にしてもCSS tokenとして単位連結にはならない。

## 4. 目標アーキテクチャと決定ゲート

```text
authoring (object/template / optional UnoCSS)
    → 構文・binding解析 / diagnostics
    → 意味を維持する共通IRとidentity
    → component・QRL・routeごとの使用境界
    → 共通所有者と配信単位の計画
    → Qwik標準のstyle/QRL依存関係へlowering
    → Vite/Qwikによる最終内容・hash・manifest・SSR/SSG出力
    → native runtimeが必要時に取得（qstyle client engineなし）
```

dev/buildで違ってよいのは配信adapterとデバッグ用identity。CSS意味論・対応構文・単位・優先順・診断の基礎規則を二重管理しない。

### 入力から出力・診断までの共通fixture

| 入力 | 期待出力 | 診断・失敗条件 |
| --- | --- | --- |
| 同じstatic宣言をobject/templateで記述 | 同じsemantic identityと同じ表示 | 出力差は正規化の不整合として失敗 |
| 数値のdynamic width / unitless opacity | 適切な単位のstyle変数と静的CSS、Qwikの更新式 | 列挙不能な構文を黙って残さない |
| `content:'"a  b"'`、escape、data URL | 内部文字列を保存 | tokenを解釈できなければ最適化を止める |
| 条件付き合成、shorthand、logical property | 定義した後勝ち・条件・順序を維持 | 保持できないケースはbuild error |
| UnoCSS responsive / supports / layer | wrapper、詳細度、宣言順を保持 | parseが途中で止まった出力を成功にしない |
| unknown class / 有限utility / 無限の動的utility | user classは保持、有限utilityはbuild時に解決 | 不確定utilityはsafelist等の明示契約に従って診断 |
| 不正custom property / 異なる内容の同一hash | 成功成果物なし | diagnostics設定に依存しない衝突error、既存の入力境界検証 |
| theme/config変更 / style削除 | 新世代CSSと依存関係だけを利用 | 古いmemo・CSSを継続利用したら失敗 |

すべてのfixtureでmodule間共有、実assetの所有者、source位置のdiagnosticまで確認する。HTMLだけのsnapshotやIRのhash一致を最終表示の代用にしない。

### G1: route初期描画の範囲をQwik標準処理へ渡すPoC

`useStyles$` 等のQwik標準style hookをcompilerがcomponent境界へ生成し、実際のrenderに応じて必要なCSSだけを標準処理へ渡す方式を検証する。現行のmodule先頭へのCSS side-effect importは不具合再現の対照として残す。SSR済みstyleとclient初出styleの管理はQwikへ委譲し、現行beta.43でのasset再利用・共有化・コード量を実験で証明する。

PoCはroot layout、2 route、共有component、クリック後のlazy、nested lazy、同一module内の複数component、条件付きstyleを含める。出力先がCSSファイルかCSS文字列を返すhash付きQRL JSかを明記する。後者はCSS parseに加えてJS取得・parseが必要なため、その費用も測る。

確定方針を満たすloweringを1つ採用する。標準APIだけでキャッシュと必要な遅延境界を両立できなければ、Qwik側の不足APIと最小再現を整理し、上流対応または対応版の条件を計画に追加する。独自client loaderで穴埋めしてR7を満たしたことにはしない。`cssCodeSplit` やinline閾値はQwik標準設定を維持し、その状態のresolved configと出力を確認する。

### G2: chunkingは最終配信に反映できる単位で設計する

IRのsemantic identityとdelivery membershipを分離する。共有atom/globalの所有先を1か所に寄せることと、極小requestを増やさないことを両立させる。QRL/async境界をまたぐ強制mergeはしない。小さな重複を残す方が実通信費用が低い場合は、理由とbytesをmanifestに明記する。

`routes` のstatic/dynamic到達情報を分離し、root/layout/group/index/dynamic routeなどQwik Routerの実graphに合わせる。手作業のfilesystem推測を実配信の真実として使わない。plannerが制御できない設定はanalysis-onlyと明示するか、非推奨化する。

## 5. 実行マイルストーン

各項目は未完了。前段の証拠が揃うまで、後段の最適化で結果をごまかさない。

### M0: 再現可能な基準とテストの復旧

**対象:** `fixtures/lifecycle/e2e/*`、`scripts/size-report*`、`benchmarks/*`、両consumerの依存manifest。

**作業:** 本書のF1/F2を独立した失敗fixtureに固定する。欠落SSGテストを復旧し、inline/link両形式の実効styleを検証する。URL名の部分一致を廃止し、style所有情報と実requestを対応づける。Qwik/pnpm/Node/Vite/Vite Plus/UnoCSSの解決版と候補tarball digestを保存する。SSG検証後にlive SSRを走らせる順序を固定する（`serve-live.mjs` はSSG HTMLを削除する）。

**受入れ:** 全テストが列挙され、必須suiteの0件・skipは失敗。F1/F2は期待どおり失敗する再現テストとなる。旧計測値から現行版への比較はschemaを区別する。

### M1: CSS意味保存と動的値の修正

**対象:** `packages/core/src/{units,atom,parametric}.ts`、`packages/qwik/src/{object,template,compose}.ts`、`packages/vite/src/index.ts`。

**作業:** 動的値の単位規則を統一し、評価は1回、signal追跡は維持する生成式へ変換する。引用文字列・escape・URL・custom propertyの正規化をtoken単位で扱う。parametric fallbackとcontextのidentityを修正する。shorthand/longhand、logical/physical、important、fallback宣言、selector/context、keyframesについて現状の意味保存範囲を表にする。対応不能時は既存のfail-closedを守る。

**受入れ:** width 100→101でcomputed widthが100px→101px、opacity等のunitlessと文字列値も正しく更新。通常CSS版とSSR/SSG/resume後の表示が一致。CSS rule・style tag数は更新回数に比例して増えない。qstyle runtime importを追加しない。

### M2: UnoCSS経路の契約を統一

**対象:** `packages/unocss/src/{plugin,resolve,parse,tokenize}.ts`、同tests、`docs/unocss.md`。

**作業:** alias/virtual CSSにもcollision registryを適用する。theme/configの依存変更を追跡しキャッシュの世代を入れ替える。`:where→:is` の回避策を置き換え、layer順とglobal preflightを決定論的に出す。verbatimのwrapper保持と完全parse判定を修正する。global/theme/@property/keyframesの重複と所有を明示する。config失敗、unknown utility、非対応dynamic syntaxの診断を分ける。属性順の契約と文書を統一し、sourcemapとbindingの安全性も確認する。

**受入れ:** config変更を再起動せず反映。衝突fixtureは全モードでfail-closed。`preserveClass`有無、preflight、dark/theme、responsive、group/peer、arbitrary values、shorthand順序で公式UnoCSS版との表示が一致。global削除・ファイル削除で古いCSSが残らない。

### M3: Qwik native配信PoCと方式確定（G1）

**対象:** 新規の小さなdelivery fixture、`packages/vite/src/index.ts` のproduction lowering、必要に応じて `packages/qwik` のbuild専用export。

**作業:** G1のPoCを実施し、optimizer前後のcode、最終asset、Qwik manifest、初期HTML、networkを保存する。routeごとに初期renderするroot/layout/page/componentと必須global依存の期待集合をfixtureに定義する。スタイル依存がsource module先頭ではなく実際の使用境界に付くことを確認する。SSRで使用したスタイルのidentityをresumeが再利用することを検証する。

**受入れ:** 各routeの初期payloadがその初期renderと必須global依存に対応し、未表示lazyと別routeの固有CSSを含まない。共通layoutのCSSは両routeで利用できる。Qwik標準設定のままSSR/SSGのstyle供給が成立し、初出renderでFOUCがなく、再表示で重複取得・注入しない。初期render済みcomponentのresumeはCSSを再取得しない。対応するQwik版とAPIが明記される。成立しない条件を隠さず、上流対応の有無を決定する。

### M4: 実配信を対象とする共有化・分割・hash（G2）

**対象:** `packages/core/src/{chunk,usage,manifest,cache,dedup}.ts`、Vite収集・emit・dedup、UnoCSS global出力。

**作業:** M3の配信単位にusage graphを接続する。unitごとのownerと共有依存を生成する。post-hash本文変更を排除するか、最終digestと参照が整合するbundler hookへ移す。manifestにunit/pack/assetを区別して記録し、ファイルサイズはUTF-8 bytesで測る。build環境間の収集状態を分離し、SSR-only/client-only/style削除を扱う。

**受入れ:** chunking設定が意図した実assetへ反映される。全assetで重複とownershipを説明できる。同じinputから異なるroot・探索順でも同じ出力。1 routeだけの変更で無関係な配信単位のURLを変えない。同じURLで異なる最終本文を出さない。HTML/manifest参照先の存在を全件検証する。

### M5: devのstateを保つHMR

**対象:** Viteの `refreshDevCss` / dev alias / module graph、UnoCSS config更新、専用browser HMR fixture。

**作業:** CSS-onlyとQwik再renderが必要な変更を区別し、native HMR更新完了とCSS依存更新を協調させる。700msの固定timerを成功経路から除く。stable aliasとCSS ownershipを見直し、上流変換を省略しない。保存世代を識別し、遅い旧transformが新CSSを上書きしないようにする。

**受入れ:** 色・値・宣言増減・style新設/削除・隣接要素挿入・動的分岐・UnoCSS theme変更・連続保存・エラー修復でnavigation 0件。counter、入力、focus、scrollを維持する。Qwik自体が非対応の構造編集は最小再現と対応境界を明示し、通常のCSS編集のfull reloadで隠さない。

### M6: 2つのconsumerとデプロイ条件の検証

**対象:** `../qwik-on-viteplus`、`../haven-web` のpackage/lock/config、Cloudflare adapter、`public/_headers`、entry/root/router head。

**作業:** 同じ候補commitから作ったpackage tarball一式を両consumerで使い、通常CSS版／qstyle版／UnoCSS版を比較する。旧runtime export・旧backendコメントを整理する。Vite単体とVite Plus + Cloudflare adapterのresolved config差を記録する。CSSとQRL JS双方の実asset pathにheadersが適用されることを確認する。

**受入れ:** dev、build、local preview、SSG fixture、live SSRで表示・resume・navigationが一致。公開package export経由でもbuild可能。ステージングでhash assetのimmutable、圧縮、MIME、HTMLの更新、旧asset保持、404時の再試行を確認する。今回の作業にはdeployを含めない。

### M7: 性能予算と継続検証

**対象:** `scripts/size-report*`、`benchmarks`、CI設定、release docs。

**作業:** 次節の計測schemaを実装し、基準を同環境の繰り返し測定から固定する。`--compare` と失敗判定を分け、予算超過・測定漏れで非zero exitにする。small fixtureだけでなくhaven-webと大規模生成fixtureを測る。理論上の削減より実転送・描画の改善を優先する。

**受入れ:** PRで意味保存、browser matrix、遅延・キャッシュ契約、性能予算を自動検証。LCP等の外的変動を伴う指標は分布と測定条件を保存し、単発の差で採否を決めない。

依存順: M0 → M1/M2 → M3 → M4 → M5/M6 → M7。M0での計測整備は継続する。M1/M2の独立箇所は別担当で並行可能だが、共通serializerとVite loweringは同一責任者で統合する。

## 6. デプロイ後の性能を測定・改善する範囲

| 領域 | 測るもの | 改善候補と採用条件 |
| --- | --- | --- |
| 初回転送 | HTML内CSS、外部CSS、QRL内CSS、class/style属性、関連JSのraw/gzip/Brotli bytes | 初期renderに不要なCSSを外す。外部化によるRTT増とHTML削減を比較 |
| 分割と共有 | route/component別の必要bytes、不要bytes、重複bytes、request数 | 小さすぎるchunkを同じ需要境界内でmerge。初期とlazyは安易に混ぜない |
| 再訪・遷移 | warm cache時の実転送、304、disk/memory cache、CSS再挿入 | hash assetを長期cache。SSR埋め込み分はHTML転送として別集計 |
| 更新時cache | 無変更build、1値変更、1route追加時にURLが変わる総bytes | 小さく安定した所有単位。グローバルpack変更で全ページ無効化しない |
| 描画待ち | CSS発見時刻、依存chain、FCP/LCP、FOUC、CLS | 初期必須CSSを先に利用可能にする。prefetch/preloadは必要と実測できたものだけ |
| JSとresume | qstyle由来client bytes、QRL parse/eval、serialization量、再render | authoringコードの消去、静的class化、finite branchの事前計算。巨大な生成分岐を避ける |
| 動的値 | 1/100/1000回更新後のstyle/rule数、更新時間、INP | 変数更新だけに限定。inheritanceによる広いstyle invalidationをtraceで確認 |
| CSS計算 | rule数、selectorの複雑さ、style recalculation、layout、paint | 長大なselector listや広域selectorのmergeは表示処理が悪化すれば採用しない |
| 配信基盤 | TTFB、Content-Encoding、Content-Type、Cache-Control、ETag、CF-Cache-Status | 既存のimmutable設定を実responseで確認。static assetのための不要なWorker処理を避ける |
| アプリの他要因 | image/font/JSの転送量とLCP寄与 | CSS改善と分けて帰属。大きな画像・font等はtraceで支配的と判明した場合に対応 |
| build/dev | transform p50/p95、総build時間、peak RSS、HMR latency、cache hit | parser/UnoCSS memoの再利用。ただしconfig変更時の失効とメモリ回収を優先 |

両consumerには `/assets/*` と `/build/*` の `Cache-Control: public, max-age=31536000, immutable` が既にある。未設定と断定しない。実際のQwik出力にそれ以外のhash付きJS URLがある場合は適用範囲を確認する。Worker生成responseには `_headers` が自動適用されないため、SSR HTMLとstatic assetを分けて観測する。

`qstyle-manifest.json` はruntimeが使わないdebug metadataで、CSS全文も含む。qwik-on-viteplusの `public/.assetsignore` は除外済み、haven-webは `_worker.js` だけを除外している。manifestをbuild report用の出力に分け、公開assetへ含める必要性を見直す。これは主にupload/storage/解析コストの改善であり、browserが取得しない限り初期転送の削減には数えない。

デプロイ切替では新assetを先に利用可能にし、新HTML/manifestとの組を揃える。旧HTML・長時間開いたタブのQRL参照が切れない保持期間を定める。HTMLはimmutableにせず、公開SSG・公開SSR・利用者固有SSRのcache policyを分ける。hash変更時に全asset cacheをpurgeする運用は避ける。

### 計測条件と予算

最低限、home直接アクセス、別route直接アクセス、A→B→A、lazy表示→非表示→再表示、SSR→resume→signal更新、cold→warm、旧deployのtab→新deployを測る。JS無効の初期表示も含める。

同一のbrowser/viewport、モバイル相当CPU・network条件、圧縮設定、prefetch設定を記録する。ローカル比較は各条件5回以上の中央値とばらつきを保存し、実デプロイは実利用の75パーセンタイルを別管理する。LCP ≤ 2.5秒、INP ≤ 200ms、CLS ≤ 0.1はサイトの目標であり、qstyle単体の達成保証ではない。

固定の正しさ予算は、未表示lazy固有CSSの初期混入0、独自client CSS engine 0、通常編集のdocument reload 0、runtime更新によるstylesheet増加0、hash identity不一致0、成果物への未解決css prop 0とする。bytes/request/time予算はM0/M3の実測から決める。旧 `maxInitialCssRequestsPerRoute:5` は暫定参考値であり、inline CSSを0 requestとして通す評価にしない。

## 7. 実行コマンドと今回の検証結果

作業ディレクトリは特記しない限り `/Users/ama/qstyle`。Node 26.8.2 / pnpm 12.2.1を使用。今回のshellはNode/pnpmが通常PATHになかったため、以下のprefixを付けて実行した。

```sh
export PATH=/Users/ama/.local/share/mise/installs/node/26.8.2/bin:/Users/ama/Library/pnpm:$PATH
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
cd fixtures/lifecycle
node scripts/build.mjs
cd ../..
pnpm exec playwright test -c fixtures/lifecycle/e2e/ssg.config.ts --list
pnpm exec playwright install chromium --only-shell
pnpm exec playwright test -c fixtures/lifecycle/e2e/playwright.config.ts --project=chromium
node scripts/size-report.mjs fixtures/lifecycle/dist
```

| 実行 | 今回の結果 |
| --- | --- |
| frozen install | 成功。lockfile変更なし |
| package build | 全5package成功、publint成功。CJS/mixed exports警告あり |
| `pnpm test` | core149、qwik120、vite236、unocss65、inspector13、size-report5成功 |
| typecheck | 全5package成功 |
| lifecycle build | 成功、SSG 4ページ生成 |
| SSG suite列挙 | 失敗、0 tests。指定testファイル欠落 |
| Chromium browser matrix | 16件中12成功、4失敗 |
| サイズ計測 | CSS 1ファイル、887 bytes、gzip512 bytes。unit metadata20件、module8件 |

browserの4失敗の内訳は、F1の幅更新失敗、F2のlazy CSS取得期待失敗、inlineなのにlinkを要求する2件。lazy test自身もURLフィルターが古いが、別途CSSOM・HTML・全stylesheet requestを調べてF2を確認した。最初のbrowser起動は対応実行ファイル未導入で失敗し、Chromium headless shell導入後に上記結果を得た。

raw CSSの現在値は [audits/2026-09-11-lifecycle-size.json](audits/2026-09-11-lifecycle-size.json) に保存した。gzipはローカルzlib計算でありCDN応答の圧縮率ではない。`packCount:20` は現行reportの定義上unit件数を数えており、実配信pack20個を意味しない。live SSR試験が削除したSSG HTMLは最後に再buildして復元した。

実装後は上記に加えてSSG suite本実行、Firefox/WebKit、baseline differentialを必須にする。

```sh
# SSG build直後、live SSR試験より先に実行
pnpm exec playwright test -c fixtures/lifecycle/e2e/ssg.config.ts
# 必要なブラウザを導入したうえで全project
pnpm exec playwright test -c fixtures/lifecycle/e2e/playwright.config.ts
# 独立baselineを生成・buildしてから比較
cd fixtures/lifecycle
node scripts/gen-baseline.mjs
cd baseline
QSTYLE_SSG=0 node scripts/build.mjs
cd ../../..
pnpm exec playwright test -c fixtures/lifecycle/e2e/differential.config.ts
git diff --check
```

baseline生成がqstyleのserializerを再利用すると同じバグを共有するので、基準となるCSSは独立に期待値を定義する。consumerでは各ディレクトリで `pnpm install --frozen-lockfile`、`pnpm run build`、`pnpm run check`、`pnpm run dev` / `pnpm run preview` を用いる。`deploy` scriptはこの分析の検証コマンドには含めない。

## 8. ロールバック・完了条件

修正は意味保存、UnoCSS、配信、HMR、consumer、計測の独立した変更に分ける。新仕様ではlegacy配信profileを製品に残さず、hash変更も同じ1.0移行へ含める。衝突検出は維持する。比較用の旧版fixtureとrelease一式のrollbackを用意し、旧版での成功を新版の合格に数えない。

build失敗時はstaging出力を公開対象にせず、前回の成功artifactを保持する。再試行は候補commit・lockfile・configを固定し、調査用fixtureだけの出力を再作成する。consumerのlockfileやユーザー変更を一括resetしない。大域cacheとHMR timerはserver終了・build開始・config世代交代で掃除する。

完了と呼べる条件は、R1–R8の対応表にすべて証拠があること、2consumerが同じ候補版で通ること、実配信の遅延・cache・state保持をbrowserで確認できること、文書と公開optionが実装に一致すること。未対応構文、Qwik upstream待ち、未測定host条件は残件として明示し、unit test成功だけで完了としない。

## 9. 外部仕様の確認先

参照日: 2026-09-11。Web資料は設計の根拠に用い、実際の対応版の挙動はlockfileと成果物で確認する。

- [Qwik Styles](https://www.qwik.dev/docs/core/styles/): SSR時のstyle供給とclient初出時のstyle取得。component境界での管理方針の根拠。
- [Qwik Optimizer](https://qwik.dev/docs/advanced/optimizer/): QRL境界の設計。source module importとの混同を避ける。
- [Vite build.cssCodeSplit](https://vite.dev/config/build-options.html#build-csscodesplit): async CSS分割の一般仕様。Qwikによるresolved configを別に確認する。
- [Vite Plugin API](https://vite.dev/guide/api-plugin.html): HMR/module graph/bundle hookの対応版確認先。
- [StyleX Thinking in StyleX](https://stylexjs.com/docs/learn/thinking-in-stylex/): 決定論的な競合解決とbuild時最適化の参考。cross-file合成等のruntime条件はqstyleの目標と区別する。
- [MDN HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching): hash URLとimmutableの使い分け。
- [Cloudflare Static Assets headers](https://developers.cloudflare.com/workers/static-assets/headers/): `_headers` のstatic asset適用とWorker生成responseの扱い。
- [Web Vitals](https://web.dev/articles/vitals): LCP/INP/CLSの目標と実利用データの評価方法。
