# Qstyle 1.0 native style compiler — 実装仕様

2026-09-11。状態: **実装中。進捗・未達gateはPLANS.mdを参照。公開entryは未切替**。

本書を、[調査・性能計画](architecture-performance-plan.md) の実装判断を具体化した最新版とする。旧API、生成class、hash、manifest、設定の互換性は維持しない。以前のPLANS.mdは完了した安全性修正の記録であり、旧hashを維持する制約や移行用warning modeを新設計へ引き継がない。衝突検出・入力検証・fail-closedの目的は維持する。

## 1. 完成の定義

1. routeの**実際の初期render**に必要なCSSを、Qwik標準のstyle処理でSSR/SSG出力する。未表示component、別route、まだ選択されていない構造分岐の固有CSSは含めない。
2. CSSのselector、条件のネスト、cascade、動的値の意味を保持する。共有化による意味変更は許さない。
3. 取得、SSR style再利用、resume、navigationはQwikへ委譲する。qstyleのclient parser、registry、loader、監視コードは0。
4. 通常のstyle編集はページreloadなしで反映する。入力値・signal・focus・scrollを保持する。
5. hash確定後に内容を変更しない。最終URLのhashはbundlerが決定し、qstyleのIR hashとは区別する。
6. 初期HTMLに埋め込んだpackを同じQwik containerで再利用する。SPAでの別pageと後からrenderするcomponentは、既存packのCSS本文を再取得・再挿入しない。現行Qwikには新instanceでstyle QRLを先に解決する経路があり、取得前guardをQwik側で実現することが新たな前提条件（§7）。
7. サイト全体のqstyle管理対象を一度に解析し、同じ意味の宣言を一つの共有定義へ集約する。重複を許容する旧方針を撤廃する。生成classは§6の有限な変換モデルで最小性を証明し、近似解を「最小」としてreleaseしない。

初期render済みの画面外要素、pseudo state、media、theme条件は必要CSSに含む。「現在見えるpixelだけ」のcritical CSS抽出は行わない。Qwikのprefetchが先行取得する場合は、prefetch無効時の配信契約と有効時の実用測定を別に判定する。

**制約と最適化:** 意味保存・SSR/resume・render需要に応じた配信・宣言重複ゼロを必須制約とする。その条件下で生成class数→class割当数の順に最小化する。総転送量・cache・build速度も別gateで判定し、最小class解でも性能gateに落ちればreleaseしない。CSS bytesだけ小さくしてHTML/QRL JSを増やす変更を無条件には採用しない。

## 2. 破壊的変更を確定する

| 項目 | 1.0の決定 | 移行方法 |
| --- | --- | --- |
| リリース | 全公開packageを同じ1.0.0 prerelease系列へ揃える | consumerを一括更新。旧版と新版の生成物を混在させない |
| 配信backend | Qwik nativeのみ | 旧CSS side-effect import、独自link/runtime経路を削除 |
| 公開class | `q1_` + 32桁hexの128-bit digest | class文字列を利用者が永続化・参照しない |
| 型とcompiler | authoring型とbuild compilerを分離 | `@qstyle/qwik`のlower関数importを新compiler APIへ移す |
| 診断 | 未対応・不正入力はdev/buildともerror | `silent`、warning-only、legacy fallbackを削除 |
| 優先順位 | utility → css配列の左から右 → 明示style属性 | JSX属性の記述順による差を廃止 |
| UnoCSS | qstyle内の単一adapter。styling専用utility名は生成classへ統合 | DOM/APIとして使うanchorだけ保持。alias生成、`preserveClass`分岐、別のJSX transformを削除 |
| route計画 | 配信の決定には使わない | route情報はreportに限定。render ownerが配信を決める |
| manifest | report専用schema v1 | clientは読まない。旧schemaの互換readerなし |
| package形式 | ESMのみ、明示的なtypes/import exports | CJS呼び出し側はESMへ移行 |

旧optionは無視せず `QS1001 REMOVED_OPTION` と置換方法を出す。上表のerrorは静的に判定できる不正入力・未対応構造を指す。実行後に初めて不正になるslot値は§8のruntime契約に従う。検証用の旧実装baselineはfixtureとして残せるが、製品にlegacy modeを残さない。

## 3. 公開APIと受理範囲

```tsx
import { component$, useSignal } from '@qwik.dev/core';
import { css } from '@qstyle/qwik';

const card = css({ padding: 12, '&:hover': { color: 'navy' } });
const selected = css({ outline: '2px solid navy' });

export const Card = component$(() => {
  const width = useSignal(100);
  const active = useSignal(false);
  return <div class="rounded" css={[card, active.value && selected,
    { width: width.value }]} style={{ '--user-token': 'ok' }} />;
});
```

`css()`とtagged templateはcompile-time macro。runtimeに残った呼び出しは小さなthrow-only stubで明示的に失敗させるが、正常なclient bundleからはstubも除去する。handleはopaque型とし、atoms等の内部IRへ利用者がアクセスできないようにする。

- module scopeの`const`、同module参照、静的な`.qstyle.ts` import/re-export、静的spread、配列、条件選択をbindingに基づき解決する。任意のJSをbuild時に実行しない。
- Qwik `component$` callback内のJSXを対象とする。componentの外の任意関数がJSXを返す場合は、その関数をcomponent境界へ移す診断を出す。名前の文字列一致ではなくimport bindingで認識する。
- runtime式は宣言値、booleanによる既知handle選択、有限の既知class選択のみ。runtime property名・selector・at-rule・任意style object戻り値はerror。
- css handleをobject fieldへ保存、関数へ渡す、QRLにcaptureする、外部ライブラリへexportする等のescapeはerror。`.qstyle.ts`間の静的再exportは例外としてcompilerが解決する。
- `css` propとclass/styleのmergeはcompilerが所有する。値は元のJS評価順に一度だけ評価し、評価後のCSS適用順は上表で固定する。副作用のある式を複製しない。
- classの動的値は有限集合を証明できるconditional/templateだけ対応する。無限集合になるutility組立てはerror。通常の外部classはそのまま保持し、qstyleとの競合は通常CSS cascadeに従う。
- JSX spreadはbindingから内容・順序を確定できるものだけ展開する。未知spreadがclass/style/cssを書き換える可能性があればerror。

```ts
// vite.config.ts — 新API案。既存APIが使えるという意味ではない。
import { qstyle } from '@qstyle/vite';
import { unocss } from '@qstyle/unocss';

qstyle({
  utilities: unocss({ configFile: './uno.config.ts' }), // 省略可能
  report: { file: '.qstyle/report.json', sources: false }, // 省略可能
});
```

optionは上記2つのみで開始する。hash、配信backend、診断強度、CSS分割、inline閾値、strict/safe profileは公開optionにしない。qstyleのsource transformはQwik optimizerより前に実行する。登録順が不適切なら起動時error。Qwikの`cssCodeSplit`と`inlineStylesUpToBytes`は変更しない。

