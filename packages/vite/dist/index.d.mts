import { ResidualRuleNode, StaticAtom, UsageGraph } from "@qstyle/core";
import { UtilityAdapterFactory } from "@qstyle/compiler";
import { Plugin } from "vite";
//#region src/native-plugin.d.ts
interface NativeQstyleOptions {
  readonly utilities?: UtilityAdapterFactory;
  /** Additional local report file, written only after a successful output write. */
  readonly report?: {
    readonly file: string;
    readonly sources?: boolean;
  };
}
/** Native compiler with the package-owned Qwik style and SSR adapter. */
export declare function qstyleNative(options?: NativeQstyleOptions): [Plugin, Plugin];
//#endregion
//#region src/index.d.ts
export type OptimizationLevel = "preserve" | "safe" | "strict";
/**
 * FLB-008/009: サポートする peer major。範囲外は diagnostics に従い警告/throw
 * (silent miscompile ではなく明示 error。Qwik β/vite 8 前提の glue を守る)。
 */
export declare const SUPPORTED_QWIK_MAJOR = 2;
export declare const SUPPORTED_VITE_MAJOR = 8;
/** `2.0.0-beta.43` / `v8.2.2` 等から major を取る。取れなければ null。 */
export declare function peerMajor(version: string): number | null;
/**
 * FLB-008/009: peer version の検査 (純関数)。問題が無ければ空配列。
 * version 不明 (解決不能) も問題として返す (黙って通さない)。
 */
export declare function checkPeerVersions(versions: {
  readonly qwik?: string | undefined;
  readonly vite?: string | undefined;
}): string[];
export interface QstyleOptions {
  readonly optimization?: OptimizationLevel | undefined;
  readonly runtimeStyles?: {
    readonly strategy?: "custom-property" | undefined;
    readonly fallback?: "inline" | undefined;
    readonly promotion?: "never" | "cost-based" | "always" | undefined;
  } | undefined;
  readonly composition?: {
    readonly falsy?: "ignore" | undefined;
  } | undefined;
  readonly chunking?: {
    readonly strategy?: "usage-cluster" | undefined;
    readonly minChunkBytes?: number | undefined;
    readonly maxChunkBytes?: number | undefined;
    /** clustering v2 (R3): merge を許す最小 jaccard similarity (default 0.3)。 */
    readonly similarityThreshold?: number | undefined;
    /** clustering v2 (R3): 1 request の等価 overhead bytes (default 512)。 */
    readonly requestOverheadBytes?: number | undefined;
  } | undefined;
  /** route -> その route が描画する module path の list (§45 route manifest の逆引き元)。
   * `'auto'` または未指定時は `<root>/src/routes` を走査して自動検出する
   * (Qwik City 規約。手動指定時はそれを使う)。 */
  readonly routes?: Record<string, readonly string[]> | "auto" | undefined;
  readonly diagnostics?: "silent" | "warning" | "error" | undefined;
  readonly debug?: boolean | undefined;
  /**
   * dev HMR の調整。構造変化 (occurrence 構造の変化) を含む編集では dev alias
   * がずれるため、確実に整合する状態へ戻すには page reload が要る。reload は
   * qwik の `qwik:hmr` (bridge) が 500ms 判定を行う**後**に送る。即時送ると
   * bridge の再 render / chunk import と二重 navigation になり、QRL chunk の
   * dynamic import が abort して "Importing a module script failed" +
   * リロード不完了になる (0.1.0 の regression)。
   */
  readonly devHmr?: {
    /** 構造変化検出から full-reload 送信までの遅延 ms (default 700)。 */
    readonly reloadDelayMs?: number | undefined;
  } | undefined;
}
export interface CollectedStyle {
  readonly id: string;
  readonly cssText: string;
  readonly sourceId: string;
  /** unit 構成 atom ids (delivery = unit、identity = atom。§3.3/§38)。 */
  readonly members?: readonly string[];
}
/**
 * chunk (unit の集合) の route 分類。manifest (qstyle-manifest.json) の
 * chunkPlans メタデータ用。users が張る route が 1 つなら route-local、
 * 複数なら shared、未配線なら unrouted。
 */
export type ChunkClassification = "route-local" | "shared" | "unrouted";
/**
 * R2: chunk (unit の集合) を route 分類する純関数。usage graph の
 * style -> component -> route を逆順に辿り、到達する route の集合から
 * 1 route → route-local / 複数 → shared / 0 route (routes option 未配線) → unrouted
 * を決める。決定性のため route は常に sort する。
 */
