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

export type StyleNode = StaticAtom | ResidualRuleNode;

/**
 * 最適化不能として residual に落とした理由 (plan.md §15, §59)。
 * Milestone 1 では分類語彙のみ定義し、判定ロジックは M6 で実装する。
 */
export type ResidualReason =
  | 'unsupported-selector'
  | 'unsupported-at-rule'
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
// Milestone 2+ で ParametricAtom 等を StyleNode に追加する。