「後勝ち」は同じcascade条件での合成順を意味する。utilityの`!important`を通常のcss宣言で打ち消す等、CSSのimportance・specificity・layer規則を破壊しない。明示style属性もstylesheetのimportant宣言には従う。

## 4. Packageとファイルの責務

以下の新ファイル名を実装タスクの境界とする。既存の同等関数は移動後に旧exportを削除する。

| Package / path | 責務 |
| --- | --- |
| `packages/core/src/ir.ts` | framework非依存IR型。ASTやViteをimportしない |
| `packages/core/src/canonical.ts` | 構造のcanonical encoding、意味のある順序の保持 |
| `packages/core/src/identity.ts` | namespace/version付きhashとcollision registry |
| `packages/core/src/serialize.ts` | CSS ASTからlosslessなCSS出力 |
| `packages/core/src/cascade.ts` | 重複削除可能性、競合順序の証明 |
| `packages/core/src/declarations.ts` | サイト全体の意味付き宣言辞書と参照 |
| `packages/core/src/class-cover.ts` | 有限class候補列挙・厳密最小化・最適性結果 |
| `packages/core/src/verify-cover.ts` | coverage/余分な適用/重複定義の独立検証 |
| `packages/core/src/units.ts` / `safety.ts` | 値・単位・名前検証の単一契約 |
| **新** `packages/compiler/src/parse.ts` | Babel TS/TSX parserとsource位置 |
| `packages/compiler/src/bindings.ts` | import/scope/const解決、escape検出 |
| `packages/compiler/src/evaluate.ts` | 制限付き静的評価。任意コード実行禁止 |
| `packages/compiler/src/lower.ts` | object/template → ordered CSS IR |
| `packages/compiler/src/owners.ts` | render境界・分岐・rule依存 |
| `packages/compiler/src/compose.ts` | utility/css/styleの合成、動的slot |
| `packages/compiler/src/transform.ts` | ASTに基づく編集とsource map |
| `packages/qwik/src/index.ts` | authoring API、opaque型、throw-only stub |
| `packages/vite/src/graph.ts` | build/dev単位のmodule graph・reverse deps |
| `packages/vite/src/native.ts` | Qwik標準style ownerの仮想TSX module |
| `packages/vite/src/hmr.ts` | native依存のinvalidateと世代管理 |
| `packages/vite/src/report.ts` | 最終bundleを観測してreport出力 |
| `packages/vite/src/index.ts` | plugin hook接続のみ |
| `packages/unocss/src/adapter.ts` | token集合 → 公式generator → CSS AST |
| `packages/inspector/src/index.ts` | 新report schemaの読取 |

JS/TS parserは`@babel/parser`、scope traversalは`@babel/traverse`、node型は`@babel/types`を直接依存にする。編集は`magic-string`で元source位置へ適用しsource mapを維持する。CSSは`postcss`、selectorは`postcss-selector-parser`、valueは`postcss-value-parser`を直接依存にする。transitive dependencyの偶然の存在に依存しない。手書きの括弧探索・JSX scannerとregexでのCSS意味変換は廃止する。

## 5. 中間表現と正規化

```ts
type Wrapper =
  | { kind: 'media' | 'supports' | 'container'; params: string }
  | { kind: 'layer'; name: string };

type Value =
  | { kind: 'static'; css: string }
  | { kind: 'slot'; index: number; unit: 'length' | 'unitless' | 'raw';
      fallback?: string };

interface Rule {
  selector: SelectorAst;             // &を含む構造。単なる文字列置換は禁止
  wrappers: readonly Wrapper[];      // 外側→内側。同種の条件も複数保持
  declarations: readonly {
    property: string; value: Value; important: boolean;
  }[];                              // 重複propertyと順番を保持
  orderDomain: string;              // 並べ替えが許される範囲の識別子
  dependencies: readonly string[];   // keyframes/global等
  source: SourceSpan;               // 診断専用。content identityから除外
}

interface RenderOwner {
  id: string; module: string; boundary: SourceSpan;
  ruleIds: readonly string[];
  children: readonly string[];
  demandSites: readonly {
    id: string; renderPath: string; styleState: string;
    lazyBoundary: string; predicate: StaticPredicate;
  }[];                              // component単位より細かい実際の需要境界
}
```

実装では`SelectorAst`と`SourceSpan`を明示定義し、第三者parserの可変nodeをIRに直接保存しない。global、font-face、property、keyframesは別のtagged unionにする。解釈できない構文を`residual`文字列として成功扱いしない。

canonical encodingはversionを先頭に置いた固定field順の配列形式を使う。object key列挙順や絶対pathをidentityへ入れない。一方、宣言順・selector list順・wrapper順・keyframe内順序は保存する。空白を全体置換しない。`content:"a  b"`、escape、URL、custom property token列はparseした意味と元表記を保存する。

`@media A { @media B { ... } }`をscalarのmedia fieldに潰さない。`@supports`/`@container`/`@layer`の交互ネストも同様。`:where()`を`:is()`へ変換しない。anonymous layer、`@scope`等の未対応構文は対応fixtureが揃うまでerror。top-level `@import`はqstyle入力ではerrorとし、通常のCSS entryで管理する。

初版のcanonical化は保守的に固定する。node種別・propertyのcamelCase→kebab-case・数値単位・宣言区切り・ブロックのindentは構造として正規化する。selector、条件params、string、URL、custom propertyを含むvalueのtoken綴りとtoken間空白は保持し、そのままhashへ入れる。quoted escapeを別表現に書き換えない。valueの外にある純粋な整形空白・コメントだけをidentityから除く。value内のコメントはtoken境界を変え得るため保持する。

したがってJSXのindent/source行変更はrule hashを変えないが、CSS value内の無害に見える表記変更はhashを変えてよい。意味的に同値なすべての表現を一つのhashにする保証はしない。serializerは宣言を`property:value;`、blockを`selector{...}`、wrapperを`@kind params{...}`で決定的に出力し、value tokenの内部には触れない。rule hashはこの構造、pack hashはこのserializerの最終bytesに依存する。D1にindent不変・コメント位置・escape保持・二重空白・custom property・pack再現性の期待hash fixtureを追加する。

### Hash契約

`digest = SHA-256(UTF8(namespace + NUL + canonicalVersion + NUL + payload))` の先頭16 bytesを小文字hexにする。namespaceは`rule`、`slot-schema`、`keyframes`、`pack`等で分ける。実装はNode cryptoをbuild側からのみ使う。

- classは`q1_<digest>`、変数は`--qstyle-1-<slot-schema-digest>-<index>`、animationは`qk1_<digest>`。
- hashに入れるもの: selector/wrappers、宣言順、important、静的値、slot schema、CSSに残るfallback、cascade domainの意味。
- 入れないもの: 実行時slot値、source line、絶対path、build timestamp、collection到着順。
- 同じIDに異なるpayloadが入れば必ずbuild error。test用hasher注入で衝突を再現する。digestが長くても検出を省かない。
- pack hashは最終CSS textと依存identityから求める。URLはこのhashを手で付けず、Qwik/Viteが最終JS/CSS内容から決める。

