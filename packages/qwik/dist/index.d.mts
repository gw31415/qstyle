import { AnyAtom, GlobalAtRule, KeyframesRule, ParametricAtom, ResidualRuleNode, RuleContext, StaticAtom } from "@qstyle/core";
import { AtRule, Properties, PropertiesHyphen } from "csstype";
//#region src/object.d.ts
interface Diagnostic {
  readonly severity: "warn" | "error";
  readonly message: string;
}
interface LoweredStyle {
  readonly atoms: StaticAtom[];
  readonly residuals: ResidualRuleNode[];
  readonly diagnostics: Diagnostic[];
  readonly keyframes: KeyframesRule[];
  readonly globals: GlobalAtRule[];
}
interface LowerOptions {
  readonly source?: string | undefined;
  /**
   * module 内の `@keyframes` 定義表 (sourceName -> 確定名)。同一オブジェクト内の
   * 定義を優先し、不足分のみ参照する (定義と参照の分離配置用)。
   */
  readonly keyframes?: ReadonlyMap<string, string> | undefined;
}
interface ImportantSplit {
  readonly value: string;
  readonly important: boolean;
}
/**
 * 末尾 `!important` を value 文字列から important flag へ分離する。
 * template literal 側 (template.ts) と共有する。
 */
export declare function splitImportant(raw: string): ImportantSplit;
/**
 * ネストキー (`&:hover` / `& span.x` / `@media ...` 等) を context 差分へ変換する。
 * template literal 側 (template.ts) と共有する。対応不能なら null。
 * `&` は単純形 (pseudo / 単純子孫) を優先し、それ以外は広域ルールの
 * suffix (` > svg` / `--mod` / `:hover, :focus` 等) として受理する。
 */
export declare function parseNestedKey(key: string): RuleContext | null;
export declare function mergeRuleContext(base: RuleContext, delta: RuleContext): RuleContext;
/**
 * `css` prop / `css()` object syntax を Style IR へ lowering する (plan.md §20)。
 * 安全に atomize できないものは ResidualRuleNode + warn diagnostic に落とし、
 * silent miscompile しない (correctness first)。
 * top-level の `@keyframes` / `@font-face` / `@property` は global 系 IR へ落とす
 * (nested は residual)。`@keyframes` 定義名は同一オブジェクト内の
 * `animation` / `animation-name` 参照へ書換える (内容 hash 名で重複排除)。
 */
export declare function lowerStyleObject(style: StyleObject, opts?: LowerOptions): LoweredStyle;
//#endregion
//#region src/compose.d.ts
interface ComposedStyle {
  readonly atoms: AnyAtom[];
  /** 最終的に残った ParametricAtom (atoms の subset、出現順)。 */
  readonly parametrics: ParametricAtom[];
  readonly residuals: ResidualRuleNode[];
  readonly diagnostics: Diagnostic[];
  readonly keyframes: KeyframesRule[];
  readonly globals: GlobalAtRule[];
}
export declare function isStyleHandle(value: unknown): value is StyleHandle;
/**
 * CssProp を左→右の順序を保ったまま flatten する (plan.md §21.1)。
 * falsy 値 (false/null/undefined) は無視し、nested array を展開する。
 */
export declare function flattenCssProp(prop: CssProp): Array<StyleObject | StyleHandle>;
/**
 * css prop 配列を単一の Style IR 寄与へ composition する (plan.md §21)。
 * 同一 conflict key は後勝ち (earlier を除去して末尾へ移動) し、
 * 完全同一 semantic は dedup する。
 */
