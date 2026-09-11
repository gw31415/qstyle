/** Immutable, framework-independent input to the native style compiler. */
export interface SourceSpan {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

export type StyleWrapper =
  | { readonly kind: 'media' | 'supports' | 'container'; readonly params: string }
  | { readonly kind: 'layer'; readonly name: string };

/** Text nodes come from a parsed selector; quoted ampersands are text, not subjects. */
export type SelectorPart =
  | { readonly kind: 'subject' }
  | { readonly kind: 'text'; readonly text: string };

export interface StyleSelector {
  readonly alternatives: readonly (readonly SelectorPart[])[];
}

export type SlotUnit = 'length' | 'unitless' | 'raw';

export type StyleValue =
  | { readonly kind: 'static'; readonly css: string }
  | {
      readonly kind: 'slot';
      readonly index: number;
      readonly unit: SlotUnit;
      readonly fallback?: string;
    };

export interface StyleDeclaration {
  readonly property: string;
  readonly value: StyleValue;
  readonly important: boolean;
}

export interface NativeStyleRule {
  readonly selector: StyleSelector;
  readonly wrappers: readonly StyleWrapper[];
  readonly declarations: readonly StyleDeclaration[];
  readonly dependencies: readonly string[];
  readonly source?: SourceSpan;
}

export interface NativeKeyframes {
  readonly kind: 'keyframes';
  /** Ordered stylesheet wrappers enclosing this global rule. */
  readonly wrappers?: readonly StyleWrapper[];
  readonly frames: readonly {
    readonly selector: string;
    readonly declarations: readonly StyleDeclaration[];
  }[];
  readonly source?: SourceSpan;
}

export interface NativeGlobal {
  readonly kind: 'font-face' | 'property';
  readonly name: string;
  /** Ordered stylesheet wrappers enclosing this global rule. */
  readonly wrappers?: readonly StyleWrapper[];
  readonly declarations: readonly StyleDeclaration[];
  readonly source?: SourceSpan;
}

/** A declaration identity excludes its owner, source location and generated class. */
export interface DeclarationDefinition {
  readonly selector: StyleSelector;
  readonly wrappers: readonly StyleWrapper[];
  readonly declaration: StyleDeclaration;
  readonly dependencies: readonly string[];
}

/** One concrete render path and finite style choice, rather than an entire component. */
export interface DemandSite {
  readonly id: string;
  readonly owner: string;
  readonly renderPath: string;
  readonly styleState: string;
  readonly lazyBoundary: string;
  /** Opaque canonical predicate produced by the frontend, never evaluated by core. */
  readonly predicate: string;
}

export const SUBJECT_SELECTOR: StyleSelector = Object.freeze({
  alternatives: Object.freeze([Object.freeze([{ kind: 'subject' as const }])]),
});
