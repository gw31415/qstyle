// @qstyle/qwik — MVP authoring API surface (plan.md §19-24)。
// Milestone 2 以降で transform 本体を実装する。現時点では型 + runtime stub。
export interface StyleHandle {
  readonly __qstyleBrand: 'StyleHandle';
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
  void _values;
  void arg;
  // M0 stub: transform 前の dev fallback として空 handle を返す。
  return { __qstyleBrand: 'StyleHandle' };
}
