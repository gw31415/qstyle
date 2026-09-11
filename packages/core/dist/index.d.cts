//#region src/ir.d.ts
interface RuleContext {
  readonly pseudo?: readonly string[];
  readonly media?: string | undefined;
  readonly supports?: string | undefined;
  readonly container?: string | undefined;
  readonly layer?: string | undefined;
  /** `& span.x` 形式の子孫セレクタ (plan.md §10 selectorRelation)。単純セレクタのみ。 */
  readonly descendant?: string | undefined;
  /**
   * SCSS 的ネストの `&` 接尾辞 (` > svg` / `--mod` / `:hover, :focus` 等)。
   * class 直後に連結される生サフィックス (カンマ区切りは各要素に class を付与)。
   */
  readonly suffix?: string | undefined;
}
interface OrderingConstraints {
  readonly after?: readonly string[] | undefined;
  readonly before?: readonly string[] | undefined;
  readonly group?: string | undefined;
}
interface Provenance {
  readonly source: string;
  readonly line: number;
  readonly column: number;
}
interface StaticAtom {
  readonly kind: "static-atom";
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
  readonly context: RuleContext;
  readonly ordering: OrderingConstraints;
  readonly provenance: readonly Provenance[];
}
type StyleNode = StaticAtom | ParametricAtom | KeyframesRule | GlobalAtRule | ResidualRuleNode;
/** static / parametric を区別しない atom 処理用の合併型。 */
type AnyAtom = StaticAtom | ParametricAtom;
/**
 * 最適化不能として residual に落とした理由 (plan.md §15, §59)。
 * Milestone 1 では分類語彙のみ定義し、判定ロジックは M6 で実装する。
 */
type ResidualReason = "unsupported-selector" | "unsupported-at-rule" | "unsupported-value" | "shorthand-ordering" | "source-order-sensitive" | "unsupported-syntax" | "third-party-preservation" | "unknown";
/**
 * 安全な atomicization / dedup が保証できないルール (plan.md §15)。
 * cssText は frontend-neutral な CSS ソース断片 (AST node ではない)。
 */
interface ResidualRuleNode {
  readonly kind: "residual-rule";
  readonly cssText: string;
  readonly scope: "global" | "component";
  readonly reason: ResidualReason;
  readonly provenance: readonly Provenance[];
}
/**
 * runtime 値の型注釈 (plan.md §12)。semantic identity には型のみを含め、
 * source 変数名や実際の値は含めない。
 */
type RuntimeValueType = "number" | "integer" | "length" | "percentage" | "color" | "angle" | "time" | "transform-function" | "image" | "custom";
type RuntimeSlotId = string;
interface RuntimeSlotNode {
  readonly kind: "runtime-slot";
  readonly id: RuntimeSlotId;
  readonly valueType: RuntimeValueType;
  readonly fallback?: CanonicalValue | undefined;
}
type CanonicalValue = string;
/**
 * 複合 dynamic value の AST 表現 (plan.md §13)。
 * 文字列結合ではなく static text と slot 参照の列で表す。
 */
type ValueTemplatePart = {
  readonly kind: "text";
  readonly text: string;
} | {
  readonly kind: "slot";
  readonly slotIndex: number;
};
/**
 * 値だけが runtime で構造が静的な style (plan.md §11)。
 * 実際の値は hash に含めず、同一構造は共有可能な ParametricAtom になる。
 */
interface ParametricAtom {
  readonly kind: "parametric-atom";
  readonly property: string;
  readonly valueTemplate: readonly ValueTemplatePart[];
  readonly slots: readonly RuntimeSlotNode[];
  readonly important: boolean;
  readonly context: RuleContext;
  readonly ordering: OrderingConstraints;
  readonly provenance: readonly Provenance[];
}
/** `@keyframes` 内の 1 宣言 (通常宣言と同一 canonical 則)。 */
interface AtRuleDecl {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
}
interface KeyframesFrame {
  /** `from` / `to` / `0%` / `0%, 100%` (正規化済み小文字)。 */
  readonly selector: string;
  readonly decls: readonly AtRuleDecl[];
}
/**
 * `@keyframes` 定義。name は内容 hash 由来 (`qkf_xxxxxxxx`) で
 * グローバルに安定 (同一内容は同一名に畳まれる)。sourceName は解決用。
 */
interface KeyframesRule {
  readonly kind: "keyframes-rule";
  readonly name: string;
  readonly sourceName: string;
  readonly frames: readonly KeyframesFrame[];
  readonly provenance: readonly Provenance[];
}
/** `@font-face` / `@property` (宣言ブロックのみのグローバル at-rule)。 */
interface GlobalAtRule {
  readonly kind: "global-at-rule";
  readonly at: "font-face" | "property";
  /** `@font-face` は ''、`@property` は `--x`。 */
  readonly prelude: string;
  readonly decls: readonly AtRuleDecl[];
  /** 内容アドレス id (`qg_xxxxxxxx`)。同一内容は emit 単位で自然 dedup される。 */
  readonly id: string;
  readonly provenance: readonly Provenance[];
}
//#endregion
//#region src/atom.d.ts
/** プロパティ名を canonical kebab-case へ (Milestone 1 で fixture 化する)。 */
export declare function canonicalProperty(input: string): string;
/** 値の最小 canonicalization: 前後空白の除去 + 内部連続空白の単一化。 */
export declare function canonicalValue(input: string): string;
/** 生成 slot 変数 (`--qstyle-<hash6>-<i>`) の予約 namespace。 */
export declare const RESERVED_CUSTOM_PROPERTY_ROOT = "--qstyle";
export declare const RESERVED_CUSTOM_PROPERTY_PREFIX = "--qstyle-";
/** 生成済み namespace を user 定義から守る。 */
export declare function isReservedCustomPropertyName(name: string): boolean;
/**
 * 共有 custom property 名 validator。
 * serialization は property 名を escape しないため、入力境界で保守的な ASCII
 * grammar に限定する。escape・non-ASCII・生成用予約 namespace は拒否する。
 */
