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

export type StyleNode = StaticAtom;
// Milestone 2+ で ParametricAtom | ResidualRuleNode 等を追加する。
