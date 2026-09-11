// @qstyle/core — Style IR / canonicalization / hashing / dedup / chunk planning
// plan.md Part III, IV, VIII, IX の実装起点。Milestone 1 以降で拡張する.
export const VERSION: string = '0.1.0';
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
export { canonicalProperty, canonicalValue, classSelectors, createStaticAtom, fnv1aHex, hashStaticAtom, staticAtomIdentity, wrapContextAtRules } from './atom.js';
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
  RESERVED_CUSTOM_PROPERTY_PREFIX,
  RESERVED_CUSTOM_PROPERTY_ROOT,
  SHORTHAND_MAP,
  assignOrderingGroups,
  classifyDeclaration,
  hasInvalidDeclarationChars,
  isReservedCustomPropertyName,
  isShorthand,
  isValidCustomPropertyName,
  longhandsOf,
  needsOrderingGroup,
} from './safety.js';
export { IdentityRegistry, StyleCollisionError } from './collision.js';
export type {
  IdentityRegisterOptions,
  IdentityRegisterResult,
  StyleCollision,
} from './collision.js';
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

// Native 1.0 compiler surface. Legacy entry points are removed when the frontend migrates.
export type {
  SourceSpan, StyleWrapper, SelectorPart, StyleSelector, SlotUnit, StyleValue,
  StyleDeclaration, NativeStyleRule, NativeKeyframes, NativeGlobal,
  DeclarationDefinition, DemandSite,
} from './native-ir.js';
export { SUBJECT_SELECTOR } from './native-ir.js';
export { NativeStyleError } from './native-diagnostic.js';
export type { NativeDiagnostic, NativeDiagnosticCode } from './native-diagnostic.js';
export {
  CANONICAL_VERSION, canonicalStyleValue, canonicalStyleDeclaration,
  canonicalStyleSelector, canonicalStyleWrappers, canonicalRule,
  canonicalDeclaration, canonicalGlobal,
} from './canonical.js';
export { NativeIdentityRegistry, nativeClassName, nativeSlotName, sha256Prefix128 } from './identity.js';
export type { NativeIdentityNamespace, NativeHasher } from './identity.js';
export { nativeProperty, nativeSlotUnit, nativeStaticValue, evaluateNativeSlot } from './native-values.js';
export {
  slotSchema, declarationSlotName, definitionSlotName, serializeNativeDeclaration, serializeNativeSelector,
  wrapNativeCss, serializeNativeRule, serializeDeclarationDefinition, serializeNativeGlobal,
} from './serialize.js';
export { DeclarationDictionary, createNativePacks } from './declarations.js';
export type { RegisteredDeclaration, NativeStylePack } from './declarations.js';
export { solveClassCover, ClassCoverError } from './class-cover.js';
export type { ClassCoverState, ClassCoverResourceLimits, ClassCoverResult, ClassCoverObjective } from './class-cover.js';
export { verifyClassCover } from './verify-cover.js';
export type { ClassCoverVerification } from './verify-cover.js';
export { optimizeStyleProgram, optimizeFixedStyleProgram } from './program.js';
export type { StyleProgramState, OptimizedStyleProgram } from './program.js';
