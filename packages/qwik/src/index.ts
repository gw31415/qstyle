// @qstyle/qwik — MVP authoring API surface (plan.md §19-24)。
// Milestone 2 以降で transform 本体を実装する。現時点では型 + runtime stub。
import type { AtRule, Properties, PropertiesHyphen } from 'csstype';
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

/**
 * 宣言値。Qwik の `style` (`CSSProperties`) と同じ出自 (csstype) の
 * `string | number` に、qstyle の falsy 消化 (`null` / `undefined` / 真偽値は
 * 無視する。`cond && 'red'` 形の条件値を型で許すため) を加えたもの。
 */
export type CssDeclarationValue = CssPrimitive | boolean | null | undefined;

/**
 * 宣言値の falsy 消化 (`null` / 真偽値は実行時に無視される。`undefined` は
 * csstype 側が既に許す)。`cond && 'red'` 形の条件値を型で許すため、
 * generics の届かない非寸法 property (color / display 等) も含め全宣言に付与する。
 * csstype の value literal union は残るため、LSP の値補完は効く。
 */
type Falsyable<T> = { readonly [K in keyof T]?: T[K] | boolean | null };

/**
 * フラットな宣言集合。Qwik の `CSSProperties`
 * (`Properties` + `PropertiesHyphen` + `--*` custom property) と同じ出自で、
 * 値だけ falsy 消化のため広げている (`style` 属性の型の流用)。
 * index signature を持たない closed typing のため、未知 property は型 error
 * になり、LSP 補完が効く (camelCase / kebab-case 両対応)。
 */
export type StyleDeclarations = Falsyable<Properties<CssDeclarationValue, CssDeclarationValue>> &
  Falsyable<PropertiesHyphen<CssDeclarationValue, CssDeclarationValue>> & {
    readonly [V in `--${string}`]?: CssDeclarationValue;
  };

/** `@keyframes` の中身 (`from` / `to` / `0%` とそのカンマ並び。frame 名は実行時に検証)。 */
export interface KeyframesBody {
  readonly [frame: string]: StyleDeclarations;
}

/** `@font-face` の中身 (csstype の at-rule 定義を流用)。 */
export type FontFaceBody = AtRule.FontFace & AtRule.FontFaceHyphen;

/** `@property --*` の中身 (csstype の at-rule 定義を流用)。 */
export type PropertyBody = AtRule.Property & AtRule.PropertyHyphen;

/**
 * ネスト先の値。条件付き (`cond && {...}` / `c ? {...} : undefined`) の falsy を
 * 許す (実行時は無視される)。
 */
export type NestedStyleValue = StyleObject | boolean | null | undefined;

/** セレクタネスト (`&:hover` / `& .tile` / `&--mod` 等。suffix 形の当否は実行時に検証)。 */
export type StyleSelectorNesting = {
  readonly [K in `&${string}`]?: NestedStyleValue;
};

/** 条件 at-rule ネスト (`@media` / `@supports` / `@container` / `@layer`。条件 text は素通し)。 */
export type StyleConditionNesting = {
  readonly [K in
    `@media${string}` | `@supports${string}` | `@container${string}` | `@layer${string}`]?: NestedStyleValue;
};

/** top-level の `@keyframes` 定義 (nested は実行時 residual)。 */
export type StyleKeyframesNesting = {
  readonly [K in `@keyframes${string}`]?: KeyframesBody;
};

/** top-level の `@font-face` / `@property` 定義 (nested は実行時 residual)。 */
export type StyleFontFaceNesting = {
  readonly '@font-face'?: FontFaceBody;
};
export type StylePropertyNesting = {
  readonly [K in `@property${string}`]?: PropertyBody;
};

/**
 * `css()` / `css` prop の object 記法。
 * Qwik の `style` と同じ csstype 出自の宣言に、qstyle 固有のネスト
 * (`&...` / `@media` 等) と top-level at-rule (`@keyframes` 等) を足したもの。
 * Qwik の `ClassList` とも `style` (`CSSProperties`) とも別型
 * (ネスト・条件・keyframes を扱うため)。closed typing のため未知 property・
 * 未対応 at-rule は型 error になり、LSP 補完が効く。
 */
export type StyleObject = StyleDeclarations &
  StyleSelectorNesting &
  StyleConditionNesting &
  StyleKeyframesNesting &
  StyleFontFaceNesting &
  StylePropertyNesting;

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