## 6. サイト全体の宣言共有・クラス最小化・pack

### 重複ゼロの対象

一つのbuild graphに入る全route/layout/component、静的import可能なstyle、UnoCSS出力を先に収集する。各ファイルで独立にclassを決定してから連結する方式は廃止する。最適化の入力はサイト全体、配信の入力は実際のrender需要とする。

宣言identityは `property + canonical value/slot schema + important + ordered wrappers + relative selector condition + cascade semantics`。生成class名・owner・route・source位置はidentityに入れない。たとえば、通常時とhover時、異なるmedia/layer、異なるfallbackの`color:red`は異なる意味の指定であり、raw文字列が同じだけで一つに潰さない。source順を表す任意のIDを付けて重複を別物として隠すことも禁止する。

同じ宣言identityの**論理定義と独立した配信用payloadは一つ**にする。別selectorへ同じ宣言が必要ならselector listを統合する。通常のCSS cascadeを再現するために必要な順序制約は別graphで保持し、勝手に宣言を並べ替えない。重複を消して意味を保持できない入力はQS1601でerrorにし、重複blockを残して成功させない。

任意のCSSの意味同値性まで判定する保証ではない。§5のcanonical表現が一致する意味付き宣言が対象。通常の外部CSSやthird-party stylesheetがcompilerの外にある場合、サイト全体の保証範囲には入らない。reportに未管理stylesheetが一つでもあれば`wholeSiteGuarantee:false`とし、サイト全体の重複ゼロをrelease条件にするconsumerでは検証を失敗させる。対象外を黙って除外しない。

SSGの複数HTMLに同じ初期CSSが埋め込まれること、SSRの別requestが同じCSSを返すこと、SSR inline表現とclient用QRL表現がそれぞれ存在することは、transport上の表現の反復である。一つの定義・packから生成し、集計は別にする。「全出力ファイルを連結して同じ宣言文字列が1回だけ」と「各HTMLが初期CSSを自足する」は同時には要求しない。

### クラスと配信単位を分離する

1宣言1class、1component1class、1pack1classのいずれにも固定しない。classは「どのスタイル集合を要素へ適用するか」、packは「どの宣言をいつ配信するか」を表す別の軸とする。

```css
/* A: color:red + padding:8px、B: color:blue + padding:8px */
/* 初期Aから必要な共有pack */
.q1_A,.q1_B{padding:8px}
/* Aだけが要求するpack */
.q1_A{color:red}
/* Bが初めてrenderする時のpack */
.q1_B{color:blue}
```

上のsuffixは説明用。実際は128-bit hashを使う。共有paddingの指定は一度、各要素の生成classは一つ。Bのclass名が共有selectorに現れてもB固有のblue宣言は先行配信しない。初期混入試験は未来のclass名の存在だけで失敗させず、固有の宣言identityを検査する。

### 最小化する量を固定する

第1目的はサイト全体の**生成class種類数K**、第2目的は列挙した各要素style状態への**class割当総数T**。同じK/Tならserializer bytes、最後にcanonical辞書順で決定する。実DOM instance数はrequestごとに変わるため、Tはbuild時の一意なstyle状態を同じ重みで一度ずつ数える。reportには各状態のclass数・最大数も出す。

小規模の集合モデルを独立全探索して確認した例は、`{padding,red}`と`{padding,blue}`が`K=2,T=2`、`{red}`・`{padding}`・`{red,padding}`が`K=2,T=4`。これは算法の例の確認であり、未実装compilerやCSS意味保存の検証ではない。後者を状態ごとに1classにするとK=3になり、第1目的に反する。

「各要素が常に1class」とは約束しない。例えば複数の基底styleの組合せでは、状態ごとに1classを作るより少数の基底classを組み合わせる方がKを小さくできる。最適化対象はclass selectorで表現する受理済みstyleモデルに限定し、全指定をstyle属性/data属性/IDへ移してclass数0とする抜け道は禁止する。利用者がDOM APIとして保持するclassとgroup/peer anchorは固定の外部制約として別集計する。

### 厳密なclass cover

1. 各要素の有限なstyle状態を列挙し、条件・値の評価順を保った合成後の`State_i={S_i,P_i,selectorConstraints,demandSite}`を作る。`S_i`は宣言集合、`P_i`は保持すべき順序のpartial-order graph。集合が同じでもP_iが違えば状態を統合しない。runtime値そのものは列挙せずslot schemaを要素として扱う。
2. canonical宣言の競合と順序制約を検証する。単純な上書きを意味保存で除去した後、宣言一回出力に必要な全P_iのunionに循環があればQS1601。topological orderをcanonical辞書順で一意に決め、候補・割当・最終出力のverifierすべてが各P_iの辺を守ることを検証する。順序制約をclass IDで別物へ変えて循環を隠さない。
3. 完全候補の基準を「各S_iの空でない全subsetの和集合」とする。集合をbitsetで保持して重複を除く。selector/cascade制約のない純粋なunion-cover領域だけは、最適解がintersection closureに必ず存在することを証明・試験した上で共通部分列挙へ縮約してよい。追加制約がある領域は全subsetから安全な割当を列挙する。不安全な最大共通部分を捨てるだけでproper subsetを落とさない。資源上限に達したらQS1602とする。
4. binary変数`y_j`（class採用）と`x_ij`（状態iへのclass割当）を用いる。`B_j ⊆ S_i`の場合だけ割当可能、`x_ij ≤ y_j`、各`d ∈ S_i`について`Σ[j:d∈B_j] x_ij ≥ 1`を必須にする。selectorの適用先・specificity・順序制約も満たさない割当は禁止する。
5. `(Σy_j, Σx_ij)`を辞書式に厳密最小化する。初版は決定的なbranch-and-boundをbuild側に実装し、有効な下界と暫定上界を保持する。独立した連結成分への分割は、宣言・selector・cascadeの依存がないと証明できる場合だけ行う。
6. 採用した`B_j`の内容をclass identityにする。宣言dのselectorはdを含む採用classのlistへ展開し、dの本文は一度だけ出力する。同じ要素が複数の該当classを持っても同じ宣言を再出力しない。
7. 別のverifierで全状態のunionが`S_i`に一致し、最終宣言列がすべてのP_iを満たし、余分な適用・欠落・順序違反・定義重複がないことを検査する。小規模fixtureは全subsetを使った全探索の独立oracleとK/Tを比較する。

最小性の主張は、宣言集合のunionと上記の固定した順序・selector制約でスタイルを表す有限モデルの範囲に限る。任意のselector書換えや新しいCSS機能の導入まで含めた全CSS表現の数学的最小ではない。intersection縮約を使える条件を明示し、selector/cascade制約を追加した領域へ無条件に適用しない。証明できない縮約を加えて`optimal:true`にしない。

