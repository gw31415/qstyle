import type * as t from '@babel/types';
import type { SourceSpan } from '@qstyle/core';

export type EvaluatedPrimitive = string | number | boolean | null | undefined;

export interface RuntimeExpression {
  readonly kind: 'runtime';
  readonly node: t.Expression;
  readonly code: string;
  readonly source: SourceSpan;
}

export type EvaluatedValue =
  | { readonly kind: 'literal'; readonly value: EvaluatedPrimitive }
  | {
      readonly kind: 'object';
      /** Final JS object order; duplicate keys replace values at their first position. */
      readonly entries: readonly (readonly [string, EvaluatedValue])[];
      /** Runtime evaluations including overwritten values, in original JS order. */
      readonly effects: readonly RuntimeExpression[];
    }
  | { readonly kind: 'array'; readonly items: readonly EvaluatedValue[]; readonly effects: readonly RuntimeExpression[] }
  | RuntimeExpression;
