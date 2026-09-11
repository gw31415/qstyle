import { Binding, NodePath } from "@babel/traverse";
import { DeclarationDefinition, NativeGlobal, NativeIdentityRegistry, NativeKeyframes, NativeStyleRule, OptimizedStyleProgram, SourceSpan, StyleProgramState, StyleSelector, StyleWrapper } from "@qstyle/core";
import * as t from "@babel/types";
import MagicString from "magic-string";
//#region src/parse.d.ts
interface ParsedStyleModule {
  readonly file: string;
  readonly code: string;
  readonly ast: t.File;
  readonly program: NodePath<t.Program>;
}
export declare function sourceSpan(file: string, node: t.Node): SourceSpan;
/** Parsing never recovers to a partial AST: all syntax must be accounted for. */
export declare function parseStyleModule(code: string, file: string): ParsedStyleModule;
//#endregion
//#region src/bindings.d.ts
interface ImportedBinding {
  readonly source: string;
  readonly imported: string;
  readonly binding: Binding;
}
/** Resolve lexical imports, including namespace access, without matching spelling alone. */
export declare function resolveImportedBinding(path: NodePath<t.Node>): ImportedBinding | undefined;
export declare function isCssMacro(path: NodePath<t.Node>): boolean;
export declare function isQwikComponent(path: NodePath<t.Node>): boolean;
interface ComponentOwner {
  readonly id: string;
  readonly callback: NodePath<t.ArrowFunctionExpression | t.FunctionExpression>;
  readonly source: SourceSpan;
}
export declare function findComponentOwner(path: NodePath<t.Node>, module: ParsedStyleModule): ComponentOwner;
interface CssPropSite {
  readonly id: string;
  readonly owner: ComponentOwner;
  readonly attribute: NodePath<t.JSXAttribute>;
  readonly opening: NodePath<t.JSXOpeningElement>;
  readonly expression: NodePath<t.Expression>;
  readonly source: SourceSpan;
}
export declare function collectCssPropSites(module: ParsedStyleModule): readonly CssPropSite[];
/** Compiler-only handles cannot escape into QRL captures or arbitrary runtime APIs. */
export declare function validateAuthoringUses(module: ParsedStyleModule): void;
//#endregion
//#region src/values.d.ts
type EvaluatedPrimitive = string | number | boolean | null | undefined;
interface RuntimeExpression {
  readonly kind: "runtime";
  readonly node: t.Expression;
  readonly code: string;
  readonly source: SourceSpan;
}
type EvaluatedValue = {
  readonly kind: "literal";
  readonly value: EvaluatedPrimitive;
} | {
  readonly kind: "object";
  /** Final JS object order; duplicate keys replace values at their first position. */
  readonly entries: readonly (readonly [string, EvaluatedValue])[];
  /** Runtime evaluations including overwritten values, in original JS order. */
  readonly effects: readonly RuntimeExpression[];
} | {
  readonly kind: "array";
  readonly items: readonly EvaluatedValue[];
  readonly effects: readonly RuntimeExpression[];
} | RuntimeExpression;
//#endregion
//#region src/evaluate.d.ts
interface EvaluateStaticOptions {
  /** Shape inspection only; consumers must read runtime leaves from the stored object. */
  readonly allowStoredStructuralValues?: boolean;
  readonly resolveImport?: ((source: string, imported: string) => EvaluatedValue | undefined) | undefined;
}
/** Evaluate a style expression without executing arbitrary JavaScript. */
export declare function evaluateStatic(path: NodePath<t.Expression>, module: ParsedStyleModule, options?: EvaluateStaticOptions): EvaluatedValue;
//#endregion
//#region src/css.d.ts
interface ParseStyleCssOptions {
  readonly file?: string;
  readonly offset?: number;
}
/**
 * The core keyframe IR deliberately leaves naming to the identity phase. The
 * CSS frontend still has to retain the author name so the lowering phase can
 * resolve animation references without guessing from frame contents.
 */
interface NamedNativeKeyframes extends NativeKeyframes {
  readonly sourceName: string;
}
type ParsedNativeGlobal = NativeGlobal | NamedNativeKeyframes;
interface ParsedStyleCss {
  readonly rules: readonly NativeStyleRule[];
  readonly globals: readonly ParsedNativeGlobal[];
}
/** Decoded fixed class names, counted independently of declaration/rule count. */
export declare function selectorClassNames(selector: StyleSelector): readonly string[];
/**
 * Parse a declaration/nesting CSS body for one local style handle.
 * Top-level declarations use an implicit `&` subject; all explicit nested
 * selectors must contain structural ampersands and are flattened into IR.
 */
