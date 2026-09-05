// @qstyle/core — Style IR / canonicalization / hashing / dedup / chunk planning
// plan.md Part III, IV, VIII, IX の実装起点。Milestone 1 以降で拡張する.
export const VERSION: string = '0.1.0-m1';

export type {
  OrderingConstraints,
  Provenance,
  ResidualReason,
  ResidualRuleNode,
  RuleContext,
  StaticAtom,
  StyleNode,
} from './ir.js';
export { canonicalProperty, canonicalValue, createStaticAtom, hashStaticAtom } from './atom.js';
export type { CreateStaticAtomInput } from './atom.js';
export {
  UNITLESS_PROPERTIES,
  UNITLESS_VERSION,
  isUnitlessProperty,
  serializeCssValue,
} from './units.js';
export { DedupRegistry } from './dedup.js';
export type { DedupAddResult } from './dedup.js';