export declare function classifyChunkUnits(graph: UsageGraph, members: readonly string[]): {
  classification: ChunkClassification;
  routes: readonly string[];
};
/**
 * build 時 module graph (Rollup/Vite が解決済みの import 辺)。
 * `generateBundle` の plugin context から作る。unit test 等 context が無い場合は
 * 渡さない (entry のみ配線に fallback)。
 */
export interface RouteModuleGraph {
  readonly ids: readonly string[];
  readonly importedIdsOf: (id: string) => readonly string[];
}
/**
 * route entry から import を連鎖的に辿り、各 route が到達する module 群へ展開する。
 * static + dynamic import を区別しない (style 到達性はどちらも同じ)。
 * virtual (`\0`)・query 付きは辿らない。cycle safe。決定性のため出力は sort。
 * graph に無い entry (graph 外・test 等) は entry 自身のみ残す (落とさない)。
 */
export declare function closeRouteModules(entries: Record<string, readonly string[]>, graph: RouteModuleGraph): Record<string, string[]>;
/**
 * `<root>/src/routes` を走査し route -> module paths を自動検出する (Qwik City 規約)。
 * - `src/routes/index.tsx` → `/`、同一 dir の co-located file は同 route に束ねる
 *   (`src/routes/about/card.tsx` → `/about`)
 * - top-level の `foo.tsx` → `/foo`。dotfiles / `*.d.ts` / `*.test.*` 等は除外。
 * - dir 不在・走査失敗時は `{}` (routes 未配線と同等。黙って落とさず空にする)。
 * - 決定性のため module list は sort する。entry から import 連鎖で辿れる module は
 *   `closeRouteModules` (generateBundle 時) が各 route に展開するため、ここでは
 *   entry 列挙のみ行う。
 */
export declare function discoverRoutes(rootDir: string): Record<string, string[]>;
/**
 * legacy Qwik style hook の利用記録 (plan.md §24)。
 * scoped semantics は解除せず Qwik lifecycle に残すため、rewrite 対象にはしない。
 * provenance 追跡と将来の SSG route linkage の入力にする。
 */
export interface LegacyStyleUsage {
  readonly module: string;
  /** `useStyles$` (global) / `useStylesScoped$` (scoped)。 */
  readonly hook: "global" | "scoped";
  /** hook に渡された identifier。 */
  readonly local: string;
  /** `*.css?inline` import で解決できた CSS path。解決できなければ null。 */
  readonly cssPath: string | null;
}
/** 動的な値として抽出した 1 宣言分の情報 (M5c)。 */
export interface DynamicStyleValue {
  /** diagnostic 用の dotted path (top-level なら key そのもの)。 */
  readonly propPath: string;
  /** 抽出した式の source text (identifier / member chain のみ)。 */
  readonly exprSource: string;
}
/**
 * 有限静的 ternary 値 (DYN-016: `color: cond ? 'red' : 'gray'`)。
 * 両枝が static literal (string/number) または null の場合のみ成立し、
 * ParametricAtom ではなく複数 StaticAtom + runtime class choice にする。
 */
export interface ConditionalStyleValue {
  /** top-level property のみ (nested は呼び出し側で拒否する)。 */
  readonly propPath: string;
  /** 条件式の source text。 */
  readonly condSource: string;
  readonly whenTrue: string | number | null;
  readonly whenFalse: string | number | null;
}
/**
 * object 構文内の template literal 値 (DYN-006/007: `` transform: `translateX(${x}px)` ``)。
 * 静的部分と runtime 式の交互列を AST として保ち、複合 ParametricAtom へ落とす。
 */
export interface CompoundStyleValue {
  /** top-level property のみ (nested は呼び出し側で拒否する)。 */
  readonly propPath: string;
  readonly segments: readonly ({
    readonly kind: "text";
    readonly text: string;
  } | {
    readonly kind: "expr";
    readonly expr: string;
  })[];
}
export interface ParsedStyleLiteral {
  /** 静的に解決できた宣言のみを含む record (動的な key は除外)。 */
  readonly record: Record<string, unknown>;
  readonly dynamics: readonly DynamicStyleValue[];
  readonly conditionals: readonly ConditionalStyleValue[];
  readonly compounds: readonly CompoundStyleValue[];
}
/**
 * 静的な style object literal のみを受理するパーサ (M2)。
 * identifier 値など動的な構文は null になる。
 */