export declare function parseStyleCss(text: string, options?: ParseStyleCssOptions): ParsedStyleCss;
//#endregion
//#region src/lower.d.ts
type DynamicValuePart = string | {
  readonly input: number;
};
interface DynamicStyleBinding {
  readonly definition: DeclarationDefinition;
  readonly parts: readonly DynamicValuePart[];
}
interface LoweredStyle {
  readonly rules: readonly NativeStyleRule[];
  readonly globals: ReturnType<typeof parseStyleCss>["globals"];
  /** Evaluate these once, in order, at the original css attribute position. */
  readonly inputs: readonly RuntimeExpression[];
  readonly bindings: readonly DynamicStyleBinding[];
}
type StyleExpression = {
  readonly kind: "style";
  readonly value: LoweredStyle;
} | {
  readonly kind: "sequence";
  readonly items: readonly StyleExpression[];
} | {
  readonly kind: "choice";
  readonly test: RuntimeExpression;
  readonly consequent: StyleExpression;
  readonly alternate: StyleExpression;
};
interface LowerStyleOptions {
  readonly resolveImport?: (source: string, imported: string) => StyleExpression | undefined;
}
/** Resolve finite shape choices without executing application code during the build. */
export declare function lowerStyleExpression(path: NodePath<t.Expression>, module: ParsedStyleModule, options?: LowerStyleOptions): StyleExpression;
//#endregion
//#region src/compose.d.ts
interface ComposedStyleState {
  readonly rules: readonly NativeStyleRule[];
  readonly globals: readonly ParsedNativeGlobal[];
}
interface StyleSitePlan {
  readonly id: string;
  readonly ownerId: string;
  readonly expression: StyleExpression;
  readonly alternatives: readonly ComposedStyleState[];
  readonly states: readonly StyleProgramState[];
}
/** Enumerate complete style choices. This is independent of runtime predicate values. */
export declare function planStyleSite(expression: StyleExpression, id: string, ownerId: string, maxStates?: number): StyleSitePlan;
interface EmittedStyleEvaluation {
  readonly code: string;
  readonly state: string;
  readonly slots: string;
}
/**
 * Only plain value/branch expressions survive. No style IR, registry or helper
 * module is emitted. Each source expression executes once at its attribute site.
 */
