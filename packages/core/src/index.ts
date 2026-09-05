// @qstyle/core — Style IR / canonicalization / hashing / dedup / chunk planning
// plan.md Part III, IV, VIII, IX の実装起点。Milestone 1 以降で拡張する.
export const VERSION: string = '0.1.0-m1';

export type {
  AnyAtom,
  OrderingConstraints,
  ParametricAtom,
  Provenance,
  ResidualReason,
  ResidualRuleNode,
  RuleContext,
  RuntimeSlotId,
  RuntimeSlotNode,
  RuntimeValueType,
  StaticAtom,
  StyleNode,
  ValueTemplatePart,
} from './ir.js';
export { canonicalProperty, canonicalValue, createStaticAtom, fnv1aHex, hashStaticAtom } from './atom.js';
export type { CreateStaticAtomInput } from './atom.js';
export {
  UNITLESS_PROPERTIES,
  UNITLESS_VERSION,
  isUnitlessProperty,
  serializeCssValue,
} from './units.js';
export { DedupRegistry } from './dedup.js';
export type { DedupAddResult } from './dedup.js';
export {
  createParametricAtom,
  hashParametricAtom,
  inferSlotType,
  serializeParametricCss,
} from './parametric.js';
export type {
  CreateParametricAtomInput,
  TemplatePartInput,
  TemplateSlotInput,
} from './parametric.js';