候補数・状態数・探索が増える場合でもgreedy結果へ黙って降格しない。初期実装の資源上限は候補65,536、状態65,536、探索node10,000,000とし、上限を超えたらQS1602を返す。近似結果をreportへ残してよいがrelease buildは失敗する。閾値の変更はcompiler versionとreportへ記録する。最小化の厳密性はbuild時間との交換条件であり、常に短時間で解けるとは保証しない。

### 宣言を一度だけ配信する

各宣言dについて直接需要site集合`Demand(d)`を作る。siteは`owner + JSX render path + 有限style状態 + branch predicate + lazy boundary`で識別する。component名だけで需要を表さない。predicateはcompilerが認識する条件ASTから作り、任意のJS条件の論理同値性は推測しない。同じsite集合かつ安全な順序領域の宣言だけをpackへまとめ、**各宣言は必ず一つのpackにだけ所属**させる。共有packへ将来のowner固有宣言を混ぜない。別route/lazyの利用者も同じpack exportを参照する。

例として同じcomponentの`active ? red : blue`でもtrue状態とfalse状態は別site。red/blueを一つのpackにまとめず、生成したownerを対応する枝でだけrenderする。一方、両状態に共通するpaddingは両siteを需要集合に持つ一つの共有packとする。条件式は§7のとおり一度だけ評価し、class割当とpack選択へ同じ結果を使う。

共有pack間の到着順がcascadeを変える場合は、selectorの対象を区別する意味保存変換か、需要を増やさず成立するpack統合で解決する。それができなければQS1601で失敗させる。遅延を壊す全体pack化と重複出力をfallbackにしない。

global preflight/layer orderはroot所有、font/keyframes等は実際に必要とする宣言からの依存として扱う。globalの同一定義も一つにし、同じ名前の相反する`@property`等はerror。slotの実行時値は各要素のstyle属性へ残り、同じschemaのruleだけを共有する。

## 7. Qwik native loweringと成立性gate

### 基礎方式: 共有するstyle専用component

単純に各componentへ`useStyles$(同じ文字列)`を挿入する方式は採用しない。調査対象Qwik beta.43はstyle identityをQRL hashとhook indexから作る。同じ文字列でもQRL symbolやhook位置が違えば共有にならない。公開されていない`useStylesQrl`へ依存して解決しない。

生成する仮想moduleの概念形は次の通り。

```tsx
// virtual:qstyle/native/<pack-id>.tsx
import { component$, useStyles$ } from '@qwik.dev/core';
export default component$(() => {
  useStyles$('/* このpackの確定CSS */');
  return null;
});
```

消費側はstyle ownerを対象要素と同じrender分岐内で描画する。

```tsx
return <><PackStyle /><div class="q1_..." /></>;
// 条件分岐のCSSは条件が成立した時だけownerをrender
return visible.value ? <><LazyPackStyle /><section class="q1_..." /></> : null;
```

`PackStyle`は全利用箇所から同一exportを参照し、自身の`useStyles$`を常に同じhook位置で呼ぶ。conditional hookを生成しない。要素をDOM wrapperで包まず、Qwik fragment/componentの標準markerを使用する。追加されるmarker・serialization・QRLの費用は0とは扱わない。

**今回の隔離proofで確認済み:** Qwik `2.0.0-beta.43`で同じSharedStylePackを2回SSR renderするとstyle ID `f9ec4h-0`は1件だった。別componentへ同じliteralを書いた場合は`epd1jb-0`と`lrivbd-0`の2件となった。lazy CSSは初期HTMLと初期requestに含まれず、click後に`/build/q-BHqT-JpD.js`から取得され、背景色・borderのcomputed styleが一致した（`preloader:false`）。CSSは独立したCSS文字列QRLへ分割され、追加stylesheet requestはなかった。これは小規模SSR/client proofであり、以下の全gate合格ではない。proofはignoredな`.qstyle/native-plan-proof`で実行したため、D0で再現可能なfixtureとして追跡対象へ移す。

CSS値のみがsignalで変わる場合はslotだけ更新する。既知styleの条件選択は対応するstyle ownerも同じ条件で選ぶ。条件式を一度だけ評価し、その結果をclassとowner選択で共用する。map内では元のkeyとitem scopeを保持する。兄弟挿入が許されない生HTML境界等はdiagnosticにし、DOM構造を勝手に変えない。

loweringの対応形を次で固定し、D0/D2へ各1つ以上のfixtureを置く。

| 元のrender形 | 生成位置 |
| --- | --- |
| 単一DOM要素をreturn | return値をfragment化し、同じ分岐内で要素の直前へownerを置く |
| 既存fragment | 対象要素の直前へ挿入。同一の無条件領域内だけownerをまとめる |
| ternary / `&&` | 条件を外へ移さず、対象の枝の値だけfragment化する |
| 配列literal | 対象要素をkey付きfragmentへ置換。既存keyをfragmentへ移す |
| `map` | arrow callbackのreturn値に同じ変換。item scopeとkeyを保持 |
| null/false | ownerなし |
| Slotまたは他componentへのcss prop | QS1103。DOM対象のwrapperを利用者が明示する |
| 生HTML文字列内部・未知関数のJSX・generator/async callback | QS1103。自動挿入しない |

仮想moduleのimportはsource module先頭へ一度だけ生成し、Babel scopeで衝突しないローカル名を割り当てる。条件をclassとownerで共用する必要がある場合は、最小の対象JSX式を同期arrow IIFEへ包み、元のattribute値を左から右に一度ずつlocal constへ評価してからfragmentを返す。`await`/`yield`を跨ぐ変換は拒否する。構造分岐の条件を重複評価したり、false枝のattributeを先に評価したりしない。Qwikの反応性がこの生成形でも保たれることをD0のsignal更新fixtureで証明し、失敗なら未対応のままにする。生成IIFEも追加JS費用へ計上する。

### D0で必ず通すgate

| 実験 | 合格条件 |
| --- | --- |
| 2 componentが同じpackをrender | SSRとclient初出ともstyle IDは1つ、同内容styleの追加なし |
| consumerのhook数が異なる | 共有style IDが変わらない |
| 同一moduleにvisible/lazy component | lazy ruleが初期HTML/CSSOM/取得QRLにない |
| 同componentの条件分岐 | false枝の固有ruleが初期出力にない。true化時に表示へ間に合う |
| SSR/SSG + resume | 初期computed style正解、resumeでstyle再取得・再挿入なし |
| inline共有pack → 新component instance | 同じstyle IDを使い、CSS本文QRLのresolve/request/再挿入すべて0 |
| route A → B → A（SPA） | 共有pack本文の追加転送0。B固有packだけを初出時に取得 |
| 共有packが最初はlazyで初出 | 初出時1回、以後別ownerから使っても追加取得・追加styleなし |
| prefetch有効/無効 | 未需要packの先読みと既存共有packの重複取得を区別して計測 |
| streaming/client初出 | CSSなしのframeを表示しない。CSS QRL解決後に対象を表示 |
| HMR値編集・rule削除 | document reloadなし、古いruleが残らない、state保持 |
| 配送費用 | native手書き基準と旧qstyleを併記してHTML/CSS/JS実測 |