export declare function emitStyleEvaluation(plan: StyleSitePlan, prefix: string, identities?: NativeIdentityRegistry, dev?: boolean): EmittedStyleEvaluation;
//#endregion
//#region src/class-values.d.ts
interface FiniteClassValues {
  readonly values: readonly string[];
  readonly tokens: readonly (readonly string[])[];
  /** Evaluate the original expression once at its original JSX attribute position. */
  readonly runtime?: RuntimeExpression;
}
/** Finite class strings are proved without running predicates or user functions. */
export declare function analyzeClassValues(expression: NodePath<t.Expression>, module: ParsedStyleModule, maxStates?: number): FiniteClassValues;
//#endregion
//#region src/utility-contract.d.ts
/** Parsed adapter output. Global selectors contain only text, local selectors contain subjects. */
type UtilityCssNode = {
  readonly kind: "local";
  readonly token: string;
  readonly rule: NativeStyleRule;
} | {
  readonly kind: "global-rule";
  readonly rule: NativeStyleRule;
} | {
  readonly kind: "global";
  readonly value: ParsedNativeGlobal;
  readonly wrappers: readonly StyleWrapper[];
} | {
  readonly kind: "layer-order";
  readonly names: readonly string[];
  readonly wrappers?: readonly StyleWrapper[];
};
interface UtilityRequest {
  readonly id: string;
  readonly tokens: readonly string[];
}
interface UtilityState {
  readonly id: string;
  readonly nodes: readonly UtilityCssNode[];
  readonly consumedTokens: readonly string[];
  readonly retainedTokens: readonly string[];
}
interface UtilityResolution {
  readonly foundation: readonly UtilityCssNode[];
  readonly states: readonly UtilityState[];
}
interface UtilityAdapter {
  resolve(states: readonly UtilityRequest[]): Promise<UtilityResolution>;
}
interface UtilitySession extends UtilityAdapter {
  readonly watchFiles: readonly string[];
}
/** Each Vite plugin owns the sessions it creates; failed replacements leave old sessions usable. */
interface UtilityAdapterFactory {
  readonly name: string;
  create(root: string): Promise<UtilitySession>;
}
//#endregion
//#region src/transform.d.ts
interface AnalyzedStyleSite {
  readonly source: StyleSiteSource;
  readonly plan: StyleSitePlan;
  /** Original CSS plan: runtime evaluation must not replay class predicates. */
  readonly cssPlan?: StyleSitePlan;
  readonly classValues?: FiniteClassValues;
  readonly utilities?: readonly UtilityState[];
}
interface AnalyzeStyleModuleOptions extends LowerStyleOptions {
  readonly utilities?: boolean;
}
interface StyleSiteOccurrence {
  /** The JSX attribute or spread that supplied this css value. */
  readonly node: t.Node;
  readonly expression: NodePath<t.Expression>;
}
interface StyleSiteSource {
  readonly id: string;
  readonly owner: ComponentOwner;
  readonly opening: NodePath<t.JSXOpeningElement>;
  readonly occurrences: readonly StyleSiteOccurrence[];
  readonly classExpression?: NodePath<t.Expression>;
}
interface AnalyzedStyleModule {
  readonly module: ParsedStyleModule;
  readonly sites: readonly AnalyzedStyleSite[];
  readonly macros: readonly NodePath<t.CallExpression | t.TaggedTemplateExpression>[];
  readonly foundation?: {
    readonly opening: NodePath<t.JSXOpeningElement>;
    readonly demandId: string;
  };
}
/** The graph supplies a head reached from a verified application render entry. */
export declare function attachUtilityFoundation(analysis: AnalyzedStyleModule, opening: NodePath<t.JSXOpeningElement>): AnalyzedStyleModule;
/** The same analysis is retained from whole-graph discovery through final emission. */
export declare function analyzeStyleModule(code: string, file: string, options?: AnalyzeStyleModuleOptions): AnalyzedStyleModule;
export declare function utilityRequests(analysis: AnalyzedStyleModule): readonly UtilityRequest[];
/** Utility order is the adapter order; CSS contributions follow it regardless of JSX attribute order. */
export declare function composeUtilityStates(analysis: AnalyzedStyleModule, resolved: ReadonlyMap<string, UtilityState>, maxStates?: number): AnalyzedStyleModule;
/** Fixed selectors and statements retain the same render demand as their utility state. */
export declare function utilityAuxiliaryNodes(site: AnalyzedStyleSite, stateIndex: number): readonly UtilityCssNode[];
interface EmitStyleModuleOptions {
  readonly packModule?: (packId: string) => string;
  readonly dev?: boolean;
}
/** Emit ordinary TSX for the Qwik optimizer, preserving attribute evaluation order. */
export declare function emitStyleModule(analysis: AnalyzedStyleModule, program: OptimizedStyleProgram, options?: EmitStyleModuleOptions): {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
};
//#endregion
//#region src/global.d.ts
interface ResolvedGlobalPayload {
  readonly id: string;
  readonly kind: ParsedNativeGlobal["kind"];
  readonly css: string;
  readonly source?: SourceSpan;
}
interface ResolvedStyleGlobals {
  readonly rules: readonly NativeStyleRule[];
  readonly globals: readonly ResolvedGlobalPayload[];
}
/** Canonicalize static globals, rename keyframes, and attach global dependencies to rules. */
export declare function resolveStyleGlobals(rules: readonly NativeStyleRule[], globals: readonly ParsedNativeGlobal[], identities?: NativeIdentityRegistry): ResolvedStyleGlobals;
//#endregion
//#region src/document-root.d.ts
type DocumentEntry = {
  readonly kind: "head";
  readonly opening: NodePath<t.JSXOpeningElement>;
} | {
  readonly kind: "reference";
  readonly source: string;
  readonly imported: string;
};
/** Alias kept for callers that name the result after the resolver operation. */
type DocumentEntryResolution = DocumentEntry;
/** Resolve the document head reachable from one statically known module export. */
export declare function resolveDocumentEntry(module: ParsedStyleModule, exportName?: string): DocumentEntry | undefined;
//#endregion
//#region src/style-imports.d.ts
/** Replace only runtime named style imports; all other Qwik bindings retain their source. */
export declare function rewriteStyleImports(code: string, file: string, replacement: string, generatedPack?: boolean, serverReplacement?: string): {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
} | undefined;
//#endregion
//#region src/style-retry.d.ts
interface StyleImportRetryRender {
  readonly code: string;
  readonly map: ReturnType<MagicString["generateMap"]>;
}
interface StyleImportRetryPlan {
  /** The literal dependency loaded by the generated StylePack QRL. */
  readonly dependency: string;
  /** Render the owner with a caller-provided URL expression for retrying the dependency. */
  readonly render: (urlExpression: string) => StyleImportRetryRender;
}
/**
 * Recognize and prepare the generated StylePack owner used for CSS import retry.
 *
 * The marker is the second `true` argument to an imported `useStylesQrl` call.
 * Every other hook shape is ignored, while a marked but malformed hook causes
 * this function to return no plan rather than guessing at authored code.
 */
export declare function planStyleImportRetry(code: string, file: string, runtime: string): StyleImportRetryPlan | undefined;
//#endregion
export type { AnalyzeStyleModuleOptions, AnalyzedStyleModule, AnalyzedStyleSite, ComponentOwner, ComposedStyleState, CssPropSite, DocumentEntry, DocumentEntryResolution, DynamicStyleBinding, DynamicValuePart, EmitStyleModuleOptions, EmittedStyleEvaluation, EvaluateStaticOptions, EvaluatedPrimitive, EvaluatedValue, FiniteClassValues, ImportedBinding, LowerStyleOptions, LoweredStyle, NamedNativeKeyframes, ParseStyleCssOptions, ParsedNativeGlobal, ParsedStyleCss, ParsedStyleModule, ResolvedGlobalPayload, ResolvedStyleGlobals, RuntimeExpression, StyleExpression, StyleImportRetryPlan, StyleImportRetryRender, StyleSitePlan, UtilityAdapter, UtilityAdapterFactory, UtilityCssNode, UtilityRequest, UtilityResolution, UtilitySession, UtilityState };
//# sourceMappingURL=index.d.mts.map