export declare function isValidCustomPropertyName(name: string): boolean;
interface CreateStaticAtomInput {
  readonly property: string;
  readonly value: string | number;
  readonly important?: boolean | undefined;
  readonly context?: RuleContext | undefined;
  readonly ordering?: OrderingConstraints | undefined;
  readonly provenance?: readonly Provenance[] | undefined;
}
export declare function createStaticAtom(input: CreateStaticAtomInput): StaticAtom;
/**
 * Semantic hash の入力 (logical identity)。collision 検出 (release blocker 1) は
 * この文字列を比較対象に使う — hash だけでなく論理入力同士を見る。
 */
export declare function staticAtomIdentity(atom: StaticAtom): string;
/**
 * Semantic hash (plan.md §43)。
 * canonical property / value・important・selector/conditional context・ordering semantics を含める。
 * chunk membership は含めない (style identity と delivery identity の分離, §3.3)。
 * FNV-1a 32bit → 8桁hex。異なる入力が同一 hash になる場合は IdentityRegistry
 * (collision.ts) が成果物出力前に失敗させる。
 */
export declare function hashStaticAtom(atom: StaticAtom): string;
/** FNV-1a 32bit → 8桁hex。parametric 側と共有する。 */
export declare function fnv1aHex(payload: string): string;
/**
 * class に対する完全セレクタ列。suffix のカンマ区切りは各要素に class を付与する
 * (`.h:hover, .h:focus`)。単一時は従来と同一文字列になる。
 */
export declare function classSelectors(className: string, context: RuleContext): string[];
/**
 * context の at-rule wrapper (supports → container → media → layer、外側ほど広域)。
 * layer なしの従来 context では従来と同一文字列になる。
 */
export declare function wrapContextAtRules(selectors: readonly string[], context: RuleContext, body: string): string;
//#endregion
//#region src/units.d.ts
/** unitless fixture のバージョン。table 内容と対で更新する。 */
export declare const UNITLESS_VERSION: string;
/**
 * 数値をそのまま serialize する canonical (kebab-case) property の集合。
 * 検索は serializeCssValue / isUnitlessProperty 経由で行う。
 */
export declare const UNITLESS_PROPERTIES: ReadonlySet<string>;
/** canonical property 名が unitless table に含まれるか (camelCase 入力可)。 */
export declare function isUnitlessProperty(property: string): boolean;
/**
 * plan.md §20.2 の number semantics:
 * - unitless property は数値をそのまま
 * - length 系は数値に `px` 補完 (Emotion/React 互換の MVP 規則)
 * - `0` は単位を付けない
 * - 文字列は canonicalValue 素通し (CSS-wide keyword / var() / calc() 等の意味を変えない)
 * - custom property (`--*`) の数値は単位推測せずそのまま (呼び出し側の token を尊重)
 */
export declare function serializeCssValue(property: string, value: string | number): string;
//#endregion
//#region src/dedup.d.ts
/** add() の戻り値。id は hashStaticAtom(atom)。 */
interface DedupAddResult {
  readonly id: string;
  readonly deduped: boolean;
}
/**
 * Semantic dedup registry (plan.md §88: exact semantic dedup)。
 * key は semantic hash のみ。chunk membership は key に含めない。
 * 同一 hash の 2 回目以降は初回 atom を保持し、provenance のみマージする。
 *
 * release blocker 1: hash が同一でも論理入力 (staticAtomIdentity) が異なる場合は
 * 黙って初回を採用しない — IdentityRegistry が deterministic な衝突 error を投げる。
 * 同一論理入力の重複 (provenance 差のみ) は従来どおり dedupe する。
 */
export declare class DedupRegistry {
  private readonly atoms;
  private readonly identities;
  add(atom: StaticAtom): DedupAddResult;
  size(): number;
  ids(): string[];
  get(id: string): StaticAtom | undefined;
}
//#endregion
//#region src/safety.d.ts
/**
 * canonical kebab-case shorthand -> 覆う longhand 一覧 (plan.md §17-2)。
 * 完全な CSS 仕様表ではなく、atomicization の ordering 判定に必要な範囲のみ。
 * `gap` / `grid-gap` は shorthand ではないため含めない。
 */
export declare const SHORTHAND_MAP: ReadonlyMap<string, readonly string[]>;
/** property を canonical 化してから shorthand が覆う longhand を返す (なければ空配列)。 */
export declare function longhandsOf(property: string): readonly string[];
/** canonical 化した property が shorthand かどうか。 */
export declare function isShorthand(property: string): boolean;
/**
 * a と b を独立に atomicize すると並び替え bug の危険があるか (plan.md §18)。
 * 同一 property / shorthand と longhand / shorthand 祖先共有 / 同一 logical axis で true。
 * custom property は var 解決経由で参照され atomic-safe passthrough とし、group 対象外。
 */