export declare function composeCssProp(prop: CssProp, opts?: {
  readonly source?: string | undefined;
  readonly keyframes?: ReadonlyMap<string, string> | undefined;
}): ComposedStyle;
//#endregion
//#region src/template.d.ts
interface TemplateLowerOptions {
  readonly source?: string | undefined;
}
interface LoweredTemplate {
  readonly atoms: StaticAtom[];
  readonly parametrics: ParametricAtom[];
  readonly residuals: ResidualRuleNode[];
  readonly diagnostics: Diagnostic[];
  readonly keyframes: KeyframesRule[];
  readonly globals: GlobalAtRule[];
}
/**
 * `css` tagged template literal を Style IR へ lowering する (plan.md §22)。
 * object syntax と同一の canonical IR に落とすため、両記法の等価な宣言は
 * 同一 semantic hash になる (TPL-017)。decl value 内の runtime interpolation
 * は ParametricAtom (M5b) へ落とし、それ以外の marker (prop / selector / 単独)
 * は residual + warn に落とす。
 */
export declare function lowerTaggedTemplate(strings: TemplateStringsArray | readonly string[], values: readonly unknown[], opts?: TemplateLowerOptions): LoweredTemplate;
//#endregion
//#region src/index.d.ts
export interface StyleHandle {
  readonly __qstyleBrand: "StyleHandle";
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
type Falsyable<T> = { readonly [K in keyof T]?: T[K] | boolean | null; };
/**
 * フラットな宣言集合。Qwik の `CSSProperties`
 * (`Properties` + `PropertiesHyphen` + `--*` custom property) と同じ出自で、
 * 値だけ falsy 消化のため広げている (`style` 属性の型の流用)。
 * index signature を持たない closed typing のため、未知 property は型 error
 * になり、LSP 補完が効く (camelCase / kebab-case 両対応)。
 */
export type StyleDeclarations = Falsyable<Properties<CssDeclarationValue, CssDeclarationValue>> & Falsyable<PropertiesHyphen<CssDeclarationValue, CssDeclarationValue>> & { readonly [V in `--${string}`]?: CssDeclarationValue; };
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
export type StyleSelectorNesting = { readonly [K in `&${string}`]?: NestedStyleValue; };
/** 条件 at-rule ネスト (`@media` / `@supports` / `@container` / `@layer`。条件 text は素通し)。 */
export type StyleConditionNesting = { readonly [K in `@media${string}` | `@supports${string}` | `@container${string}` | `@layer${string}`]?: NestedStyleValue; };
/** top-level の `@keyframes` 定義 (nested は実行時 residual)。 */
export type StyleKeyframesNesting = { readonly [K in `@keyframes${string}`]?: KeyframesBody; };
/** top-level の `@font-face` / `@property` 定義 (nested は実行時 residual)。 */
export type StyleFontFaceNesting = {
  readonly "@font-face"?: FontFaceBody;
};
export type StylePropertyNesting = { readonly [K in `@property${string}`]?: PropertyBody; };
/**
 * `css()` / `css` prop の object 記法。
 * Qwik の `style` と同じ csstype 出自の宣言に、qstyle 固有のネスト
 * (`&...` / `@media` 等) と top-level at-rule (`@keyframes` 等) を足したもの。
 * Qwik の `ClassList` とも `style` (`CSSProperties`) とも別型
 * (ネスト・条件・keyframes を扱うため)。closed typing のため未知 property・
 * 未対応 at-rule は型 error になり、LSP 補完が効く。
 */
export type StyleObject = StyleDeclarations & StyleSelectorNesting & StyleConditionNesting & StyleKeyframesNesting & StyleFontFaceNesting & StylePropertyNesting;
export type CssProp = StyleObject | StyleHandle | false | null | undefined | readonly CssProp[];
/** css() object syntax overload (Milestone 2/3 で compile-time handle 化)。 */
export declare function css(style: StyleObject): StyleHandle;
/** css tagged template literal overload (Milestone 4)。 */
export declare function css(strings: TemplateStringsArray, ...values: readonly unknown[]): StyleHandle;
//#endregion
export type { ComposedStyle, Diagnostic, ImportantSplit, LowerOptions, LoweredStyle, TemplateLowerOptions };
//# sourceMappingURL=index.d.mts.map