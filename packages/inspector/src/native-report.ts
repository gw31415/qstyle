/**
 * Structural reader for the qstyle-native report emitted by @qstyle/vite.
 *
 * This package deliberately does not import the Vite package.  Reports are
 * build artifacts, so the reader keeps a small local copy of the public shape
 * and validates the fields that are needed by inspection and release gates.
 */

export interface NativeReportModule {
  readonly id: string;
  readonly digest: string;
  readonly imports: readonly string[];
  /** Included when the producer's opt-in `report.sources` setting is true. */
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

export interface NativeReportDiagnosticSpan {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

export interface NativeReportDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly start?: number;
  readonly end?: number;
  readonly related?: readonly NativeReportDiagnosticSpan[];
  readonly fixHint?: string;
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

/** Local structural representation of the schema-v1 native report. */
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

/** Result of validating unknown JSON against the report reader contract. */
export interface NativeReportValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/** Thrown by {@link parseNativeReport} when a report is malformed. */
export class NativeReportValidationError extends TypeError {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(`Invalid qstyle native report:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
    this.name = 'NativeReportValidationError';
    this.errors = [...errors];
  }
}

export interface NativeReportSummary {
  readonly schemaVersion: 1;
  readonly compilerVersion: string;
  readonly wholeSiteGuarantee: boolean;
  readonly packCount: number;
  readonly assetCount: number;
  readonly mappedAssetCount: number;
  readonly unmappedAssetCount: number;
  readonly ownerCount: number;
  readonly declarationCount: number;
  readonly classCount: number;
  readonly fixedClassCount: number;
  readonly diagnosticCount: number;
  readonly diagnosticsByCode: Readonly<Record<string, number>>;
  readonly unmanagedStylesheetCount: number;
  readonly duplicateDefinitionCount: number;
  readonly duplicatePayloadCount: number;
  readonly classOptimality: NativeReportClassOptimality;
  readonly failures: readonly string[];
}

/** One pack's owners, declarations, and final assets. */
export interface NativeReportPackMapping {
  readonly packId: string;
  readonly ownerIds: readonly string[];
  readonly declarationIds: readonly string[];
  /** Final bundle file names whose asset record references this pack. */
  readonly assets: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function stringArray(value: unknown, path: string, errors: string[]): value is readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push(`${path} must be an array of strings`);
    return false;
  }
  return true;
}

function numberRecord(value: unknown, path: string, errors: string[]): value is Readonly<Record<string, number>> {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  for (const [key, item] of Object.entries(value)) {
    if (!isFiniteNonNegativeNumber(item)) errors.push(`${path}.${key} must be a finite non-negative number`);
  }
  return true;
}

function stringRecord(value: unknown, path: string, errors: string[]): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') errors.push(`${path}.${key} must be a string`);
  }
  return true;
}

function nonEmptyString(value: unknown, path: string, errors: string[]): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return false;
  }
  return true;
}

function validateSpan(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  nonEmptyString(value.file, `${path}.file`, errors);
  if (!isFiniteNonNegativeInteger(value.start)) errors.push(`${path}.start must be a non-negative integer`);
  if (!isFiniteNonNegativeInteger(value.end)) errors.push(`${path}.end must be a non-negative integer`);
  if (isFiniteNonNegativeInteger(value.start) && isFiniteNonNegativeInteger(value.end)
    && value.end < value.start) errors.push(`${path}.end must be greater than or equal to start`);
}

function validateDiagnostic(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  nonEmptyString(value.code, `${path}.code`, errors);
  nonEmptyString(value.message, `${path}.message`, errors);
  if (value.file !== undefined && typeof value.file !== 'string') errors.push(`${path}.file must be a string`);
  if (value.start !== undefined && !isFiniteNonNegativeInteger(value.start)) errors.push(`${path}.start must be a non-negative integer`);
  if (value.end !== undefined && !isFiniteNonNegativeInteger(value.end)) errors.push(`${path}.end must be a non-negative integer`);
  if (isFiniteNonNegativeInteger(value.start) && isFiniteNonNegativeInteger(value.end)
    && value.end < value.start) errors.push(`${path}.end must be greater than or equal to start`);
  if (value.related !== undefined) {
    if (!Array.isArray(value.related)) errors.push(`${path}.related must be an array`);
    else value.related.forEach((span, index) => validateSpan(span, `${path}.related[${index}]`, errors));
  }
  if (value.fixHint !== undefined && typeof value.fixHint !== 'string') errors.push(`${path}.fixHint must be a string`);
}

function validateClassOptimality(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('classOptimality must be an object');
    return;
  }
  if (value.status !== 'optimal' && value.status !== 'unknown') {
    errors.push('classOptimality.status must be "optimal" or "unknown"');
  }
  for (const boundName of ['lowerBound', 'upperBound'] as const) {
    const bound = value[boundName];
    if (!isRecord(bound)) {
      errors.push(`classOptimality.${boundName} must be an object`);
      continue;
    }
    if (!isFiniteNonNegativeInteger(bound.K)) errors.push(`classOptimality.${boundName}.K must be a non-negative integer`);
    if (!isFiniteNonNegativeInteger(bound.T)) errors.push(`classOptimality.${boundName}.T must be a non-negative integer`);
  }
  if (isRecord(value.lowerBound) && isRecord(value.upperBound)
    && isFiniteNonNegativeInteger(value.lowerBound.K) && isFiniteNonNegativeInteger(value.upperBound.K)
    && isFiniteNonNegativeInteger(value.lowerBound.T) && isFiniteNonNegativeInteger(value.upperBound.T)) {
    if (value.lowerBound.K > value.upperBound.K) errors.push('classOptimality.lowerBound.K cannot exceed upperBound.K');
    if (value.lowerBound.T > value.upperBound.T) errors.push('classOptimality.lowerBound.T cannot exceed upperBound.T');
    if (value.status === 'optimal' && (value.lowerBound.K !== value.upperBound.K || value.lowerBound.T !== value.upperBound.T)) {
      errors.push('classOptimality.status=optimal requires equal lower and upper K/T bounds');
    }
  }
  if (!isFiniteNonNegativeInteger(value.candidateCount)) errors.push('classOptimality.candidateCount must be a non-negative integer');
  if (!isFiniteNonNegativeInteger(value.exploredNodes)) errors.push('classOptimality.exploredNodes must be a non-negative integer');
  nonEmptyString(value.modelVersion, 'classOptimality.modelVersion', errors);
}

function duplicateCount(values: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let duplicates = 0;
  for (const count of counts.values()) duplicates += Math.max(0, count - 1);
  return duplicates;
}

function validateReport(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ['report must be an object'];
  }
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be exactly 1');
  nonEmptyString(value.compilerVersion, 'compilerVersion', errors);
  stringRecord(value.targetVersions, 'targetVersions', errors);

  // These arrays are part of schema v1. Their nested data is checked where it
  // feeds an inspector operation; unrelated future fields remain ignorable.
  for (const field of ['modules', 'owners', 'rules', 'packs', 'assets', 'diagnostics', 'classAssignments'] as const) {
    if (!Array.isArray(value[field])) errors.push(`${field} must be an array`);
  }
  if (Array.isArray(value.modules)) value.modules.forEach((module, index) => {
    const path = `modules[${index}]`;
    if (!isRecord(module)) {
      errors.push(`${path} must be an object`);
      return;
    }
    nonEmptyString(module.id, `${path}.id`, errors);
    nonEmptyString(module.digest, `${path}.digest`, errors);
    stringArray(module.imports, `${path}.imports`, errors);
    if (module.source !== undefined && typeof module.source !== 'string') errors.push(`${path}.source must be a string`);
  });
  if (Array.isArray(value.owners)) value.owners.forEach((owner, index) => {
    const path = `owners[${index}]`;
    if (!isRecord(owner)) {
      errors.push(`${path} must be an object`);
      return;
    }
    nonEmptyString(owner.id, `${path}.id`, errors);
    stringArray(owner.demandIds, `${path}.demandIds`, errors);
  });
  if (Array.isArray(value.rules)) value.rules.forEach((rule, index) => {
    const path = `rules[${index}]`;
    if (!isRecord(rule)) {
      errors.push(`${path} must be an object`);
      return;
    }
    nonEmptyString(rule.id, `${path}.id`, errors);
    stringArray(rule.declarationIds, `${path}.declarationIds`, errors);
    stringArray(rule.ownerIds, `${path}.ownerIds`, errors);
    stringArray(rule.packIds, `${path}.packIds`, errors);
    if (typeof rule.fixed !== 'boolean') errors.push(`${path}.fixed must be a boolean`);
  });
  if (Array.isArray(value.classAssignments)) value.classAssignments.forEach((assignment, index) => {
    const path = `classAssignments[${index}]`;
    if (!isRecord(assignment)) {
      errors.push(`${path} must be an object`);
      return;
    }
    nonEmptyString(assignment.stateId, `${path}.stateId`, errors);
    stringArray(assignment.classNames, `${path}.classNames`, errors);
  });
  numberRecord(value.timings, 'timings', errors);

  if (typeof value.wholeSiteGuarantee !== 'boolean') errors.push('wholeSiteGuarantee must be a boolean');
  stringArray(value.unmanagedStylesheets, 'unmanagedStylesheets', errors);
  for (const field of ['duplicateDefinitionCount', 'duplicatePayloadCount', 'classCount', 'fixedClassCount'] as const) {
    if (!isFiniteNonNegativeInteger(value[field])) errors.push(`${field} must be a non-negative integer`);
  }

  const packIds: string[] = [];
  if (Array.isArray(value.packs)) {
    value.packs.forEach((pack, index) => {
      const path = `packs[${index}]`;
      if (!isRecord(pack)) {
        errors.push(`${path} must be an object`);
        return;
      }
      if (nonEmptyString(pack.id, `${path}.id`, errors)) packIds.push(pack.id);
      stringArray(pack.declarationIds, `${path}.declarationIds`, errors);
      stringArray(pack.ownerIds, `${path}.ownerIds`, errors);
      if (!isFiniteNonNegativeInteger(pack.cssBytes)) errors.push(`${path}.cssBytes must be a non-negative integer`);
      nonEmptyString(pack.cssDigest, `${path}.cssDigest`, errors);
      if (pack.globalIds !== undefined) stringArray(pack.globalIds, `${path}.globalIds`, errors);
    });
    if (duplicateCount(packIds) > 0) errors.push('packs must have unique ids');
  }

  const assetNames: string[] = [];
  const assetPackIds: string[] = [];
  let unmappedAssetCount = 0;
  if (Array.isArray(value.assets)) {
    value.assets.forEach((asset, index) => {
      const path = `assets[${index}]`;
      if (!isRecord(asset)) {
        errors.push(`${path} must be an object`);
        return;
      }
      if (nonEmptyString(asset.fileName, `${path}.fileName`, errors)) assetNames.push(asset.fileName);
      nonEmptyString(asset.contentDigest, `${path}.contentDigest`, errors);
      if (!isFiniteNonNegativeInteger(asset.bytes)) errors.push(`${path}.bytes must be a non-negative integer`);
      if (stringArray(asset.packIds, `${path}.packIds`, errors)) assetPackIds.push(...asset.packIds);
      if (asset.kind !== 'chunk' && asset.kind !== 'css' && asset.kind !== 'asset') errors.push(`${path}.kind is invalid`);
      if (asset.unmapped !== undefined && typeof asset.unmapped !== 'boolean') errors.push(`${path}.unmapped must be a boolean`);
      if (asset.unmapped === true) unmappedAssetCount += 1;
    });
    if (duplicateCount(assetNames) > 0) errors.push('assets must have unique fileName values');
    for (const packId of assetPackIds) if (!packIds.includes(packId)) errors.push(`assets reference unknown pack ${packId}`);
  }

  if (Array.isArray(value.diagnostics)) value.diagnostics.forEach((diagnostic, index) => validateDiagnostic(diagnostic, `diagnostics[${index}]`, errors));
  validateClassOptimality(value.classOptimality, errors);

  if (value.wholeSiteGuarantee === true) {
    if (Array.isArray(value.diagnostics) && value.diagnostics.length > 0) errors.push('wholeSiteGuarantee=true cannot include diagnostics');
    if (isFiniteNonNegativeInteger(value.duplicateDefinitionCount) && value.duplicateDefinitionCount > 0) errors.push('wholeSiteGuarantee=true cannot include duplicate definitions');
    if (isFiniteNonNegativeInteger(value.duplicatePayloadCount) && value.duplicatePayloadCount > 0) errors.push('wholeSiteGuarantee=true cannot include duplicate payloads');
    if (unmappedAssetCount > 0) errors.push('wholeSiteGuarantee=true cannot include unmapped assets');
    if (Array.isArray(value.unmanagedStylesheets) && value.unmanagedStylesheets.length > 0) errors.push('wholeSiteGuarantee=true cannot include unmanaged stylesheets');
    if (isRecord(value.classOptimality) && value.classOptimality.status !== 'optimal') errors.push('wholeSiteGuarantee=true requires optimal classOptimality');

    const assetMemberships = new Map<string, number>();
    if (Array.isArray(value.assets)) for (const asset of value.assets) {
      if (!isRecord(asset) || !Array.isArray(asset.packIds)) continue;
      for (const packId of asset.packIds) if (typeof packId === 'string') {
        assetMemberships.set(packId, (assetMemberships.get(packId) ?? 0) + 1);
      }
    }
    for (const packId of packIds) {
      const memberships = assetMemberships.get(packId) ?? 0;
      if (memberships === 0) errors.push(`wholeSiteGuarantee=true requires pack ${packId} to map to a final asset`);
      else if (memberships > 1) errors.push(`wholeSiteGuarantee=true requires pack ${packId} to map to one final asset (found ${memberships})`);
    }

    const ownerIds = new Set<string>();
    if (Array.isArray(value.owners)) for (const owner of value.owners) {
      if (isRecord(owner) && typeof owner.id === 'string') ownerIds.add(owner.id);
    }
    if (Array.isArray(value.packs)) for (const pack of value.packs) {
      if (!isRecord(pack) || !Array.isArray(pack.ownerIds)) continue;
      for (const ownerId of pack.ownerIds) if (typeof ownerId === 'string' && !ownerIds.has(ownerId)) {
        errors.push(`packs reference unknown owner ${ownerId}`);
      }
    }
    if (Array.isArray(value.rules)) for (const rule of value.rules) {
      if (!isRecord(rule)) continue;
      if (Array.isArray(rule.ownerIds)) for (const ownerId of rule.ownerIds) if (typeof ownerId === 'string' && !ownerIds.has(ownerId)) {
        errors.push(`rules reference unknown owner ${ownerId}`);
      }
      if (Array.isArray(rule.packIds)) for (const packId of rule.packIds) if (typeof packId === 'string' && !packIds.includes(packId)) {
        errors.push(`rules reference unknown pack ${packId}`);
      }
    }

    if (Array.isArray(value.classAssignments) && isRecord(value.classOptimality)
      && isRecord(value.classOptimality.upperBound)
      && isFiniteNonNegativeInteger(value.classOptimality.upperBound.K)
      && isFiniteNonNegativeInteger(value.classOptimality.upperBound.T)) {
      const stateIds = new Set<string>();
      const classNames = new Set<string>();
      let totalAssignments = 0;
      for (const assignment of value.classAssignments) {
        if (!isRecord(assignment)) continue;
        if (typeof assignment.stateId === 'string') {
          if (stateIds.has(assignment.stateId)) errors.push(`classAssignments contain duplicate state ${assignment.stateId}`);
          stateIds.add(assignment.stateId);
        }
        if (!Array.isArray(assignment.classNames)) continue;
        for (const className of assignment.classNames) if (typeof className === 'string') {
          classNames.add(className);
          totalAssignments += 1;
        }
      }
      const upperK = value.classOptimality.upperBound.K;
      const upperT = value.classOptimality.upperBound.T;
      if (isFiniteNonNegativeInteger(value.classCount) && value.classCount !== upperK) {
        errors.push(`classCount ${value.classCount} must equal classOptimality.upperBound.K ${upperK}`);
      }
      if (classNames.size !== upperK) errors.push(`classAssignments contain ${classNames.size} unique classes but classOptimality.K is ${upperK}`);
      if (totalAssignments !== upperT) errors.push(`classAssignments contain ${totalAssignments} assignments but classOptimality.T is ${upperT}`);
    }
  }
  return errors;
}

/** Validate unknown report data without changing or enriching its guarantee. */
export function validateNativeReport(value: unknown): NativeReportValidationResult {
  const errors = validateReport(value);
  return { valid: errors.length === 0, errors };
}

/** Parse and validate a schema-v1 native report. */
export function parseNativeReport(value: unknown): NativeReport {
  const result = validateNativeReport(value);
  if (!result.valid) throw new NativeReportValidationError(result.errors);
  return value as NativeReport;
}

/** Alias for callers that read an already-parsed JSON value. */
export function readNativeReport(value: unknown): NativeReport {
  return parseNativeReport(value);
}

/** Type guard for integrations that prefer a non-throwing check. */
export function isNativeReport(value: unknown): value is NativeReport {
  return validateNativeReport(value).valid;
}

function failureReasons(report: NativeReport): string[] {
  const failures: string[] = [];
  if (!report.wholeSiteGuarantee) failures.push('wholeSiteGuarantee=false');
  if (report.duplicateDefinitionCount > 0) failures.push(`duplicateDefinitionCount=${report.duplicateDefinitionCount}`);
  if (report.duplicatePayloadCount > 0) failures.push(`duplicatePayloadCount=${report.duplicatePayloadCount}`);
  const unmapped = report.assets.filter((asset) => asset.unmapped === true).length;
  if (unmapped > 0) failures.push(`unmapped assets=${unmapped}`);
  if (report.unmanagedStylesheets.length > 0) failures.push(`unmanagedStylesheets=${report.unmanagedStylesheets.length}`);
  if (report.diagnostics.length > 0) failures.push(`diagnostics=${report.diagnostics.length}`);
  if (report.classOptimality.status !== 'optimal') failures.push(`classOptimality.status=${report.classOptimality.status}`);
  return failures;
}

/**
 * Assert the release gate represented by a native report. The returned value
 * is the validated report so a CLI can parse and gate it in one expression.
 */
export function assertNativeGuarantee(value: unknown): NativeReport {
  const report = parseNativeReport(value);
  const failures = failureReasons(report);
  if (failures.length > 0) {
    throw new Error(`Native report does not prove whole-site guarantee:\n${failures.map((failure) => `  - ${failure}`).join('\n')}`);
  }
  return report;
}

function sortedCountRecord(values: readonly string[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => compareStrings(left, right)));
}

/** Build a compact, deterministic summary for terminal or CI output. */
export function summarizeNativeReport(report: NativeReport): NativeReportSummary {
  const declarationIds = new Set<string>();
  for (const rule of report.rules) for (const declarationId of rule.declarationIds) declarationIds.add(declarationId);
  const ownerIds = new Set(report.owners.map((owner) => owner.id));
  const unmappedAssetCount = report.assets.filter((asset) => asset.unmapped === true).length;
  return {
    schemaVersion: 1,
    compilerVersion: report.compilerVersion,
    wholeSiteGuarantee: report.wholeSiteGuarantee,
    packCount: report.packs.length,
    assetCount: report.assets.length,
    mappedAssetCount: report.assets.filter((asset) => asset.packIds.length > 0 && asset.unmapped !== true).length,
    unmappedAssetCount,
    ownerCount: ownerIds.size,
    declarationCount: declarationIds.size,
    classCount: report.classCount,
    fixedClassCount: report.fixedClassCount,
    diagnosticCount: report.diagnostics.length,
    diagnosticsByCode: sortedCountRecord(report.diagnostics.map((diagnostic) => diagnostic.code)),
    unmanagedStylesheetCount: report.unmanagedStylesheets.length,
    duplicateDefinitionCount: report.duplicateDefinitionCount,
    duplicatePayloadCount: report.duplicatePayloadCount,
    classOptimality: report.classOptimality,
    failures: failureReasons(report),
  };
}

/** Human-readable summary including the reasons a report cannot be released. */
export function formatNativeReportSummary(report: NativeReport): string {
  const summary = summarizeNativeReport(report);
  const diagnosticCounts = Object.entries(summary.diagnosticsByCode)
    .map(([code, count]) => `${code} x${count}`).join(', ');
  const optimality = summary.classOptimality;
  const lines = [
    `native report (schemaVersion: ${summary.schemaVersion}, compiler: ${summary.compilerVersion}, wholeSiteGuarantee: ${String(summary.wholeSiteGuarantee)})`,
    `packs: ${summary.packCount}, assets: ${summary.assetCount} (mapped: ${summary.mappedAssetCount}, unmapped: ${summary.unmappedAssetCount})`,
    `owners: ${summary.ownerCount}, declarations: ${summary.declarationCount}, classes: ${summary.classCount} (fixed: ${summary.fixedClassCount})`,
    `diagnostics: ${summary.diagnosticCount}${diagnosticCounts.length > 0 ? ` (${diagnosticCounts})` : ''}`,
    `duplicates: definitions: ${summary.duplicateDefinitionCount}, payloads: ${summary.duplicatePayloadCount}`,
    `unmanaged stylesheets: ${summary.unmanagedStylesheetCount}`,
    `classOptimality: ${optimality.status} (K ${optimality.lowerBound.K}/${optimality.upperBound.K}, T ${optimality.lowerBound.T}/${optimality.upperBound.T}, candidates: ${optimality.candidateCount}, nodes: ${optimality.exploredNodes})`,
  ];
  if (summary.failures.length > 0) {
    lines.push('failures:', ...summary.failures.map((failure) => `  ${failure}`));
  }
  return lines.join('\n');
}

/** Map each pack to its owners, declarations, and final bundle assets. */
export function mapNativeReportPacks(report: NativeReport): readonly NativeReportPackMapping[] {
  return [...report.packs]
    .sort((left, right) => compareStrings(left.id, right.id))
    .map((pack) => ({
      packId: pack.id,
      ownerIds: [...pack.ownerIds].sort(compareStrings),
      declarationIds: [...pack.declarationIds].sort(compareStrings),
      assets: report.assets
        .filter((asset) => asset.packIds.includes(pack.id))
        .map((asset) => asset.fileName)
        .sort(compareStrings),
    }));
}

/** Human-readable form of {@link mapNativeReportPacks}. */
export function formatNativePackMappings(report: NativeReport): string {
  const mappings = mapNativeReportPacks(report);
  const lines = [`native pack mappings (packs: ${mappings.length})`];
  for (const mapping of mappings) {
    lines.push(
      `  ${mapping.packId}`,
      `    owners: ${mapping.ownerIds.length > 0 ? mapping.ownerIds.join(', ') : '(none)'}`,
      `    declarations: ${mapping.declarationIds.length > 0 ? mapping.declarationIds.join(', ') : '(none)'}`,
      `    assets: ${mapping.assets.length > 0 ? mapping.assets.join(', ') : '(none)'}`,
    );
  }
  return lines.join('\n');
}