export declare function needsOrderingGroup(a: string, b: string): boolean;
/**
 * pairwise で needsOrderingGroup になる atom 同士を 1 つの ordering group にまとめる。
 * group id は member key の fnv1aHex 6 桁 (`og_<hash6>`) で決定的。入力順は保持し、
 * 独立な atom の ordering はそのまま (group なし)。
 */
export declare function assignOrderingGroups(atoms: readonly StaticAtom[]): StaticAtom[];
/**
 * declaration value / var() fallback 中に、quoted string・url() token の外側で
 * declaration / rule 境界を壊す文字 (`<` `>` `;` `{` `}`) が出現するか
 * (OBJ-023 / DYN-019)。unterminated quote / url も invalid とする。
 */
export declare function hasInvalidDeclarationChars(value: string): boolean;
/**
 * declaration が安全に atomicize 可能か判定する (plan.md §17, FLB-010)。
 * 証明できない場合は residual を返し、best-effort rewrite はしない。
 * `!important` suffix は upstream で分割済みのため、ここでは扱わない。
 */
export declare function classifyDeclaration(property: string, value: string): "atomic" | {
  residual: ResidualReason;
};
//#endregion
//#region src/collision.d.ts
/** 1 件の衝突の記述。全 field は入力から決定的に導かれる。 */
interface StyleCollision {
  /** 衝突した identity の種別 (`'unit'` / `'asset'` / `'pack'` / `'atom'` / `'global'` / `'slot'` / ...)。 */
  readonly namespace: string;
  /** 衝突した生成 id (class id / asset fileName / keyframes 名 / slot 変数名など)。 */
  readonly id: string;
  /** 先に id を生成した入力の所在 (module path / chunk id など)。 */
  readonly firstSource: string;
  /** 同一 id を再度生成した入力の所在。 */
  readonly secondSource: string;
  /** 先の登録の canonical content (比較用。長い場合でもそのまま保持する)。 */
  readonly firstContent: string;
  /** 後の登録の canonical content。 */
  readonly secondContent: string;
}
/** 衝突時に投げる deterministic error。message は入力のみから決まる。 */
export declare class StyleCollisionError extends Error {
  readonly collision: StyleCollision;
  constructor(collision: StyleCollision);
}
type IdentityRegisterResult = "new" | "duplicate" | "updated";
interface IdentityRegisterOptions {
  /**
   * true かつ同一 source からの再登録の場合のみ内容を上書きする。
   * dev の occurrence 固定 alias (qd_...) は同一 module の再変換で内容が変わる
   * (HMR) ため、alias 系 namespace のみ許可する。content-addressed な id
   * (atom id / keyframes 名 / asset fileName) では決して使わない。
   */
  readonly allowUpdate?: boolean | undefined;
}
/**
 * namespace ごとに (生成 id -> canonical content + source) を保持する registry。
 * - 同一 id + 同一 content: duplicate (dedupe 可能)。
 * - 同一 id + 異なる content: StyleCollisionError (警告ではなく必ず失敗)。
 * - allowUpdate && 同一 source: updated (dev alias の再変換)。
 */
export declare class IdentityRegistry {
  private readonly entries;
  register(namespace: string, id: string, content: string, source: string, options?: IdentityRegisterOptions): IdentityRegisterResult;
  has(namespace: string, id: string): boolean;
  size(): number;
}
//#endregion
//#region src/keyframes.d.ts
/** `@keyframes <name>` なら定義名を返す (大文字小文字の prefix は許す)。 */
export declare function parseKeyframesKey(key: string): string | null;
/** `@font-face` / `@property --x` なら種別と prelude を返す。
 * `@property` の prelude は共有 custom property validator に一元化する
 * (release blocker 2: `--x}body{...` 等を CSS へ出さない)。 */
export declare function parseGlobalAtRuleKey(key: string): {
  at: "font-face" | "property";
  prelude: string;
} | null;
/** `@layer <name>` なら layer 名 (anonymous は '') を返す。 */
export declare function parseLayerKey(key: string): string | null;
/**
 * フレームセレクタ (`from` / `to` / `0%` / `0%, 100%`) を正規化する。
 * from/to は小文字化し、カンマ前後の空白を潰す。不正なら null。
 */
export declare function normalizeFrameSelector(selector: string): string | null;
interface BuildFailure {
  readonly reason: ResidualReason;
  readonly message: string;
}
/**
 * 宣言 record を検証・canonical 化する (数値は px 則で serialize)。
 * `!important` suffix は flag へ分離する。失敗時は residual 理由を返す。
 */
export declare function buildAtRuleDecls(record: Record<string, unknown>, what: string): {
  decls: AtRuleDecl[];
} | BuildFailure;
/**
 * `@keyframes` ブロック (frame selector -> 宣言 record) を KeyframesRule へ。
 * name は内容 hash 由来でグローバル安定 (`qkf_xxxxxxxx`)。
 */
