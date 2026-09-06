// @qstyle/qwik — MVP authoring API surface (plan.md §19-24)。
// Milestone 2 以降で transform 本体を実装する。現時点では型 + runtime stub。
import type { GlobalAtRule, KeyframesRule, ParametricAtom, ResidualRuleNode, StaticAtom } from '@qstyle/core';
import { lowerStyleObject } from './object.js';

export interface StyleHandle {
  readonly __qstyleBrand: 'StyleHandle';
  /** compile 時に確定した static 寄与 (M4 以降は template 由来も含む)。 */
  readonly atoms: readonly StaticAtom[];
  /** runtime 値スロットを持つ共有可能構造 (M5b 以降)。 */
  readonly parametrics: readonly ParametricAtom[];
  readonly residuals: readonly ResidualRuleNode[];
  /** 同一オブジェクト内で定義された `@keyframes` (内容 hash 名で重複排除)。 */
  readonly keyframes: readonly KeyframesRule[];
  /** 同一オブジェクト内で定義された `@font-face` / `@property`。 */
  readonly globals: readonly GlobalAtRule[];
}
export { lowerStyleObject, mergeRuleContext, parseNestedKey, splitImportant } from './object.js';
export type { Diagnostic, ImportantSplit, LowerOptions, LoweredStyle } from './object.js';
export { composeCssProp, flattenCssProp, isStyleHandle } from './compose.js';
export type { ComposedStyle } from './compose.js';
export { lowerTaggedTemplate } from './template.js';
export type { TemplateLowerOptions } from './template.js';
import { lowerTaggedTemplate } from './template.js';

function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && 'raw' in (value as unknown as Record<string, unknown>);
}

export type CssPrimitive = string | number;

export type StyleObject = {
  readonly [K in string]?: CssPrimitive | boolean | null | undefined | StyleObject;
};

export type CssProp =
  | StyleObject
  | StyleHandle
  | false
  | null
  | undefined
  | readonly CssProp[];

/** css() object syntax overload (Milestone 2/3 で compile-time handle 化)。 */
export function css(style: StyleObject): StyleHandle;
/** css tagged template literal overload (Milestone 4)。 */
export function css(strings: TemplateStringsArray, ...values: readonly unknown[]): StyleHandle;
export function css(
  arg: StyleObject | TemplateStringsArray,
  ..._values: readonly unknown[]
): StyleHandle {
  // tagged template literal は lowerTaggedTemplate で lowering する。
  if (isTemplateStringsArray(arg)) {
    const lowered = lowerTaggedTemplate(arg, _values);
    return {
      __qstyleBrand: 'StyleHandle',
      atoms: lowered.atoms,
      parametrics: lowered.parametrics,
      residuals: lowered.residuals,
      keyframes: lowered.keyframes,
      globals: lowered.globals,
    };
  }
  // object syntax は eager に lowering して handle に保持する。
  // build 時 transform が handle 参照を解決するまでの dev fallback でもある。
  const lowered = lowerStyleObject(arg);
  return {
    __qstyleBrand: 'StyleHandle',
    atoms: lowered.atoms,
    parametrics: [],
    residuals: lowered.residuals,
    keyframes: lowered.keyframes,
    globals: lowered.globals,
  };
}
