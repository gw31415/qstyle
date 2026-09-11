import type { NativeStyleRule, StyleWrapper } from '@qstyle/core';
import type { ParsedNativeGlobal } from './css.js';

/** Parsed adapter output. Global selectors contain only text, local selectors contain subjects. */
export type UtilityCssNode =
  | { readonly kind: 'local'; readonly token: string; readonly rule: NativeStyleRule }
  | { readonly kind: 'global-rule'; readonly rule: NativeStyleRule }
  | { readonly kind: 'global'; readonly value: ParsedNativeGlobal; readonly wrappers: readonly StyleWrapper[] }
  | { readonly kind: 'layer-order'; readonly names: readonly string[]; readonly wrappers?: readonly StyleWrapper[] };

export interface UtilityRequest {
  readonly id: string;
  readonly tokens: readonly string[];
}

export interface UtilityState {
  readonly id: string;
  readonly nodes: readonly UtilityCssNode[];
  readonly consumedTokens: readonly string[];
  readonly retainedTokens: readonly string[];
}

export interface UtilityResolution {
  readonly foundation: readonly UtilityCssNode[];
  readonly states: readonly UtilityState[];
}

export interface UtilityAdapter {
  resolve(states: readonly UtilityRequest[]): Promise<UtilityResolution>;
}

export interface UtilitySession extends UtilityAdapter {
  readonly watchFiles: readonly string[];
}

/** Each Vite plugin owns the sessions it creates; failed replacements leave old sessions usable. */
export interface UtilityAdapterFactory {
  readonly name: string;
  create(root: string): Promise<UtilitySession>;
}