export declare function buildKeyframesRule(sourceName: string, framesRecord: Record<string, unknown>, provenance: readonly Provenance[]): {
  rule: KeyframesRule;
} | BuildFailure;
/** `@font-face` / `@property` ブロックを GlobalAtRule へ。 */
export declare function buildGlobalAtRule(at: "font-face" | "property", prelude: string, record: Record<string, unknown>, provenance: readonly Provenance[]): {
  rule: GlobalAtRule;
} | BuildFailure;
/** `@keyframes qkf_...{from{...}...}` (keyframes は class に属さない global CSS)。 */
export declare function serializeKeyframesCss(rule: KeyframesRule): string;
/** `@font-face{...}` / `@property --x{...}` (global CSS)。 */
export declare function serializeGlobalAtRuleCss(rule: GlobalAtRule): string;
/**
 * `animation` / `animation-name` 値中の定義名トークンを確定名へ書換える。
 * カンマ区切り・空白区切りの完全一致のみ置換し、関数・var() 内は触らない。
 */
export declare function rewriteAnimationValue(value: string, keyframes: ReadonlyMap<string, string>): string;
//#endregion
//#region src/parametric.d.ts
type TemplateSlotInput = {
  readonly valueType: RuntimeValueType;
  readonly fallback?: string | undefined;
};
type TemplatePartInput = {
  readonly kind: "text";
  readonly text: string;
} | {
  readonly kind: "slot";
  readonly slotIndex: number;
};
interface CreateParametricAtomInput {
  readonly property: string;
  readonly parts: readonly TemplatePartInput[];
  readonly slots: readonly TemplateSlotInput[];
  readonly important?: boolean | undefined;
  readonly context?: RuleContext | undefined;
  readonly ordering?: OrderingConstraints | undefined;
  readonly provenance?: readonly Provenance[] | undefined;
}
/**
 * ParametricAtom を生成する (plan.md §11, §29)。
 * slot id は構造 hash から決定的に割り当てる (`--qstyle-<hash6>-<i>`)。
 * `--qstyle-` prefix は予約語とし、user 定義との衝突を避ける (DYN-024)。
 * 実際の runtime 値は保持せず hash にも含めない。
 */
export declare function createParametricAtom(input: CreateParametricAtomInput): ParametricAtom;
/**
 * ParametricAtom の semantic hash (plan.md §43)。
 * 構造・型・context のみを含み、slot id や実際の値は含めない。
 */
export declare function hashParametricAtom(atom: ParametricAtom): string;
/**
 * ParametricAtom を CSS rule へ serialize する。
 * slot は `var(--id[, fallback])` 参照になる。
 */
export declare function serializeParametricCss(atom: ParametricAtom, className: string): string;
/** declaration 部分のみ (unit merge 用)。slot は `var(--id[, fallback])` 参照。 */
export declare function serializeParametricDecl(atom: ParametricAtom): string;
/**
 * 既知の runtime 値から slot 型を推測する (best-effort)。
 * 不明なものは 'custom' になる。identity には型のみが使われる。
 */
export declare function inferSlotType(value: unknown): RuntimeValueType;
//#endregion
//#region src/usage.d.ts
/**
 * Usage graph (plan.md Part VIII: style -> components -> routes / lazy boundaries)。
 * chunk planning の第一段階 grouping (§38) と第二段階 clustering (§39) の入力になる。
 */
/** style -> components -> routes / lazy-boundaries の 3 段 graph。id はすべて string。 */
interface UsageGraph {
  readonly styleToComponents: Map<string, Set<string>>;
  readonly componentToRoutes: Map<string, Set<string>>;
  readonly componentToLazyBoundaries: Map<string, Set<string>>;
  /** style -> provenance source (module path 等)。dedup atom の全 origins 保持用 (§58)。 */
  readonly styleToSources: Map<string, Set<string>>;
}
/** 空の usage graph を生成する。 */
export declare function createUsageGraph(): UsageGraph;
/** styleId が componentId で使われることを記録する (冪等)。 */
export declare function recordUsage(graph: UsageGraph, styleId: string, componentId: string): void;
/** styleId の provenance source (module path 等) を記録する (冪等、sorted 解決用)。 */
export declare function recordSource(graph: UsageGraph, styleId: string, source: string): void;
/** componentId が routeId で描画されることを記録する (冪等)。 */
export declare function recordComponentRoute(graph: UsageGraph, componentId: string, routeId: string): void;
/** componentId が boundaryId (lazy boundary) 配下にあることを記録する (冪等)。 */
export declare function recordComponentBoundary(graph: UsageGraph, componentId: string, boundaryId: string): void;
/** styleId を使う component id の sorted list。未知なら空配列。 */
export declare function usageSignature(graph: UsageGraph, styleId: string): readonly string[];
/** styleId の provenance source の sorted list。未知なら空配列。 */
export declare function sourceSignature(graph: UsageGraph, styleId: string): readonly string[];
/** styleId を使う全 component の route の sorted union。未知 / route 未記録なら空配列。 */
export declare function routeSignature(graph: UsageGraph, styleId: string): readonly string[];
/**
 * usage signature 完全一致 (§38) で style を group 化する。
 * key は usageSignature の JSON、value は sorted style id。
 * usage を持たない style は含めない。
 */