これは設計上最大の未確定点であり、後段の大規模置換より先に実行する。**不合格ならD1以降の配信実装へ進まない。** Qwikの公開APIで満たせるloweringへD0を修正するか、Qwik upstreamの修正を前提条件として提示する。独自loader、全CSSのroot注入、private APIへの切替を自動fallbackにしない。D0失敗は「Qwik標準だけで全契約を満たす」という前提の未成立として記録する。

**パッケージ統合（2026-09-11）:** `@qstyle/vite` の `qstyleNative()` が compiler と named-import adapter をまとめて導入する。`@qstyle/qwik/runtime` と `/server` に実装を配置し、parse5 は server entry のみが読み込む。Qwik/Vite の公開 entry は ESM 専用とし、build tooling は Node 24.11 以上、Qwik は beta.43 固定とする。サーバー用 import の置換はサーバー環境に限定する。Qwik beta.43 を検査し、SSR では wrapper を bundle して同じ Qwik render context を共有する。dev の SSR resolver も環境ごとの `buildStart` で初期化する。公開 build entry 経由で SSR、SSG、resume、navigation と HMR を再検証済み。default の legacy entry 切替と外部 consumer・全性能 gate の完了は別途必要。

### 初期inlineを同じ共有cacheとして使う契約

`pack ID → 同一StylePack export → 同一QRL symbol/hook index → 同一q:style ID`をSSR・client・各routeで一致させる。初期inline専用packと後続配信専用packを別々に作らない。owner一覧をCSS本文へ埋め込まず、共有相手が増えても内容が同じなら同じpackを使う。

必要なのはQwik container内の**適用済みstyle cache**であり、HTTP cacheとは別である。初期inlineにあるpackは「存在するが、CSS文字列QRL moduleは未取得」という状態を正しく扱わなければならない。後続componentのJSが必要なことと、その共有CSS本文を再取得することを別に測る。

2026-09-11の追加source監査で、対象beta.43の`core.mjs`に次を確認した。

- `styleKey`はQRL hashとhook indexで決まる（約844行）。
- `_useStyles`は同じinstanceの保存済みsequential scope値があると早期returnする（約16936行以降）。
- **新instanceでは、既存style IDの有無を確認せず`styleQrl.resolve()`してから`$appendStyle$`へ渡す。** DOM側のID重複排除があっても、CSS本文の解決・取得を回避した証拠にはならない。

したがって、前回proofの「SSRでstyleが1件」と「lazy固有CSSが遅れて取得できる」は、今回要求されたinline本文再利用の証明ではない。新instanceでの再取得ゼロgateは未達の扱いにする。

Qwik側に必要な動作を次で固定する（新しいqstyle client runtimeには実装しない）。

1. 新instanceでもstyle IDを先に計算し、containerのSSR由来style IDを取得前に確認する。
2. 既存ならhook状態を保存して終了し、CSS本文QRLをresolveしない。
3. 未取得なら同じIDのin-flight解決を共有し、CSSを一度だけ追加する。失敗時はin-flight状態を解除し、後続renderで再試行できる。
4. SSR inline styleを保持したままSPA遷移し、新ownerも同じIDへ到達する。styleが除去された場合はIDだけが残る誤ったcache hitを起こさない。
5. dev/HMRの本文更新は既存IDがあっても反映する。productionのguardでHMR更新を抑止しない。

公開されたQwik標準動作として採用できる版をD0で確認する。必要ならQwik upstreamへの変更を別の前提タスクにする。未公開内部関数をqstyleから呼ぶことやconsumerだけのmonkey patchを完成形にはしない。

**追加のD0実測（2026-09-11）:** beta.43はbody内の使用地点にnative `<style>` を出力するため、JS無効のSSRで`:first-child`・隣接兄弟selectorの意味が変わる。`patches/qwik-style-reuse/server-head.mjs`の隔離候補は、描画されたbody需要だけをheadへ集める`stylePlacement: 'head'`を試験する。既存head内のstyle順序は維持し、追加styleにQwik JSXの`:`属性を付けずresumeの要素番号を変えない。Wind4のproduction fixtureはJS無効を含む12 browser check、streamの送信・失敗処理は5 checkに合格した。ただし全HTMLを保持してから1回で送信するため、progressive SSRの喪失・メモリ増加を伴う。非HTML containerとout-of-order streamingは拒否する。この候補を標準機能や完成した配信基盤とは扱わず、サポートされた依存版/APIと性能gateの成立を引き続きD0の条件とする。

**非侵襲方式の追加実測（2026-09-11）:** 未改変beta.43で必要なstyle/server named importだけを置換するfixtureは、request-local SSR collectorとnative hook slot保持により、構造selector・scoped/global authored hook・resume・lazy・共有inline本文再利用・削除style復旧の15 browser checkに合格した。compiler生成StylePackのCSS import factoryだけに再試行を付け、元の静的import辺を維持したままRolldownのfile URL参照で同じCSS chunkを特定する。通常URLと最初のquery付きURLを故意に失敗させた後、再マウントで新しいquery付きURLの取得に成功した。これは独自CSS registryではなくnative QRLのimport factoryに限定したfixture実装で、CDN等のquery付きasset配信は未検証。通信遅延中は8描画frameで未装飾要素の露出0を確認したが、取得が完全に失敗した直後はQwikが未装飾要素を表示する。HMRはstockとnamed headの各8 checkに合格し、padding変更のscroll anchoringはstock対照で原因を確認して試験側で無効化した。内部style-hook exportへの結合と全HTML bufferingは残る。parse5は scripting 有効・無効の両方で明示的なhead/body境界を確認し、それより後の文字列を変更せず返す。不正なbodyを含む差分probeでもnativeと同じbody tree・parse errorを保ち、noscriptで境界が異なる入力は拒否する。4 MiBの逐次再計測は中央値27.19 ms / p95 28.33 ms（native 27.47 / 27.93 ms）で、bytes/digestも一致した。最初の送信は依然として描画完了まで待つ。このfixture検証を公開entry切替や全性能gate成立の証拠とは扱わない。

### hard navigation・別タブの境界

| 遷移 | 再利用するもの | 必須観測 |
| --- | --- | --- |
| 同containerのSPA遷移・未表示component | 初期inlineを含む適用済みpack | 既存本文のresolve/request/挿入0 |
| 新documentへの通常遷移・reload・別タブ | 取得済み外部assetはブラウザHTTP cacheの対象 | inlineだけだったCSSは次のHTMLへ再び含まれることを明示 |
| 外部QRL/CSSを以前取得した場合 | 同じhash URLのHTTP response | 再利用可能な条件でwarm転送を測定。cache eviction等まで0を保証しない |

