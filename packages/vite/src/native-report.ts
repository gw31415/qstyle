import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { parseStyleModule, resolveImportedBinding, selectorClassNames } from '@qstyle/compiler';
import type { NativeDiagnosticCode, NativeStylePack, OptimizedStyleProgram, RegisteredDeclaration, SourceSpan } from '@qstyle/core';
import type { FrozenStyleGraph, StyleSourceModule } from './graph.js';

/** The part of a Rollup/Rolldown output item needed by the final-artifact audit. */
export interface NativeReportBundleItem {
  readonly type: 'asset' | 'chunk';
  readonly fileName: string;
  readonly source?: string | Uint8Array;
  readonly code?: string;
}

export type NativeReportBundle = Readonly<Record<string, NativeReportBundleItem>>;

export interface NativeReportMetadata {
  readonly root: string;
  readonly compilerVersion: string;
  readonly targetVersions: Readonly<Record<string, string>>;
  readonly timings?: Readonly<Record<string, number>>;
  readonly sources?: boolean;
}

export interface NativeReportDiagnostic {
  readonly code: NativeDiagnosticCode;
  readonly message: string;
  readonly file?: string;
  readonly start?: number;
  readonly end?: number;
  readonly related?: readonly SourceSpan[];
  readonly fixHint?: string;
}

export interface NativeReportModule {
  readonly id: string;
  readonly digest: string;
  readonly imports: readonly string[];
  readonly source?: string;
}

export interface NativeReportOwner {
  readonly id: string;
  readonly demandIds: readonly string[];
}

export interface NativeReportRule {
  readonly id: string;
  readonly declarationIds: readonly string[];
  readonly ownerIds: readonly string[];
  readonly packIds: readonly string[];
  readonly fixed: boolean;
}

export interface NativeReportPack {
  readonly id: string;
  readonly declarationIds: readonly string[];
  readonly ownerIds: readonly string[];
  readonly cssBytes: number;
  readonly cssDigest: string;
  readonly globalIds?: readonly string[];
}

export interface NativeReportAsset {
  readonly fileName: string;
  readonly contentDigest: string;
  readonly bytes: number;
  readonly packIds: readonly string[];
  readonly kind: 'chunk' | 'css' | 'asset';
  readonly unmapped?: boolean;
}

export interface NativeReportClassAssignment {
  readonly stateId: string;
  readonly classNames: readonly string[];
}

export interface NativeReportClassOptimality {
  readonly status: 'optimal' | 'unknown';
  readonly lowerBound: { readonly K: number; readonly T: number };
  readonly upperBound: { readonly K: number; readonly T: number };
  readonly candidateCount: number;
  readonly exploredNodes: number;
  readonly modelVersion: string;
}

/** Build-time diagnostic and delivery metadata for the final browser bundle. */
export interface NativeReport {
  readonly schemaVersion: 1;
  readonly compilerVersion: string;
  readonly targetVersions: Readonly<Record<string, string>>;
  readonly modules: readonly NativeReportModule[];
  readonly owners: readonly NativeReportOwner[];
  readonly rules: readonly NativeReportRule[];
  readonly packs: readonly NativeReportPack[];
  readonly assets: readonly NativeReportAsset[];
  readonly diagnostics: readonly NativeReportDiagnostic[];
  readonly timings: Readonly<Record<string, number>>;
  readonly wholeSiteGuarantee: boolean;
  readonly unmanagedStylesheets: readonly string[];
  readonly duplicateDefinitionCount: number;
  readonly duplicatePayloadCount: number;
  readonly classCount: number;
  readonly classAssignments: readonly NativeReportClassAssignment[];
  readonly fixedClassCount: number;
  readonly classOptimality: NativeReportClassOptimality;
}

interface PackBytes {
  readonly id: string;
  readonly bytes: Uint8Array;
}

interface ConcatenationResult {
  readonly count: 0 | 1 | 2;
  readonly ids?: readonly string[];
}

interface ManifestObservation {
  readonly parsed: boolean;
  readonly unknownStyle: boolean;
  readonly unknownNative: boolean;
  readonly unmappedStyle: boolean;
  readonly nativeStyles: readonly ManifestNativeStyle[];
}

interface ManifestNativeStyle {
  readonly nativeStyleId: string;
  readonly symbol: string;
  readonly hash: string;
  readonly packId: string;
}