export declare function groupByUsageSignature(graph: UsageGraph): Map<string, readonly string[]>;
/** |A ∩ B| / |A ∪ B|。両方空なら 1、片方空なら 0。 */
export declare function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number;
//#endregion
//#region src/chunk.d.ts
/** chunk 対象 style の配信サイズ。 */
interface ChunkInput {
  readonly id: string;
  readonly bytes: number;
}
interface ChunkOptions {
  /** これ未満の pack は類似 pack と merge を試みる。 */
  readonly minChunkBytes: number;
  /** これを超える pack は分割する。 */
  readonly maxChunkBytes: number;
  /**
   * clustering v2 (§39 / R3): jaccard similarity がこの値未満の partner とは
   * merge しない (default 0.3)。0 は v1 挙動 (similarity > 0 で merge) に戻す。
   */
  readonly similarityThreshold?: number;
  /**
   * clustering v2 (§40 cost model / R3): 1 request 追加の等価 overhead bytes。
   * merge で無駄配信される bytes (unusedPenalty = merge 後 bytes - max(各々 bytes))
   * がこれ以上なら merge しない (default 512)。
   */
  readonly requestOverheadBytes?: number;
}
export declare const DEFAULT_CHUNK_OPTIONS: ChunkOptions;
interface ChunkPlan {
  readonly id: string;
  /** sorted。pack の内容は member 集合だけで決まる。 */
  readonly members: readonly string[];
  readonly bytes: number;
}
/**
 * usage graph と style sizes から deterministic な chunk plan を作る。
 *
 * - usage を記録されていない style (graph 外の未知 id を含む) は 1 style = 1 pack の
 *   singleton になる。黙って落とさない (unused-CSS は別途 warning 対象)。
 * - `maxChunkBytes` を超える group は member を (bytes desc, id asc) 順で first-fit する。
 *   単体で max を超える member は単独 pack になり、そこへは追い詰め追加しない。
 * - `minChunkBytes` 未満の pack は、最も類似 (jaccardSimilarity) した partner へ
 *   smallest-first で merge する (clustering v2)。similarity が similarityThreshold
 *   未満、または cost model (§40: requestOverheadBytes vs 無駄配信 bytes) が
 *   合わない partner とは merge しない。merge しても `min` に届かない pack は
 *   そのまま残す — request 爆発は pack 粒度で、unused CSS は warning で扱い、
 *   ここで無理に統合しない。
 */
export declare function planChunks(graph: UsageGraph, styles: readonly ChunkInput[], opts?: ChunkOptions): ChunkPlan[];
//#endregion
//#region src/manifest.d.ts
/** chunk hash の入力。最終 serialize 済み CSS bytes。 */
interface ChunkHashInput {
  readonly cssText: string;
}
/** §50: content hash が URL に含まれるため、変更時は URL が変わる。 */
export declare const IMMUTABLE_CACHE_HEADER: string;
declare const MANIFEST_VERSION = 1;
/**
 * §42: ChunkHash = H(finalSerializedCss)。
 * membership / source order ではなく、配信される CSS bytes だけから計算する (§3.3 の分離)。
 */
export declare function chunkHash(cssText: string): string;
/** §42: content-addressed asset 名。prefix は logical 名 (base / route など)。 */
export declare function assetFileName(prefix: string, hash: string): string;
/** 1 route が必要とする asset 群。sorted / deduped。 */
interface RouteManifestEntry {
  readonly route: string;
  readonly assets: readonly string[];
}
/** §45: route → required style packs。HASH-011: compiler version を記録する。 */
interface StyleManifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly compilerVersion: string;
  readonly entries: readonly RouteManifestEntry[];
}
/**
 * routeId -> asset file names から manifest を組む。
 * - entry は route asc。asset は dedupe + sort。
 * - asset を 1 つも持たない route は entry を作らない (RTE-008: 不要な asset link を出さない)。
 */
export declare function buildRouteManifest(routes: ReadonlyMap<string, readonly string[]>, opts: {
  readonly compilerVersion: string;
}): StyleManifest;
/**
 * manifest を stable JSON へ。2-space indent, key order は構成順で固定。
 * parse -> serialize を繰り返しても byte 等価になる。
 */
export declare function serializeManifest(manifest: StyleManifest): string;
/**
 * route が必要とする asset file names を返す。未知 route は空配列。
 * css-asset backend の route-loader が利用する純関数 (§45)。
 */
export declare function resolveRouteAssets(manifest: StyleManifest, route: string): readonly string[];
/**
 * manifest text を検証して読み込む。shape 外は null (FLB-007: corrupt cache は caller が捨てる)。
 * 読み込んだ manifest も sorted / deduped 不変を保つ。
 */
export declare function parseManifest(text: string): StyleManifest | null;
//#endregion
//#region src/cache.d.ts
/** computeCacheKey の入力。5 要素すべてが key に入る (§57)。 */
interface ComputeCacheKeyInput {
  readonly sourceHash: string;
  readonly compilerVersion: string;
  readonly configHash: string;
  readonly frontendVersion: string;
  readonly targetBrowsers: string;
}
/** §57: cache key = H(sourceHash, compilerVersion, configHash, frontendVersion, targetBrowsers)。 */
export declare function computeCacheKey(input: ComputeCacheKeyInput): string;
/** in-memory incremental cache。TTL 超過 entry は読み出し時に捨てる。 */
export declare class MemoryCache {
  private readonly ttlMs;
  constructor(ttlMs?: number);
  /** TTL 内の value を返す。期限切れ entry は返さず削除する。 */
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  delete(key: string): void;
  clear(): void;
  size(): number;
}
/**
 * HMR-008: key に sourceHash を含む entry だけを削除し、削除数を返す。
 * 他 source の entry は残る。空文字列は全 key に match するため何もしない。
 */