HTMLの一部として届いたCSSが、別URLのresponseとして自動cache登録されることはない。HTTP cacheは最低でもrequest methodとtarget URIをkeyにする（[RFC 9111 §2](https://www.rfc-editor.org/rfc/rfc9111.html#section-2)）。よって「inlineを保持」「独自client処理なし」「hard navigationでも同じCSSの再転送ゼロ」の3つは、現行方針では同時に保証できない。

別documentでも再転送ゼロを必須にする場合は、外部stylesheet参照中心の配信へ変えるか、永続cacheを扱うclient機構を認めるという要件変更が必要になる。本仕様では既存のQwik標準・初期inline方針を維持し、この範囲を未充足要件として明示する。Service Worker/Cache Storageの追加や同じCSSのpreloadによる二重取得を、要求を満たす代替として黙って導入しない。

## 8. 動的値の厳密な変換

| 入力 | length property | unitless property | custom property |
| --- | --- | --- | --- |
| 有限number | `${value}px`（0も許可） | decimal文字列 | decimal文字列 |
| string | そのまま | そのまま | そのまま |
| null/undefined/boolean | slotを解除 | slotを解除 | slotを解除 |
| NaN/Infinity/object | 開発診断。利用者入力として生成しない | 同左 | 同左 |

static数値とdynamic数値で同じproperty分類表を使用する。静的に判定できるNaN/Infinity/objectはQS1102でbuild/devともerror。runtimeで初めて不正になる値は、生成する型・有限性guardでdev/prodともslotを削除し、devのみconsole診断する。診断は不正値が新たに評価されたときに限り、共有registryは置かない。runtimeの任意入力検証を共有client engineとして追加せず、必要最小限の生成式にする。`NaNpx`等を出さない。文字列のCSS妥当性すべてをbuild時に保証するとはしない。正常値→不正値→正常値の復帰と、slot削除時のfallbackあり/なしをdev/prod両fixtureで検証する。

`width: signal.value`は`width:var(--qstyle-...)`とDOM側`--qstyle-...:100px`にする。`var(--x)px`は生成しない。templateの`${size.value}px`は補間と単位をまとめた値式にlowerする。`calc()`内もCSS token境界をparseして扱い、対応できない位置はerror。

値を解除した場合、inline slotを実際に削除する。fallbackなしvarがinvalidになる際のcascade挙動を通常CSS版と比較する。未定義値を直前の値として残さない。明示styleとのmergeは利用者styleを最後とし、内部`--qstyle-`名前空間への書き込みは拒否する。

## 9. Build・cache・HMRのphase

### Build

`discover whole site → parse/evaluate → lower/compose → owners → freeze → declaration dictionary → exact class cover → unique packs → emit native modules → Qwik optimizer → bundle → verify/report`

- Viteの解決済みapplication entryからmodule importを辿るprepassを持つ。compilerが使用するresolve結果とplugin transformのresolve結果を一致させる。
- virtual/Qwik生成moduleをprepassへ逆流させない。外部化dependencyはstyle macroの対象にしない。consumer packageの`.qstyle.ts`を対応させる場合は明示的にsourceとして解決する。
- graph freeze後に未知sourceが必要になったら、そのbuildを部分出力で成功させない。graph世代を作り直すか、未対応の生成sourceとして位置付きerrorにする。
- source所有graphは共有してよいが、SSR/clientの可変emission状態はenvironment別。process-global Mapは禁止。plugin instance終了時に破棄する。
- `generateBundle`以降にCSS/JS本文を書き換えてdedupしない。reportは最終bundleを読み取るだけ。

### Cache key

`compiler version + canonical version + source bytes + resolved import identities + dependency digests + Uno config/dependency digest + environment mode + target Qwik version`。

絶対checkout path、mtimeだけ、process lifetimeだけをkeyにしない。project root相対のPOSIX module IDをgraph識別に使い、内容identityと分離する。ソース位置だけの変更でCSS hashを変えない。config変更・import元変更・削除はreverse dependencyを通して無効化する。

サイト全体の厳密最適化では、一部の状態追加によって最適なclass基底や共有selectorが変わる場合がある。その場合は関連packの最終bytesも変わるためhash URLを更新する。古いhashを維持するために異なるCSSを同URLへ入れない。「未変更のsourceがあれば必ず全pack URL不変」とは保証せず、最終内容が同じpackのURL安定性を保証する。reportに再最適化で変わったclass/packを記録する。

### Dev/HMR

dev仮想module IDは`project-relative module + semantic owner ordinal`を基に安定化する。content hash URLをdevの識別子として使わない。ownerの構造が変わらないCSS値編集では同じmodule/symbolを更新し、Qwik標準HMRへ渡す。

更新時は新graph世代を構築→検証→native modulesを原子的に置換→依存moduleをinvalidateする。parse error時は最後に成功した世代を保持してoverlayを出し、修正時に回復する。timer、reloadメッセージ、自前style DOM操作は禁止。import追加・削除、component移動、Uno config/preflight変更も試験する。Qwik自身が保持できない構造編集を通常CSS編集の成功に含めない。

## 10. UnoCSS adapter

adapterの入力は解決済みconfigとowner別の静的token集合、出力はordered CSS AST・global基盤・tokenとの対応である。JSXを書き換えず、aliasを生成せず、別のCSS配信を行わない。classの消去・統合は全体compilerだけが行う。

公式generatorから得たresponsive、dark、group/peer、arbitrary value、layer、preflightをparserで構造として取り込む。verbatim経路でもwrapperを失わない。tokenを減らしたときに残す必要があるruleはdependencyとして説明できるようにする。全token集合を毎ownerへ出力しない。

styling専用のutility class名は全体class coverへ統合してDOMから除く。`group`/`peer`等のanchor、外部CSS・DOM APIで使うclassは保持し、固定classとして別集計する。styling専用utility名を`querySelector`等で外部APIにする使い方は1.0では非対応と明示する。qstyleのcss合成が勝つ必要のある競合はselector/cascade設計で保証し、style packの非同期到着順に依存させない。元utility CSSと同じselectorを異なるownerから異なる定義で生成するconfigはerror。preflightとlayer宣言順はrootの一か所へ固定する。

safelistに含まれるutilityは固定selectorとしてrootに配置し、同じtokenを有限class式が参照していてもDOMに保持する。遅延component内で参照されることを理由にsafelist出力を遅延側へ移さない。layerの空block・最初の出現・条件付き宣言も順序情報として保持する。`@font-face`の順序が意味を持つ場合は同じ需要のpayloadにまとめ、非同期到着順へ依存させない。

foundationのrootはimport graph内の唯一の`<head>`という探索では決めない。Qwikの入力moduleのdefault exportから、直接返されるdocument JSX、またはbindingで確認した公開`renderToString`/`renderToStream`の第一引数、Routerの`createRenderer` callbackが返す静的objectの`jsx`を追う。 Node等のmiddleware入口は、公開`@qwik.dev/router/middleware/*`の`createQwikRouter`/`createQwikCity`がmodule scopeで無条件に呼ばれ、その静的optionsの最終`render` propertyを追える場合だけ受理する。options aliasのescape・mutation、後続spread/computed keyによる上書き、条件付きfactoryは拒否する。SSG environmentでは通常SSR inputの流用を避け、adapterが生成するworkerの公開`startWorker({render})`から辿る。beta.43の実装では`@qwik-ssg-worker-entry`をresolveし、対応adapterのload hookから変換前sourceを取得する。これは生成module protocolに結合した境界であり、公開renderer getterではない。workerの解決・source取得・静的renderの証明が失敗した場合は停止し、`src/entry.ssr`等のパスを推測しない。root componentのimport/re-exportを解決し、返却されるdocument内の無条件のheadへ配置する。未使用のimport先・関数内にあるheadは配置先ではない。条件分岐・早期return・未知のrenderer等で配置先を証明できずfoundationが必要な場合はQS1103で停止し、rootへの到達性を推測しない。複数入力の一つでも証明できなければ、別入力に正しいrootがあることを理由に受理しない。これは追加の公開optionを導入せず、既存のQwik入力に基づくbuild時の検証とする。Routerが有効な場合、生成されたroute configをclient・SSR・SSG共通の追加解析入口とし、そこから動的importされるroute/layoutもfreeze前に解析する。この解析入口はdocument renderer候補には含めない。開発時の生成sourceはenvironmentの`pluginContainer.load()`で読み、`this.load()`のModuleInfoをsourceとして扱わない。

合成時には対象要素を表すutility selectorのclass nodeを抽象subjectへ置換し、css宣言と同じ全体IRへ入れる。最適化後にsubjectを採用classのselector listへ変換する。group/peer等の祖先・兄弟anchorは書き換えない。selector specificityを維持し、target subjectを特定できない複雑なgenerator出力はQS1101にする。非同期順序で勝敗が変わる構造は§6の制約に従い、重複出力で逃げない。異なるlayerの順序を跨いで「cssが常に勝つ」とは保証しない。

config loader/generatorはplugin instanceごとに保持し、configとそのimport依存のwatchで作り直す。config再生成が失敗したときはHMRと同じく成功済み世代を維持する。`@unocss/vite`のpluginを内包して独立transformを走らせる実装は削除する。

## 11. 診断とreport schema

診断は `{code, message, file, start, end, related[], fixHint}`。同じ原因をphaseごとに重複報告しない。
位置が特定できる診断には相対fileとoffsetを保持し、graph全体など位置を持たない診断では位置fieldを省略する。source本文は含めない。

| Code | 内容 |
| --- | --- |
| QS1001 | 廃止option/API |
| QS1101 | parse不能・未対応CSS構文 |
| QS1102 | runtime構造・未知spread・handle escape |
| QS1103 | Qwik render ownerを確定できない |
| QS1201 | 不正custom property/予約namespace |
| QS1301 | hash衝突（両sourceを表示） |
| QS1401 | graph freeze後の未解決依存 |
| QS1501 | native backendの対応Qwik条件を満たさない |
| QS1601 | 意味・遅延境界を守った宣言一意化を証明できない |
| QS1602 | class最適性を証明できない（候補/状態/探索上限を含む） |
| QS1603 | 未管理stylesheetがありサイト全体保証を満たさない |

reportは`schemaVersion:1, compilerVersion, targetVersions, modules, owners, rules, packs, assets, diagnostics, timings`を持つ。packに`id, declarationIds, ownerIds, cssBytes, cssDigest`、assetに`fileName, contentDigest, bytes, packIds`を記録する。さらに`wholeSiteGuarantee, unmanagedStylesheets, duplicateDefinitionCount, duplicatePayloadCount, classCount, classAssignments, fixedClassCount, classOptimality:{status, lowerBound, upperBound, candidateCount, exploredNodes, modelVersion}`を必須にする。`optimal`はK/T両目的で下界と上界が一致した場合だけ許す。Qwikの最適化で対応が判定できないassetを推測でpackへ割り当てず`unmapped`にする。unmappedなCSS本文があればサイト全体保証のgateは失敗する。source本文・絶対pathは既定で出さない。

runtimeはreportをimportしない。routeの実配信情報はbuildの到達可能性から捏造せず、別のbrowser/SSR測定結果へ記録する。

実装中のnative entryは、client環境のRolldown output pluginで、Qwikの最終generateBundle処理後に監査する。`qstyle-report.json`（複数outputではindex付き）をemitし、`write:false`でも生成結果に含める。既存output pluginは保持する。JSの完全なCSS文字列一致に加え、Qwik manifestのgenerated native origin、style symbol、mapped chunk、そのnamed exportの静的値まで一致を要求する。source上のhook名はbindingで判定し、shadowされた同名関数を誤認しない。

CSS assetの完全なpack連結はbyte対応だけを記録する。現在のnative backendは、そのstylesheetの配信とcascade順序を証明していないため、対応が判明しても保証は失敗する。native packの対応不明・重複・最適性不明は出力前にbuild errorになる。手書きQwik/style比較fixtureを含む内部段階では、QS1603はreportの保証をfalseにするのみであり、公開切替前に必須の全未管理stylesheet拒否は未完了である。この内部entryをproductionの全体保証完成とは扱わない。

## 12. 実装順と担当範囲

各段階は変更・検証・次段階への入口が完結する単位とする。完了チェックは実装と証拠が揃ってから付ける。

| ID | 変更範囲 | 完了条件 / 次の入口 |
| --- | --- | --- |
| D0 | 独立native proof fixture、成果物・browser計測、Qwik取得前guardの成立確認 | §7の全gate。現行beta.43の新instance再resolve経路を解消し、inline共有本文の再取得0を証明 |
| D1 | core IR/canonical/identity/units/serializer | nested wrapper、fallback、空白、衝突、動的単位の回帰fixture合格 |
| D2 | 新compiler、qwik authoring API、型 | AST binding・escape・評価順・source map。手書きscannerを使わずfixture変換 |
| D3 | Uno adapter、cascade/compose、declarations/class-cover/verify-cover | Uno公式版と表示差0。全体辞書・最適性oracle・重複0。属性順非依存、shorthand/fallback保持 |
| D4 | graph/owners/pack/native/report | SSR/SSG/lazy/shared gate合格。各宣言のpack所属1、最終payload重複0。旧配信経路を削除 |
| D5 | HMR/cache | CSS編集・削除・Uno config更新でreload0、state保持、二重buildの安定性 |
| D6 | package export、inspector、docs、2 consumer | tarball consumerとVite Plus構成でdev/build/SSR/SSG/preview合格 |
| D7 | size/lifecycle gate、deploy手順 | 転送量・cache・state基準をCI化。stagingは実行権限と環境がある段階で検証 |

D1のIR契約確定後、D2とD3のadapter内部を並列化できる。D4のgraph/native、D5のHMRは同じ担当が統合する。共通IRやserializerを複数担当が同時に変更しない。サブエージェントへは一つのfixture群や移行対象など、入出力が決まった単位を渡す。

旧`packages/vite/src/index.ts`の巨大transform、`packages/vite/src/dedup.ts`のbundle後処理、Qwik authoring entryからのlower実装export、Unoのsource transform/process-global registryをD4までに除去する。旧実装を呼び出す互換wrapperで新compilerを完成扱いしない。

## 13. 検証仕様と数値gate

### 正しさ

通常CSSで書いた独立reference fixtureと、SSG/SSR、JS無効、resume直後、signal更新、route往復、client初出、nested lazyでcomputed styleを比較する。期待値を新compiler自身から生成しない。

必須case: width100→101px、unitless、string/0/負数/null解除、fallback10px/20px、`content:"a  b"`、shorthand両順序、重複宣言、important、nested media/supports/container/layer、pseudo、global/font/keyframes、同module複数component、条件分岐、shared pack、hook index差、Uno aliasなしresponsive。

未表示ruleはclass名だけでなく固有のCSS sentinelとCSS ASTで検査する。初期HTML、CSSOM、初期取得した全JS/CSS本文を検査する。`.css` requestやURLの`qstyle` substringだけで判定しない。

### 固定gate

- lazy/別route固有CSSの初期混入 **0 bytes**（prefetch無効）。
- client bundleからqstyle compiler/parser/registry/loaderへの到達 **0**。
- SSR styleのresume再挿入 **0**、同じ共有packの有効style ID **1**。
- SSR/SSG inline済み共有packを別instance/SPA routeから使用したときのCSS本文resolve・request・再挿入 **0**。
- サイト全体のcanonical宣言の重複定義 **0**、同一宣言の独立pack間payload重複 **0**、各宣言のpack所属 **1**。
- 最終成果物で追跡できないCSS本文 **0**、未管理stylesheet **0**、`wholeSiteGuarantee:true`。
- class coverの余分な適用/不足 **0**、最適性status **optimal**。小規模独立oracleのK/Tと完全一致。
- 通常CSS HMRのdocument navigation/full reload **0**。state/input/focus/scroll保持。
- 未解決css prop、hash同一で内容違い、asset参照404、古いrule残留 **0**。
- 同じ入力の再buildおよび別checkoutで、CSS内容identityと対応packの内容が一致。

### 性能gate

`HTML inline CSS + stylesheet bytes + style取得用QRL JS + 追加marker/serialization`をそれぞれraw/gzip/brotliで記録する。HTML全体/JS全体、request数、cold/warm転送、初期表示とlazy表示の時間も別に保存する。

基準は旧qstyleと、同じUIをQwik nativeで手書きした版の2つ。暫定のリリースgateを「route初期総転送は旧版以下、操作後総転送は旧版の105%以下、native手書き版に対する追加runtime moduleは0」とする。初期CSSだけ減って総量が増える場合は不合格。小さいfixtureと大きいconsumerの両方で判定し、比較対象が同じUIでない場合は測定し直す。

**2026-09-11 実測:** 同一UIのA/B/A/lazy fixtureをnative qstyle・native手書き・旧qstyle、prefetch off/onで測定した。6 buildとcomputed style/state保持は通過。off時の初期総転送はnative 141565 / legacy 141420 raw bytes（+145）、gzip +35 bytesで初期gateは未達。操作後累計はraw 102.12%、gzip 103.57%、Brotli 103.40%で105% gateを通過した。on時も同じ判定。`pnpm report:delivery` が再現し、未達なら非zero終了する。詳細は `docs/audits/2026-09-11-delivery-cost.json`。これは小規模fixtureのみであり、大規模consumer・時間gateの合格を意味しない。公開entryの切替は引き続き保留する。

時間は同じ端末・browser・network条件でwarm-up後10回測定し中央値/p95を記録する。HMR反映中央値はnative手書き版の1.2倍以内、p95は2倍以内を初期gateとする。測定ノイズを理由に合格値を後から緩めず、変える場合は実測根拠と変更した基準を記録する。速度向上率は実装前には約束しない。

### 実行コマンド

既存コマンド:

```sh
pnpm test
pnpm typecheck
pnpm build
node fixtures/lifecycle/scripts/build.mjs
pnpm exec playwright test --config fixtures/lifecycle/e2e/playwright.config.ts
```

D0/D7で以下のroot scriptsを追加し、CIとローカルで同じentryを実行する:

```sh
pnpm test:native-contract    # SSR/SSG/lazy/share/streaming/resume
pnpm test:hmr-contract      # isolated dev server + browser state assertions
pnpm test:cache-contract    # 2 builds + partial change + different checkout
pnpm test:style-reuse       # inline→new instance/SPA/lazy。hard navは別集計
pnpm test:global-optimum    # whole-site定義/payload一意性 + 最適性oracle
pnpm test:package-consumer  # pnpm pack tarballを外部temp projectへinstall
pnpm report:delivery        # 上記性能schemaのJSON。基準超過でnonzero
```

新scriptsは本計画時点では存在しない。port・build出力をsuiteごとに分け、終了時に子processを停止する。native proofの成功を製品compilerの成功の代用にしない。

## 14. Consumer移行と公開

`qwik-on-viteplus`と`haven-web`は別々に移行する。import/option/runtime component/型拡張/Uno登録を棚卸しし、廃止APIをcodemodまたは明示的変更で除去する。`QstyleLinks`等の旧runtime参照を残さない。既存のVite Plus overrideとQwik Router patchを消して試験を通したことにはしない。

workspace source直参照だけでなく、packした全packageを入れたconsumerでexports/types/buildを検証する。Qwik/Vite/Unoの対応versionをこの試験結果に合わせてpeer範囲へ記録する。広いpeer範囲を先に宣言しない。

新HTML/manifestと新assetを同じreleaseとして公開する。assetを先に配置し、古いHTMLや開いたタブのQRLが参照する旧assetを保持する。hash付きassetはimmutable、HTMLは更新可能にする。SSR Worker responseとstatic `_headers`を別々に検証する。rollbackはrelease一式で戻す。hash1と旧hashを一つのHTMLへ混在させない。

## 15. 実装に使うモデル

主担当は **GPT-6 Astra / reasoning effort `xhigh`** を推奨する。IR、cascade、Qwik optimizer、SSR/HMR/cacheを横断するため、境界を一貫して判断する担当を固定する。D0で公開APIの成立条件を詰める局面や、再現済みの難しい不具合の最終検証だけ`max`へ上げる。

仕様が確定したfixture追加、診断一覧の移行、consumerの限定的なAPI置換は **GPT-5.6 Luna / `high`または`xhigh`** のサブエージェントへ渡す。core IR・配信方式・HMRをLunaへ一括で委譲しない。`ultra`を常用する必要はなく、独立した仕事を分けられる段階で並列化する。

根拠: [OpenAIのCodexモデル選択ガイド](https://learn.chatgpt.com/docs/models)と[GPT-6 Astraの公式仕様](https://developers.openai.com/api/docs/models/gpt-6-astra)。モデル・設定の推奨であり、この作業でユーザーの設定は変更していない。