interface LiteralObservation {
  readonly payloads: Map<string, number>;
  readonly nativeRefs: Set<string>;
  readonly ambiguous: Set<string>;
  readonly exports: Map<string, string>;
}

interface StaticAstNode {
  readonly type?: string;
  readonly value?: unknown;
  readonly expressions?: readonly unknown[];
  readonly quasis?: readonly { readonly value?: { readonly cooked?: string | null } }[];
}

const MAX_CONCAT_SEGMENTS = 4096;
const MAX_CONCAT_SOLUTIONS = 2;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function asBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? textBytes(value) : value;
}

function equalBytes(left: Uint8Array, right: Uint8Array, offset = 0): boolean {
  if (offset + right.length > left.length) return false;
  for (let index = 0; index < right.length; index += 1) {
    if (left[offset + index] !== right[index]) return false;
  }
  return true;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableValue(value: string, root: string): string {
  const normalized = value.replaceAll('\\', '/');
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/$/, '');
  const underRoot = normalizedRoot.length > 0
    && (normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`));
  return isAbsolute(value) || underRoot ? sha256(textBytes(normalized)) : normalized;
}

function sortedRecord(record: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => compareStrings(left, right)));
}

function sortedNumberRecord(record: Readonly<Record<string, number>> | undefined): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.entries(record ?? {}).sort(([left], [right]) => compareStrings(left, right)));
}

// Qwik beta.43's generated StylePack has one useStyles$ call, so its native
// style hook index is pinned to zero until another target contract is adopted.
const GENERATED_STYLE_HOOK_INDEX = 0;

function qwikNativeStyleId(hash: string): string {
  let value = 0;
  for (let index = 0; index < hash.length; index += 1) {
    value = (value << 5) - value + hash.charCodeAt(index);
    value |= 0;
  }
  return `${Math.abs(value).toString(36)}-${GENERATED_STYLE_HOOK_INDEX}`;
}

function staticString(node: unknown): string | undefined {
  if (!isRecord(node)) return undefined;
  const ast = node as StaticAstNode;
  if (ast.type === 'StringLiteral') return typeof ast.value === 'string' ? ast.value : undefined;
  if (ast.type !== 'TemplateLiteral' || ast.expressions?.length !== 0) return undefined;
  const cooked = ast.quasis?.[0]?.value?.cooked;
  return cooked ?? undefined;
}

function packIdFromNativeReference(value: string, packIds: readonly string[]): string | undefined {
  for (const id of packIds) {
    if (value === id || value === `virtual:qstyle-native:${id}.tsx`
      || value.endsWith(`/.qstyle/native/${id}.tsx`)
      || value.endsWith(`/native/${id}.tsx`)
      || value.endsWith(`qstyle-native:${id}.tsx`)) return id;
  }
  return undefined;
}

function observeFinalCode(
  code: string,
  fileName: string,
  cssToPacks: ReadonlyMap<string, readonly string[]>,
  packIds: readonly string[],
): { readonly observation: LiteralObservation; readonly parseError: boolean } {
  const payloads = new Map<string, number>();
  const nativeRefs = new Set<string>();
  const ambiguous = new Set<string>();
  const exports = new Map<string, string>();
  const observe = (value: string): void => {
    const reference = packIdFromNativeReference(value, packIds);
    if (reference) nativeRefs.add(reference);
    const candidates = cssToPacks.get(value);
    if (!candidates?.length) return;
    if (candidates.length !== 1) {
      ambiguous.add(value);
      return;
    }
    const id = candidates[0]!;
    payloads.set(id, (payloads.get(id) ?? 0) + 1);
  };

  try {
    const parsed = parseStyleModule(code, fileName);
    const exportedValue = (name: string, seen = new Set<string>()): string | undefined => {
      if (seen.has(name)) return undefined;
      seen.add(name);
      const binding = parsed.program.scope.getBinding(name);
      if (!binding?.constant || !binding.path.isVariableDeclarator()) return undefined;
      const init = binding.path.get('init');
      return init.isIdentifier() ? exportedValue(init.node.name, seen) : staticString(init.node);
    };
    parsed.program.traverse({
      StringLiteral(path) {
        observe(path.node.value);
      },
      TemplateLiteral(path) {
        const value = staticString(path.node);
        if (value !== undefined) observe(value);
      },
      ExportNamedDeclaration(path) {
        if (path.node.source) return;
        const declaration = path.node.declaration;
        if (declaration?.type === 'VariableDeclaration') for (const item of declaration.declarations) {
          if (item.id.type !== 'Identifier') continue;
          const value = exportedValue(item.id.name);
          if (value !== undefined) exports.set(item.id.name, value);
        }
        for (const specifier of path.node.specifiers) {
          if (specifier.type !== 'ExportSpecifier' || specifier.local.type !== 'Identifier') continue;
          const value = exportedValue(specifier.local.name);
          const name = specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value;
          if (value !== undefined) exports.set(name, value);
        }
      },
    });
    return { observation: { payloads, nativeRefs, ambiguous, exports }, parseError: false };
  } catch {
    return { observation: { payloads, nativeRefs, ambiguous, exports }, parseError: true };
  }
}

function mapConcatenatedCss(source: Uint8Array, packs: readonly PackBytes[]): ConcatenationResult {
  const memo = new Map<number, ConcatenationResult>();
  const solve = (offset: number, depth: number): ConcatenationResult => {
    if (offset === source.length) return { count: 1, ids: [] };
    if (depth >= MAX_CONCAT_SEGMENTS) return { count: 2 };
    const cached = memo.get(offset);
    if (cached) return cached;
    let count = 0 as 0 | 1 | 2;
    let first: readonly string[] | undefined;
    for (const pack of packs) {
      if (!equalBytes(source, pack.bytes, offset)) continue;
      const tail = solve(offset + pack.bytes.length, depth + 1);
      if (tail.count === 0) continue;
      if (first === undefined && tail.ids !== undefined) first = [pack.id, ...tail.ids];
      count = Math.min(MAX_CONCAT_SOLUTIONS, count + tail.count) as 0 | 1 | 2;
      if (count >= MAX_CONCAT_SOLUTIONS) break;
    }
    const result: ConcatenationResult = count === 1 && first !== undefined ? { count, ids: first } : { count };
    memo.set(offset, result);
    return result;
  };
  return solve(0, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectManifestReferences(
  source: string | Uint8Array,
  packIds: readonly string[],
  refs: Set<string>,
  assets: readonly NativeReportAsset[],
  payloadExports: ReadonlyMap<string, ReadonlyMap<string, string>>,
  cssToPacks: ReadonlyMap<string, readonly string[]>,
): ManifestObservation {
  let value: unknown;
  try {
    value = JSON.parse(typeof source === 'string' ? source : new TextDecoder().decode(source));
  } catch {
    return { parsed: false, unknownStyle: false, unknownNative: false, unmappedStyle: false, nativeStyles: [] };
  }
  if (!isRecord(value) || !isRecord(value.symbols)) return { parsed: false, unknownStyle: false, unknownNative: false, unmappedStyle: false, nativeStyles: [] };
  let unknownStyle = false;
  let unknownNative = false;
  let unmappedStyle = false;
  const stylePacks = new Set<string>();
  const nativeStyles: ManifestNativeStyle[] = [];
  for (const [name, symbol] of Object.entries(value.symbols)) {
    if (!isRecord(symbol)) { unmappedStyle = true; continue; }
    const style = symbol.ctxName === 'useStyles$' || symbol.ctxName === 'useStylesScoped$';
    if (typeof symbol.origin !== 'string') { if (style) unknownStyle = true; continue; }
    const packId = packIdFromNativeReference(symbol.origin, packIds);
    if (packId) refs.add(packId);
    else if (symbol.origin.includes('/.qstyle/native/')) unknownNative = true;
    if (style) {
      if (!packId) unknownStyle = true;
      else {
        if (stylePacks.has(packId)) unmappedStyle = true;
        stylePacks.add(packId);
        const mapped = isRecord(value.mapping) ? value.mapping[name] : undefined;
        const matches = typeof mapped === 'string' ? assets.filter((asset) => asset.kind === 'chunk'
          && (asset.fileName === mapped || asset.fileName.endsWith(`/${mapped}`))) : [];
        const exportedCss = matches.length === 1 ? payloadExports.get(matches[0]!.fileName)?.get(name) : undefined;
        if (exportedCss === undefined || !cssToPacks.get(exportedCss)?.includes(packId)) unmappedStyle = true;
        if (typeof symbol.hash === 'string' && symbol.hash.length > 0) nativeStyles.push({
          nativeStyleId: qwikNativeStyleId(symbol.hash), symbol: name, hash: symbol.hash, packId,
        });
        else unmappedStyle = true;
      }
    }
  }
  if (packIds.some((id) => !stylePacks.has(id))) unmappedStyle = true;
  return { parsed: true, unknownStyle, unknownNative, unmappedStyle, nativeStyles };
}

function authoredUnmanagedControls(module: StyleSourceModule): readonly { kind: string; start: number; end: number }[] {
  const controls: { kind: string; start: number; end: number }[] = [];
  const add = (kind: string, node: { start?: number | null; end?: number | null }): void => {
    controls.push({ kind, start: node.start ?? 0, end: node.end ?? module.code.length });
  };
  module.parsed.program.traverse({
    CallExpression(path) {
      const binding = resolveImportedBinding(path.get('callee'));
      if (binding?.source === '@qwik.dev/core' && (binding.imported === 'useStyles$' || binding.imported === 'useStylesScoped$')) {
        add(binding.imported, path.node);
      }
    },
    JSXElement(path) {
      const opening = path.get('openingElement');
      const name = opening.node.name;
      if (name.type === 'JSXIdentifier' && name.name === 'style') {
        add('jsx-style', opening.node);
        return;
      }
      if (name.type !== 'JSXIdentifier' || name.name !== 'link') return;
      for (const attribute of opening.get('attributes')) {
        if (!attribute.isJSXAttribute() || attribute.node.name.type !== 'JSXIdentifier' || attribute.node.name.name !== 'rel') continue;
        const valuePath = attribute.get('value');
        if (Array.isArray(valuePath) || !valuePath.node) continue;
        const value = valuePath.isStringLiteral() ? valuePath.node.value
          : valuePath.isJSXExpressionContainer()
            ? (() => {
              const expression = valuePath.get('expression');
              return Array.isArray(expression) || !expression.node ? undefined : staticString(expression.node);
            })()
            : undefined;
        if (value?.split(/\s+/).some((token) => token.toLowerCase() === 'stylesheet')) add('jsx-link-stylesheet', opening.node);
      }
    },
  });
  return controls.sort((a, b) => a.start - b.start || compareStrings(a.kind, b.kind));
}

function collectDeclarations(program: OptimizedStyleProgram): readonly RegisteredDeclaration[] {
  const byId = new Map<string, RegisteredDeclaration>();
  for (const record of [...(program.fixedDeclarations ?? []), ...program.declarations]) byId.set(record.id, record);
  return [...byId.values()].sort((left, right) => compareStrings(left.id, right.id));
}

function makeClassOptimality(program: OptimizedStyleProgram): NativeReportClassOptimality {
  const cover = program.cover;
  const lowerBound = cover.lowerBound;
  const upperBound = cover.upperBound;
  const optimal = lowerBound.K === upperBound.K && lowerBound.T === upperBound.T
    && cover.optimality.status === 'optimal';
  return {
    status: optimal ? 'optimal' : 'unknown',
    lowerBound: { K: lowerBound.K, T: lowerBound.T },
    upperBound: { K: upperBound.K, T: upperBound.T },
    candidateCount: cover.candidateCount,
    exploredNodes: cover.exploredNodes,
    modelVersion: 'native-class-cover-v1',
  };
}

/**
 * Observe final browser outputs and construct the §11 report.
 *
 * CSS is assigned to a pack only when a decoded static JS literal equals the
 * complete pack CSS, or when a CSS asset is exactly a concatenation of known
 * pack bytes. Dynamic string assembly, substring matches, source-map guesses,
 * and non-Qwik provenance are intentionally left unmapped. The bounded
 * concatenation proof considers at most 4,096 segments and two solutions.
 */
export function createNativeReport(
  graph: FrozenStyleGraph,
  bundle: NativeReportBundle,
  metadata: NativeReportMetadata,
): NativeReport {
  const program = graph.program;
  const allPacks = [...program.packs].sort((left, right) => compareStrings(left.id, right.id));
  const nonEmptyPacks = allPacks.filter((pack) => pack.css.length > 0);
  const packIds = nonEmptyPacks.map((pack) => pack.id);
  const cssToPacks = new Map<string, string[]>();
  for (const pack of nonEmptyPacks) {
    const candidates = cssToPacks.get(pack.css) ?? [];
    candidates.push(pack.id);
    cssToPacks.set(pack.css, candidates);
  }
  for (const candidates of cssToPacks.values()) candidates.sort(compareStrings);
  const packBytes = nonEmptyPacks.map((pack) => ({ id: pack.id, bytes: textBytes(pack.css) }));
  const payloadOccurrences = new Map<string, number>();
  const nativeRefs = new Set<string>();
  const diagnostics: NativeReportDiagnostic[] = [];
  const diagnosticKeys = new Set<string>();
  const safeSource = (source: SourceSpan): SourceSpan => ({ ...source,
    file: stableValue(isAbsolute(source.file) ? relative(metadata.root, source.file) : source.file, metadata.root),
  });
  const diagnostic = (code: NativeDiagnosticCode, message: string, source?: SourceSpan, related?: readonly SourceSpan[], fixHint?: string): void => {
    const key = JSON.stringify([code, message, source]);
    if (diagnosticKeys.has(key)) return;
    diagnosticKeys.add(key);
    diagnostics.push({ code, message, ...(source ? safeSource(source) : {}),
      ...(related?.length ? { related: related.map(safeSource) } : {}), ...(fixHint ? { fixHint } : {}),
    });
  };

  const outputItems = Object.values(bundle).sort((left, right) =>
    compareStrings(left.fileName, right.fileName) || compareStrings(left.type, right.type));
  const assets: NativeReportAsset[] = [];
  const payloadExports = new Map<string, ReadonlyMap<string, string>>();
  for (const item of outputItems) {
    const fileName = stableValue(item.fileName, metadata.root);
    if (item.type === 'chunk') {
      const code = typeof item.code === 'string' ? item.code : '';
      const observed = observeFinalCode(code, item.fileName, cssToPacks, packIds);
      payloadExports.set(fileName, observed.observation.exports);
      for (const [id, count] of observed.observation.payloads) payloadOccurrences.set(id, (payloadOccurrences.get(id) ?? 0) + count);
      for (const id of observed.observation.nativeRefs) nativeRefs.add(id);
      for (const value of observed.observation.ambiguous) diagnostic('QS1601', `A final JavaScript literal matches multiple native packs in ${fileName}.`,
        { file: fileName, start: 0, end: code.length });
      if (observed.parseError) diagnostic('QS1601', `Cannot parse final JavaScript asset ${fileName} for native style mapping.`,
        { file: fileName, start: 0, end: code.length });
      const ids = [...observed.observation.payloads.keys()].sort(compareStrings);
      const hasNativeReference = observed.observation.nativeRefs.size > 0;
      assets.push({ fileName, contentDigest: sha256(textBytes(code)), bytes: textBytes(code).length,
        packIds: ids, kind: 'chunk', ...(hasNativeReference && ids.length === 0 ? { unmapped: true } : {}) });
      continue;
    }
    const source = item.source === undefined ? new Uint8Array() : asBytes(item.source);
    const isCss = /\.css$/i.test(item.fileName.split('?')[0] ?? '');
    let ids: readonly string[] = [];
    let unmapped = false;
    if (isCss && source.length > 0) {
      const mapped = mapConcatenatedCss(source, packBytes);
      if (mapped.count === 1 && mapped.ids) {
        ids = mapped.ids;
        for (const id of ids) payloadOccurrences.set(id, (payloadOccurrences.get(id) ?? 0) + 1);
        diagnostic('QS1601', `CSS asset ${fileName} has matching pack bytes but unproven native delivery and cascade order.`,
          { file: fileName, start: 0, end: new TextDecoder().decode(source).length });
      } else {
        unmapped = true;
        diagnostic('QS1603', `Final CSS asset ${fileName} is not an exact concatenation of native packs.`,
          { file: fileName, start: 0, end: new TextDecoder().decode(source).length });
      }
    }
    assets.push({ fileName, contentDigest: sha256(source), bytes: source.length, packIds: [...new Set(ids)].sort(compareStrings),
      kind: isCss ? 'css' : 'asset', ...(isCss ? { unmapped } : {}) });
  }

  // q-manifest.json is a JSON asset, so inspect it separately from JS literals.
  let manifestCount = 0;
  const nativeStyleIds = new Map<string, ManifestNativeStyle>();
  for (const item of outputItems) {
    if (item.type !== 'asset' || !item.fileName.endsWith('q-manifest.json') || item.source === undefined) continue;
    manifestCount++;
    const fileName = stableValue(item.fileName, metadata.root);
    const location = { file: fileName, start: 0,
      end: typeof item.source === 'string' ? item.source.length : new TextDecoder().decode(item.source).length };
    const manifest = collectManifestReferences(item.source, packIds, nativeRefs, assets, payloadExports, cssToPacks);
    for (const style of manifest.nativeStyles) {
      const previous = nativeStyleIds.get(style.nativeStyleId);
      if (!previous) {
        nativeStyleIds.set(style.nativeStyleId, style);
      } else if (previous.hash !== style.hash || previous.packId !== style.packId) {
        diagnostic('QS1301', `Final Qwik native style ID ${JSON.stringify(style.nativeStyleId)} has a hash collision between `
          + `${JSON.stringify(previous.symbol)} (hash ${JSON.stringify(previous.hash)}, pack ${JSON.stringify(previous.packId)}) and `
          + `${JSON.stringify(style.symbol)} (hash ${JSON.stringify(style.hash)}, pack ${JSON.stringify(style.packId)}).`, location);
      }
    }
    if (!manifest.parsed) diagnostic('QS1601', `Cannot parse the final Qwik manifest ${fileName}.`, location);
    if (manifest.unknownNative) diagnostic('QS1601', 'The final Qwik manifest references an unknown native style module.', location);
    if (manifest.unknownStyle) diagnostic('QS1603', 'The final Qwik manifest contains an unmanaged authored style hook.', location);
    if (manifest.unmappedStyle) diagnostic('QS1601', 'A native Qwik style symbol lacks a valid hash or one verified final CSS payload.', location,
      undefined, 'Keep each native style symbol as a statically verifiable CSS export in its mapped chunk.');
  }
  if (nonEmptyPacks.length && manifestCount !== 1) diagnostic('QS1601', 'Final native style mapping requires exactly one Qwik manifest.');

  for (const pack of nonEmptyPacks) {
    const occurrences = payloadOccurrences.get(pack.id) ?? 0;
    if (occurrences === 0) {
      diagnostic('QS1601', nativeRefs.has(pack.id)
        ? `Known native pack ${pack.id} has no exact final CSS payload.`
        : `Native pack ${pack.id} is absent from the final browser payload.`);
    }
  }

  const declarations = collectDeclarations(program);
  const fixedIds = new Set((program.fixedDeclarations ?? []).map((record) => record.id));
  const declarationPackIds = new Map<string, string[]>();
  let duplicateDefinitionCount = Math.max(0, program.duplicateDefinitionCount);
  for (const pack of allPacks) {
    for (const id of pack.declarationIds) {
      declarationPackIds.set(id, [...(declarationPackIds.get(id) ?? []), pack.id]);
    }
  }
  for (const record of declarations) {
    const memberships = declarationPackIds.get(record.id)?.length ?? 0;
    if (memberships === 0) diagnostic('QS1601', `Declaration ${record.id} has no final native pack membership.`, record.sources[0], record.sources.slice(1));
    if (memberships > 1) {
      duplicateDefinitionCount += memberships - 1;
      diagnostic('QS1601', `Declaration ${record.id} has duplicate final native pack membership.`, record.sources[0], record.sources.slice(1));
    }
  }
  const globalMemberships = new Map<string, number>();
  for (const pack of allPacks) {
    for (const id of pack.globalIds ?? []) globalMemberships.set(id, (globalMemberships.get(id) ?? 0) + 1);
  }
  for (const [id, memberships] of globalMemberships) {
    if (memberships <= 1) continue;
    duplicateDefinitionCount += memberships - 1;
    diagnostic('QS1601', `Global ${id} has duplicate final native pack membership.`);
  }
  const demandOwners = new Map<string, string>();
  for (const record of declarations) for (const demand of record.demands) demandOwners.set(demand.id, demand.owner);
  const ownerDemands = new Map<string, Set<string>>();
  const ownerIdForDemand = (demandId: string): string => stableValue(demandOwners.get(demandId) ?? demandId, metadata.root);
  for (const record of declarations) {
    for (const demand of record.demands) {
      const id = stableValue(demand.owner, metadata.root);
      const demandIds = ownerDemands.get(id) ?? new Set<string>();
      demandIds.add(stableValue(demand.id, metadata.root));
      ownerDemands.set(id, demandIds);
    }
  }
  for (const pack of allPacks) {
    for (const demandId of pack.demandIds) {
      const ownerId = ownerIdForDemand(demandId);
      const demandIds = ownerDemands.get(ownerId) ?? new Set<string>();
      demandIds.add(stableValue(demandId, metadata.root));
      ownerDemands.set(ownerId, demandIds);
    }
  }
  const owners: NativeReportOwner[] = [...ownerDemands].sort(([left], [right]) => compareStrings(left, right)).map(([id, demandIds]) => ({
    id, demandIds: [...demandIds].sort(compareStrings),
  }));
  const ownerIdsForPack = (pack: NativeStylePack): readonly string[] => [...new Set(pack.demandIds.map(ownerIdForDemand))].sort(compareStrings);
  const rules: NativeReportRule[] = declarations.map((record) => ({
    id: record.id,
    declarationIds: [record.id],
    ownerIds: [...new Set(record.demands.map((demand) => stableValue(demand.owner, metadata.root)))].sort(compareStrings),
    packIds: [...new Set(declarationPackIds.get(record.id) ?? [])].sort(compareStrings),
    fixed: fixedIds.has(record.id),
  }));
  const packs: NativeReportPack[] = allPacks.map((pack) => ({
    id: pack.id,
    declarationIds: [...pack.declarationIds],
    ownerIds: ownerIdsForPack(pack),
    cssBytes: textBytes(pack.css).length,
    cssDigest: sha256(textBytes(pack.css)),
    ...(pack.globalIds ? { globalIds: [...pack.globalIds] } : {}),
  }));

  const unmanaged = new Set<string>();
  for (const stylesheet of graph.unmanagedStylesheets) unmanaged.add(stableValue(stylesheet, metadata.root));
  for (const module of graph.modules.values()) {
    for (const control of authoredUnmanagedControls(module)) {
      unmanaged.add(stableValue(module.key, metadata.root));
      diagnostic('QS1603', `Authored unmanaged style control ${control.kind} is present in ${stableValue(module.key, metadata.root)}.`,
        { file: module.key, start: control.start, end: control.end });
    }
  }
  for (const stylesheet of unmanaged) diagnostic('QS1603', `Unmanaged stylesheet is present: ${stylesheet}.`);

  const modules: NativeReportModule[] = [...graph.modules.values()].sort((left, right) => compareStrings(left.key, right.key)).map((module) => ({
    id: stableValue(module.key, metadata.root), digest: module.digest,
    imports: [...module.imports.values()].map((id) => stableValue(id, metadata.root)).sort(compareStrings),
    ...(metadata.sources ? { source: module.code } : {}),
  }));
  const classAssignments: NativeReportClassAssignment[] = [...program.classesByState]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([stateId, classNames]) => ({ stateId: stableValue(stateId, metadata.root), classNames: [...classNames] }));
  const duplicatePayloadCount = [...payloadOccurrences.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  const fixedClassNames = new Set<string>();
  let fixedClassCountKnown = true;
  for (const record of program.fixedDeclarations ?? []) {
    try {
      for (const className of selectorClassNames(record.definition.selector)) fixedClassNames.add(className);
    } catch {
      fixedClassCountKnown = false;
    }
  }
  if (!fixedClassCountKnown) diagnostic('QS1602', 'Fixed selector class names could not be decoded for the final report.');
  const classOptimality = makeClassOptimality(program);
  if (classOptimality.status !== 'optimal') diagnostic('QS1602', 'Class cover optimality was not proven for the final report.');
  const wholeSiteGuarantee = diagnostics.length === 0 && classOptimality.status === 'optimal'
    && duplicateDefinitionCount === 0 && duplicatePayloadCount === 0;
  return {
    schemaVersion: 1,
    compilerVersion: metadata.compilerVersion,
    targetVersions: sortedRecord(metadata.targetVersions),
    modules, owners, rules, packs, assets,
    diagnostics,
    timings: sortedNumberRecord(metadata.timings),
    wholeSiteGuarantee,
    unmanagedStylesheets: [...unmanaged].sort(compareStrings),
    duplicateDefinitionCount, duplicatePayloadCount,
    classCount: program.classes.length,
    classAssignments,
    fixedClassCount: fixedClassCountKnown ? fixedClassNames.size : 0,
    classOptimality,
  };
}