export declare function invalidateBySource(cache: MemoryCache, sourceHash: string): number;
/** FLB-007: 破損 cache text は例外ではなく null。caller は捨てて再計算する。 */
export declare function safeParse<T>(text: string): T | null;
//#endregion
//#region src/native-ir.d.ts
/** Immutable, framework-independent input to the native style compiler. */
interface SourceSpan {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}
type StyleWrapper = {
  readonly kind: "media" | "supports" | "container";
  readonly params: string;
} | {
  readonly kind: "layer";
  readonly name: string;
};
/** Text nodes come from a parsed selector; quoted ampersands are text, not subjects. */
type SelectorPart = {
  readonly kind: "subject";
} | {
  readonly kind: "text";
  readonly text: string;
};
interface StyleSelector {
  readonly alternatives: readonly (readonly SelectorPart[])[];
}
type SlotUnit = "length" | "unitless" | "raw";
type StyleValue = {
  readonly kind: "static";
  readonly css: string;
} | {
  readonly kind: "slot";
  readonly index: number;
  readonly unit: SlotUnit;
  readonly fallback?: string;
};
interface StyleDeclaration {
  readonly property: string;
  readonly value: StyleValue;
  readonly important: boolean;
}
interface NativeStyleRule {
  readonly selector: StyleSelector;
  readonly wrappers: readonly StyleWrapper[];
  readonly declarations: readonly StyleDeclaration[];
  readonly dependencies: readonly string[];
  readonly source?: SourceSpan;
}
interface NativeKeyframes {
  readonly kind: "keyframes";
  /** Ordered stylesheet wrappers enclosing this global rule. */
  readonly wrappers?: readonly StyleWrapper[];
  readonly frames: readonly {
    readonly selector: string;
    readonly declarations: readonly StyleDeclaration[];
  }[];
  readonly source?: SourceSpan;
}
interface NativeGlobal {
  readonly kind: "font-face" | "property";
  readonly name: string;
  /** Ordered stylesheet wrappers enclosing this global rule. */
  readonly wrappers?: readonly StyleWrapper[];
  readonly declarations: readonly StyleDeclaration[];
  readonly source?: SourceSpan;
}
/** A declaration identity excludes its owner, source location and generated class. */
interface DeclarationDefinition {
  readonly selector: StyleSelector;
  readonly wrappers: readonly StyleWrapper[];
  readonly declaration: StyleDeclaration;
  readonly dependencies: readonly string[];
}
/** One concrete render path and finite style choice, rather than an entire component. */
interface DemandSite {
  readonly id: string;
  readonly owner: string;
  readonly renderPath: string;
  readonly styleState: string;
  readonly lazyBoundary: string;
  /** Opaque canonical predicate produced by the frontend, never evaluated by core. */
  readonly predicate: string;
}
export declare const SUBJECT_SELECTOR: StyleSelector;
//#endregion
//#region src/native-diagnostic.d.ts
type NativeDiagnosticCode = "QS1001" | "QS1101" | "QS1102" | "QS1103" | "QS1201" | "QS1301" | "QS1401" | "QS1501" | "QS1601" | "QS1602" | "QS1603";
interface NativeDiagnostic {
  readonly code: NativeDiagnosticCode;
  readonly message: string;
  readonly source?: SourceSpan;
  readonly related?: readonly SourceSpan[];
  readonly fixHint?: string;
}
export declare class NativeStyleError extends Error {
  readonly diagnostic: NativeDiagnostic;
  readonly code: NativeDiagnosticCode;
  constructor(diagnostic: NativeDiagnostic);
}
//#endregion
//#region src/canonical.d.ts
export declare const CANONICAL_VERSION: string;
/** CSS token spelling is retained. Only fields without semantic order are sorted. */
export declare function canonicalStyleValue(value: StyleValue): readonly unknown[];
export declare function canonicalStyleDeclaration(declaration: StyleDeclaration): readonly unknown[];
export declare function canonicalStyleSelector(selector: StyleSelector): readonly unknown[];
export declare function canonicalStyleWrappers(wrappers: readonly StyleWrapper[]): readonly unknown[];
export declare function canonicalRule(rule: NativeStyleRule): string;
export declare function canonicalDeclaration(definition: DeclarationDefinition): string;
export declare function canonicalGlobal(global: NativeGlobal | NativeKeyframes): string;
//#endregion
//#region src/identity.d.ts
type NativeIdentityNamespace = "rule" | "declaration" | "class" | "slot-schema" | "keyframes" | "global" | "pack";
type NativeHasher = (input: string) => string;
export declare function sha256Prefix128(input: string): string;
/** Owned by one graph generation; content-addressed entries can never be updated in place. */
export declare class NativeIdentityRegistry {
  private readonly entries;
  private readonly hasher;
  constructor(hasher?: NativeHasher);
  identify(namespace: NativeIdentityNamespace, payload: string, source?: SourceSpan): string;
  get size(): number;
}
export declare function nativeClassName(declarations: readonly string[], registry: NativeIdentityRegistry): string;
export declare function nativeSlotName(schema: string, index: number, registry: NativeIdentityRegistry): string;
//#endregion
//#region src/native-values.d.ts
export declare function nativeProperty(input: string): string;
export declare function nativeSlotUnit(property: string): SlotUnit;
/** Shared static/dynamic number contract; strings retain their meaningful token whitespace. */
export declare function nativeStaticValue(property: string, value: string | number): StyleValue;
/** Build-time reference evaluator. The frontend emits an equivalent inline expression. */
export declare function evaluateNativeSlot(unit: SlotUnit, value: unknown): string | undefined;
//#endregion
//#region src/serialize.d.ts
export declare function slotSchema(declaration: StyleDeclaration): string;
export declare function declarationSlotName(declaration: StyleDeclaration, registry: NativeIdentityRegistry, contextSchema?: string): string | undefined;
export declare function serializeNativeDeclaration(declaration: StyleDeclaration, registry: NativeIdentityRegistry, contextSchema?: string): string;
/** All generated class selectors have equal specificity, including inside :is(). */
export declare function serializeNativeSelector(selector: StyleSelector, classNames: readonly string[]): string;
export declare function wrapNativeCss(css: string, wrappers: readonly StyleWrapper[]): string;
export declare function serializeNativeRule(rule: NativeStyleRule, classNames: readonly string[], registry: NativeIdentityRegistry): string;
/** Inline variable assignment must use exactly the same context schema as CSS emission. */
export declare function definitionSlotName(definition: DeclarationDefinition, registry: NativeIdentityRegistry): string | undefined;
export declare function serializeDeclarationDefinition(definition: DeclarationDefinition, classNames: readonly string[], registry: NativeIdentityRegistry): string;
export declare function serializeNativeGlobal(global: NativeGlobal | NativeKeyframes, registry: NativeIdentityRegistry, name?: string): string;
//#endregion
//#region src/declarations.d.ts
interface RegisteredDeclaration {
  readonly id: string;
  readonly definition: DeclarationDefinition;
  readonly demands: readonly DemandSite[];
  readonly sources: readonly SourceSpan[];
}
/** Site-wide table. No source-local registry or owner-specific declaration identity. */
export declare class DeclarationDictionary {
  readonly identities: NativeIdentityRegistry;
  private readonly records;
  private readonly sites;
  constructor(identities?: NativeIdentityRegistry);
  add(definition: DeclarationDefinition, demand: DemandSite, source?: SourceSpan): string;
  entries(): readonly RegisteredDeclaration[];
}
interface NativeStylePack {
  readonly id: string;
  readonly declarationIds: readonly string[];
  readonly globalIds?: readonly string[];
  readonly devKey?: string;
  readonly demandIds: readonly string[];
  readonly css: string;
  readonly cssBytes: number;
}
/**
 * Share only declarations with identical render demand. The supplied total order must
 * already be proved safe by the cascade verifier; grouping never reorders across packs.
 */