export declare function parseStyleObjectLiteral(src: string): Record<string, unknown> | null;
/**
 * 静的宣言と動的な値 (identifier / member chain) を分離して抽出する (M5c)。
 * 対応不能な構文は null を返し、呼び出し側は当該出現箇所を触らない。
 * R4: notes を渡すと parse 不能になった具体的な理由 (nested ternary 等) が積まれる。
 */
export declare function parseStyleObjectLiteralWithDynamics(src: string, notes?: string[] | undefined): ParsedStyleLiteral | null;
/**
 * StaticAtom を CSS rule へ serialize する (M2 最小版: context 対応)。
 * 決定論的であり chunk membership を含めない。
 */
export declare function serializeAtomCss(atom: StaticAtom, className: string): string;
/** transform が返す source map (sourcesContent 付き)。Vite の TransformResult と互換。 */
export interface QstyleSourceMap {
  readonly version: 3;
  readonly sources: string[];
  readonly sourcesContent: string[];
  readonly names: string[];
  readonly mappings: string;
}
/** original 座標での置換。newText の各行は srcLine (0-based) を指す。 */
export interface CodeEdit {
  readonly start: number;
  readonly end: number;
  readonly newText: string;
  readonly srcLine: number;
}
/** source map 用の base64 VLQ エンコーダ (依存なしの最小実装)。 */
export declare function encodeVlq(value: number): string;
/** original 行番号 (0-based) を返す。範囲外は clamp する。 */
export declare function originalLineOf(code: string, offset: number): number;
/**
 * edits を適用して出力 + source map を作る。edits は original 座標。
 * 重なる edits は先勝ち (file order) で後者を落とす。
 * 未編集 gap は精密 mapping、編集部の行は srcLine を指す (css prop 箇所の追跡用)。
 */
export declare function applyEditsWithMap(original: string, sourceId: string, edits: readonly CodeEdit[]): {
  code: string;
  map: QstyleSourceMap;
};
/**
 * qstyle Vite plugin — Milestone 2 object-syntax lowering (plan.md §89)
 * + Milestone 3 css() handle / composition lowering (plan.md §90)。
 * - virtual modules: registry / pack/<id> / manifest / residuals,
 *   dev/<hash>.css (serve 時のみ)
 * - serve (dev): 同一 lowering を per-module CSS としてそのまま適用する
 *   (global dedup・chunking・manifest なし)。virtual css 経由で Vite の CSS HMR が効く。
 *   ファイル変更時は handleHotUpdate で先行 re-transform 後に該当 virtual css を
 *   無効化し `css-update` を送る (出力が変わった場合のみ client へ reload)。
 * - transform: .tsx/.jsx 内の css={{ ... }} を balanced-brace scan で抽出し、
 *   安全に parse できる object literal のみ @qstyle/qwik の lowerStyleObject
 *   で atom 化→hash→ class へ rewrite し、モジュール先頭へ side-effect
 *   import "virtual:qstyle/pack/HASH" を注入する。import graph 経由で
 *   vite/qwik の標準 CSS 配管に載るため、qstyle 固有の client runtime は不要。
 *   既存 class 属性があれば追記する。
 *   M5c: identifier / member chain の値は ParametricAtom (slot var) 化し、
 *   class へ追記した上で既存/新規 style prop へ代入を merge する。
 *   module-scope の static `css({...})` handle と `css={...}` composition
 *   (handle 参照・static inline・falsy・nested array) も解決する (M3)。
 *   条件付き・未知参照・衝突 dynamic は untouched にする。
 *   residual が残るもの・parse 不能なものは触らない (correctness first)。
 *   strict mode では untouched 箇所を compile error にする (plan.md §61)。
 * - generateBundle: qstyle-manifest.json (debug/inspector 用 metadata) を emit。
 */
export declare function qstyle(options?: QstyleOptions): [Plugin & {
  readonly __usageGraph: UsageGraph;
  readonly __residuals: readonly ResidualRuleNode[];
  readonly __legacyStyles: readonly LegacyStyleUsage[];
}, Plugin];
//#endregion
export { type NativeQstyleOptions, qstyle as default };
//# sourceMappingURL=index.d.mts.map