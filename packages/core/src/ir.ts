// Style IR 最小定義 (plan.md §8-15)。Milestone 1 で拡張。
// frontend-neutral: Qwik/css 固有の文字列・AST node を要求しない。

export interface RuleContext {
  readonly pseudo?: readonly string[];
  readonly media?: string | undefined;
  readonly supports?: string | undefined;
  readonly container?: string | undefined;
  readonly layer?: string | undefined;
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

export type StyleNode = StaticAtom | ParametricAtom | ResidualRuleNode;

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