export declare function createNativePacks(dictionary: DeclarationDictionary, classesByDeclaration: ReadonlyMap<string, readonly string[]>, order: readonly string[], orderEdges?: readonly (readonly [string, string])[]): readonly NativeStylePack[];
//#endregion
//#region src/class-cover.d.ts
/**
 * Exact finite class-cover solver.
 *
 * The solver works on canonical declaration identities.  A class is a
 * non-empty set of declarations and may be assigned to a state only when the
 * class is a subset of that state's declarations.  The objective is
 * lexicographic: minimize the number of selected classes (K), then the total
 * number of state/class assignments (T).
 *
 * There are no selector-specific constraints in this core model.  Once the
 * union of the per-state order graphs is acyclic, one deterministic global
 * topological order is valid for every state.  That makes the usual
 * intersection-closure reduction complete: any feasible subset can be
 * expanded to the intersection of the states that can accept it (which
 * contains the original subset), without increasing K or T.  The independent
 * verifier and tests keep this proof boundary explicit.
 */
interface ClassCoverState {
  readonly id: string;
  readonly declarations: readonly string[];
  readonly order?: readonly (readonly [string, string])[];
}
interface ClassCoverResourceLimits {
  /** Maximum number of unique candidate classes. Defaults to 65,536. */
  readonly maxCandidates?: number;
  /** Maximum number of input states. Defaults to 65,536. */
  readonly maxStates?: number;
  /** Maximum exact-search / verification nodes. Defaults to 10,000,000. */
  readonly maxSearchNodes?: number;
}
interface ClassCoverObjective {
  readonly K: number;
  readonly T: number;
}
interface ClassCoverOptimality {
  readonly status: "optimal";
  readonly lowerBound: ClassCoverObjective;
  readonly upperBound: ClassCoverObjective;
}
type ClassCoverDiagnosticCode = "QS1601" | "QS1602";
interface ClassCoverDiagnostic {
  readonly code: ClassCoverDiagnosticCode;
  readonly message: string;
  readonly details?: readonly string[];
}
interface ClassCoverErrorOptions {
  readonly code: ClassCoverDiagnosticCode;
  readonly message: string;
  readonly details?: readonly string[];
  readonly exploredNodes?: number;
  readonly candidateCount?: number;
  readonly lowerBound?: ClassCoverObjective;
  readonly upperBound?: ClassCoverObjective;
}
/** A typed, fail-closed class-cover diagnostic. */
export declare class ClassCoverError extends Error {
  readonly code: ClassCoverDiagnosticCode;
  readonly diagnostic: ClassCoverDiagnostic;
  readonly exploredNodes: number;
  readonly candidateCount: number;
  readonly lowerBound: ClassCoverObjective | null;
  readonly upperBound: ClassCoverObjective | null;
  constructor(options: ClassCoverErrorOptions);
}
/** The result of an exact solve.  Assignment values are indexes into `basis`. */
interface ClassCoverResult {
  /** Selected class declaration sets, in canonical order. */
  readonly basis: readonly (readonly string[])[];
  /** Alias for consumers that call the selected basis `classes`. */
  readonly classes: readonly (readonly string[])[];
  /** State id -> indexes of classes assigned to that state. */
  readonly assignments: ReadonlyMap<string, readonly number[]>;
  /** Alias for consumers that use the longer name. */
  readonly perStateAssignments: ReadonlyMap<string, readonly number[]>;
  /** One deterministic topological order for all declarations. */
  readonly globalOrder: readonly string[];
  /** Alias for the topological order. */
  readonly topologicalOrder: readonly string[];
  readonly K: number;
  readonly T: number;
  readonly classCount: number;
  readonly assignmentCount: number;
  readonly lowerBound: ClassCoverObjective;
  readonly upperBound: ClassCoverObjective;
  readonly optimality: ClassCoverOptimality;
  readonly candidateCount: number;
  readonly exploredNodes: number;
}
export declare function solveClassCover(states: readonly ClassCoverState[], limits?: ClassCoverResourceLimits): ClassCoverResult;
//#endregion
//#region src/verify-cover.d.ts
type ClassCoverVerificationCode = "CANONICAL" | "ASSIGNMENT" | "COVERAGE" | "EXTRA" | "ORDER";
interface ClassCoverVerificationIssue {
  readonly code: ClassCoverVerificationCode;
  readonly message: string;
  readonly stateId?: string;
  readonly declaration?: string;
}
interface ClassCoverVerification {
  readonly ok: boolean;
  readonly valid: boolean;
  readonly issues: readonly ClassCoverVerificationIssue[];
  readonly errors: readonly string[];
  /**
   * Logical IR-union occurrence counts. This does not inspect final CSS
   * payloads; the final artifact verifier owns payload-duplication checks.
   */
  readonly declarationOccurrences: ReadonlyMap<string, number>;
}
/** Verify a solver result without relying on solver implementation details. */
export declare function verifyClassCover(states: readonly ClassCoverState[], result: ClassCoverResult): ClassCoverVerification;
//#endregion
//#region src/program.d.ts
interface StyleProgramState {
  readonly id: string;
  readonly demand: DemandSite;
  /** Rules in source/compose order. */
  readonly rules: readonly NativeStyleRule[];
}
interface OptimizedStyleProgram {
  readonly declarations: readonly RegisteredDeclaration[];
  /** Fixed external selectors are unique declarations, outside generated-class minimization. */
  readonly fixedDeclarations?: readonly RegisteredDeclaration[];
  readonly cover: ClassCoverResult;
  readonly classes: readonly string[];
  readonly classesByState: ReadonlyMap<string, readonly string[]>;
  readonly packs: readonly NativeStylePack[];
  readonly packsByDemand: ReadonlyMap<string, readonly string[]>;
  readonly duplicateDefinitionCount: 0;
  readonly duplicatePayloadCount: 0;
}
/** Fixed selectors retain generator order and use the same unique-payload/demand checks. */
export declare function optimizeFixedStyleProgram(states: readonly StyleProgramState[], identities?: NativeIdentityRegistry): {
  readonly declarations: readonly RegisteredDeclaration[];
  readonly packs: readonly NativeStylePack[];
};
/**
 * Whole-graph optimization; this never processes each route in isolation.
 * Unproven cascade ordering is retained conservatively and rejected if it
 * cannot coexist with unique payloads and exact render-demand partitioning.
 */
