// Style IR 最小定義 (plan.md §8-15)。Milestone 1 で拡張。
// frontend-neutral: Qwik/css 固有の文字列・AST node を要求しない。

export interface RuleContext {
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

export interface OrderingConstraints {
  readonly after?: readonly string[] | undefined;
  readonly before?: readonly string[] | undefined;
  readonly group?: string | undefined;
}

export interface Provenance {
  readonly source: string;
  readonly line: number;
  readonly column: number;
}

export interface StaticAtom {
  readonly kind: 'static-atom';
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
  readonly context: RuleContext;
  readonly ordering: OrderingConstraints;
  readonly provenance: readonly Provenance[];
}

export type StyleNode = StaticAtom | ParametricAtom | KeyframesRule | GlobalAtRule | ResidualRuleNode;

/** static / parametric を区別しない atom 処理用の合併型。 */
export type AnyAtom = StaticAtom | ParametricAtom;

/**
 * 最適化不能として residual に落とした理由 (plan.md §15, §59)。
 * Milestone 1 では分類語彙のみ定義し、判定ロジックは M6 で実装する。
 */
export type ResidualReason =
  | 'unsupported-selector'
  | 'unsupported-at-rule'
  | 'unsupported-value'
  | 'shorthand-ordering'
  | 'source-order-sensitive'
  | 'unsupported-syntax'
  | 'third-party-preservation'
  | 'unknown';

/**
 * 安全な atomicization / dedup が保証できないルール (plan.md §15)。
 * cssText は frontend-neutral な CSS ソース断片 (AST node ではない)。
 */
export interface ResidualRuleNode {
  readonly kind: 'residual-rule';
  readonly cssText: string;
  readonly scope: 'global' | 'component';
  readonly reason: ResidualReason;
  readonly provenance: readonly Provenance[];
}
/**
 * runtime 値の型注釈 (plan.md §12)。semantic identity には型のみを含め、
 * source 変数名や実際の値は含めない。
 */
export type RuntimeValueType =
  | 'number'
  | 'integer'
  | 'length'
  | 'percentage'
  | 'color'
  | 'angle'
  | 'time'
  | 'transform-function'
  | 'image'
  | 'custom';

export type RuntimeSlotId = string;

export interface RuntimeSlotNode {
  readonly kind: 'runtime-slot';
  readonly id: RuntimeSlotId;
  readonly valueType: RuntimeValueType;
  readonly fallback?: CanonicalValue | undefined;
}

export type CanonicalValue = string;

/**
 * 複合 dynamic value の AST 表現 (plan.md §13)。
 * 文字列結合ではなく static text と slot 参照の列で表す。
 */
export type ValueTemplatePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'slot'; readonly slotIndex: number };

/**
 * 値だけが runtime で構造が静的な style (plan.md §11)。
 * 実際の値は hash に含めず、同一構造は共有可能な ParametricAtom になる。
 */
export interface ParametricAtom {
  readonly kind: 'parametric-atom';
  readonly property: string;
  readonly valueTemplate: readonly ValueTemplatePart[];
  readonly slots: readonly RuntimeSlotNode[];
  readonly important: boolean;
  readonly context: RuleContext;
  readonly ordering: OrderingConstraints;
  readonly provenance: readonly Provenance[];
}
// Milestone 5b 以降で ThemeVariable / Keyframes 等を StyleNode に追加する。

/** `@keyframes` 内の 1 宣言 (通常宣言と同一 canonical 則)。 */
export interface AtRuleDecl {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
}

export interface KeyframesFrame {
  /** `from` / `to` / `0%` / `0%, 100%` (正規化済み小文字)。 */
  readonly selector: string;
  readonly decls: readonly AtRuleDecl[];
}

/**
 * `@keyframes` 定義。name は内容 hash 由来 (`qkf_xxxxxxxx`) で
 * グローバルに安定 (同一内容は同一名に畳まれる)。sourceName は解決用。
 */
export interface KeyframesRule {
  readonly kind: 'keyframes-rule';
  readonly name: string;
  readonly sourceName: string;
  readonly frames: readonly KeyframesFrame[];
  readonly provenance: readonly Provenance[];
}

/** `@font-face` / `@property` (宣言ブロックのみのグローバル at-rule)。 */
export interface GlobalAtRule {
  readonly kind: 'global-at-rule';
  readonly at: 'font-face' | 'property';
  /** `@font-face` は ''、`@property` は `--x`。 */
  readonly prelude: string;
  readonly decls: readonly AtRuleDecl[];
  /** 内容アドレス id (`qg_xxxxxxxx`)。同一内容は emit 単位で自然 dedup される。 */
  readonly id: string;
  readonly provenance: readonly Provenance[];
}
