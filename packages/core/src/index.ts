// @qstyle/core — Style IR / canonicalization / hashing / dedup / chunk planning
// plan.md Part III, IV, VIII, IX の実装起点。Milestone 1 以降で拡張する.
export const VERSION: string = '0.1.0-m1';

export type {
  AnyAtom,
  AtRuleDecl,
  GlobalAtRule,
  KeyframesFrame,
  KeyframesRule,
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
export { canonicalProperty, canonicalValue, classSelectors, createStaticAtom, fnv1aHex, hashStaticAtom, wrapContextAtRules } from './atom.js';
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
  SHORTHAND_MAP,
  assignOrderingGroups,
  classifyDeclaration,
  hasInvalidDeclarationChars,
  isShorthand,
  longhandsOf,
  needsOrderingGroup,
} from './safety.js';
export {
  buildAtRuleDecls,
  buildGlobalAtRule,
  buildKeyframesRule,
  normalizeFrameSelector,
  parseGlobalAtRuleKey,
  parseKeyframesKey,
  parseLayerKey,
  rewriteAnimationValue,
  serializeGlobalAtRuleCss,
  serializeKeyframesCss,
} from './keyframes.js';
export {
  createParametricAtom,
  hashParametricAtom,
  inferSlotType,
  serializeParametricCss,
  serializeParametricDecl,
} from './parametric.js';
export type {
  CreateParametricAtomInput,
  TemplatePartInput,
  TemplateSlotInput,
} from './parametric.js';
export {
  createUsageGraph,
  groupByUsageSignature,
  jaccardSimilarity,
  recordComponentBoundary,
  recordComponentRoute,
  recordSource,
  recordUsage,
  routeSignature,
  sourceSignature,
  usageSignature,
} from './usage.js';
export type { UsageGraph } from './usage.js';
export { DEFAULT_CHUNK_OPTIONS, planChunks } from './chunk.js';
export type { ChunkInput, ChunkOptions, ChunkPlan } from './chunk.js';
export {
  IMMUTABLE_CACHE_HEADER,
  assetFileName,
  buildRouteManifest,
  chunkHash,
  parseManifest,
  resolveRouteAssets,
  serializeManifest,
} from './manifest.js';
export type { ChunkHashInput, RouteManifestEntry, StyleManifest } from './manifest.js';
export { MemoryCache, computeCacheKey, invalidateBySource, safeParse } from './cache.js';
export type { ComputeCacheKeyInput } from './cache.js';