export declare function optimizeStyleProgram(states: readonly StyleProgramState[], limits?: ClassCoverResourceLimits, identities?: NativeIdentityRegistry, development?: boolean): OptimizedStyleProgram;
//#endregion
//#region src/index.d.ts
export declare const VERSION: string;
//#endregion
export type { AnyAtom, AtRuleDecl, ChunkHashInput, ChunkInput, ChunkOptions, ChunkPlan, ClassCoverObjective, ClassCoverResourceLimits, ClassCoverResult, ClassCoverState, ClassCoverVerification, ComputeCacheKeyInput, CreateParametricAtomInput, CreateStaticAtomInput, DeclarationDefinition, DedupAddResult, DemandSite, GlobalAtRule, IdentityRegisterOptions, IdentityRegisterResult, KeyframesFrame, KeyframesRule, NativeDiagnostic, NativeDiagnosticCode, NativeGlobal, NativeHasher, NativeIdentityNamespace, NativeKeyframes, NativeStylePack, NativeStyleRule, OptimizedStyleProgram, OrderingConstraints, ParametricAtom, Provenance, RegisteredDeclaration, ResidualReason, ResidualRuleNode, RouteManifestEntry, RuleContext, RuntimeSlotId, RuntimeSlotNode, RuntimeValueType, SelectorPart, SlotUnit, SourceSpan, StaticAtom, StyleCollision, StyleDeclaration, StyleManifest, StyleNode, StyleProgramState, StyleSelector, StyleValue, StyleWrapper, TemplatePartInput, TemplateSlotInput, UsageGraph, ValueTemplatePart };
//# sourceMappingURL=index.d.cts.map