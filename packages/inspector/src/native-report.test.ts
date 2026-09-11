import { describe, expect, it } from 'vitest';
import {
  NativeReportValidationError,
  assertNativeGuarantee,
  formatNativePackMappings,
  formatNativeReportSummary,
  mapNativeReportPacks,
  parseNativeReport,
  summarizeNativeReport,
  validateNativeReport,
  type NativeReport,
} from './native-report.js';

function report(overrides: Partial<NativeReport> = {}): NativeReport {
  return {
    schemaVersion: 1,
    compilerVersion: 'test-compiler',
    targetVersions: { qwik: '2.0.0-beta.43', vite: '8.2.2' },
    modules: [],
    owners: [{ id: 'src/root.tsx#owner', demandIds: ['demand-1'] }],
    rules: [{ id: 'decl-1', declarationIds: ['decl-1'], ownerIds: ['src/root.tsx#owner'], packIds: ['pack-a'], fixed: false }],
    packs: [{ id: 'pack-a', declarationIds: ['decl-1'], ownerIds: ['src/root.tsx#owner'], cssBytes: 12, cssDigest: 'digest-a' }],
    assets: [{ fileName: 'build/native.js', contentDigest: 'digest-asset', bytes: 12, packIds: ['pack-a'], kind: 'chunk' }],
    diagnostics: [],
    timings: { discoveryMs: 1.5 },
    wholeSiteGuarantee: true,
    unmanagedStylesheets: [],
    duplicateDefinitionCount: 0,
    duplicatePayloadCount: 0,
    classCount: 1,
    classAssignments: [{ stateId: 'state-1', classNames: ['q1_a'] }],
    fixedClassCount: 0,
    classOptimality: {
      status: 'optimal',
      lowerBound: { K: 1, T: 1 },
      upperBound: { K: 1, T: 1 },
      candidateCount: 1,
      exploredNodes: 1,
      modelVersion: 'native-class-cover-v1',
    },
    ...overrides,
  };
}

describe('native report inspector', () => {
  it('reads a real-shaped report and maps pack owners, declarations, and assets', () => {
    const parsed = parseNativeReport(report({
      modules: [{ id: 'src/root.tsx', digest: 'module-digest', imports: [], source: 'export const style = "...";' }],
      owners: [
        { id: 'src/root.tsx#owner', demandIds: ['demand-1'] },
        { id: 'src/root.tsx#shared', demandIds: ['demand-2'] },
      ],
      rules: [
        { id: 'decl-1', declarationIds: ['decl-1'], ownerIds: ['src/root.tsx#owner'], packIds: ['pack-a'], fixed: false },
        { id: 'decl-2', declarationIds: ['decl-2'], ownerIds: ['src/root.tsx#shared'], packIds: ['pack-b'], fixed: true },
      ],
      packs: [
        { id: 'pack-a', declarationIds: ['decl-1'], ownerIds: ['src/root.tsx#owner'], cssBytes: 12, cssDigest: 'digest-a' },
        { id: 'pack-b', declarationIds: ['decl-2'], ownerIds: ['src/root.tsx#shared'], cssBytes: 18, cssDigest: 'digest-b' },
      ],
      assets: [
        { fileName: 'build/native-a.js', contentDigest: 'digest-asset-a', bytes: 12, packIds: ['pack-a'], kind: 'chunk' },
        { fileName: 'build/native-b.js', contentDigest: 'digest-asset-b', bytes: 18, packIds: ['pack-b'], kind: 'chunk' },
      ],
      classCount: 1,
      classAssignments: [{ stateId: 'state-1', classNames: ['q1_a'] }],
    }));
    const mappings = mapNativeReportPacks(parsed);

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.modules[0]?.source).toContain('export const style');
    expect(mappings).toHaveLength(parsed.packs.length);
    expect(mappings.find((mapping) => mapping.packId === 'pack-a')).toEqual({
      packId: 'pack-a',
      ownerIds: ['src/root.tsx#owner'],
      declarationIds: ['decl-1'],
      assets: ['build/native-a.js'],
    });

    const summary = summarizeNativeReport(parsed);
    expect(summary).toMatchObject({
      packCount: 2,
      assetCount: 2,
      mappedAssetCount: 2,
      unmappedAssetCount: 0,
      ownerCount: 2,
      declarationCount: 2,
      diagnosticCount: 0,
      wholeSiteGuarantee: true,
    });
    expect(formatNativeReportSummary(parsed)).toContain('wholeSiteGuarantee: true');
    expect(formatNativePackMappings(parsed)).toContain('build/native-a.js');
  });

  it('rejects an unknown schema version and a contradictory guarantee', () => {
    const unknownVersion = validateNativeReport({ ...report(), schemaVersion: 2 });
    expect(unknownVersion.valid).toBe(false);
    expect(unknownVersion.errors).toContain('schemaVersion must be exactly 1');
    expect(() => parseNativeReport({ ...report(), schemaVersion: 2 })).toThrow(NativeReportValidationError);

    const malformedGuarantee = validateNativeReport({
      ...report(),
      diagnostics: [{ code: 'QS1603', message: 'unmanaged style' }],
      wholeSiteGuarantee: true,
    });
    expect(malformedGuarantee.valid).toBe(false);
    expect(malformedGuarantee.errors).toContain('wholeSiteGuarantee=true cannot include diagnostics');
    expect(() => parseNativeReport({
      ...report(),
      diagnostics: [{ code: 'QS1603', message: 'unmanaged style' }],
      wholeSiteGuarantee: true,
    })).toThrow(/wholeSiteGuarantee=true/);
  });

  it('summarizes duplicate and unmapped delivery failures and gates them', () => {
    const duplicateAndUnmapped = report({
      wholeSiteGuarantee: false,
      duplicateDefinitionCount: 1,
      duplicatePayloadCount: 1,
      assets: [
        { fileName: 'build/first.js', contentDigest: 'first', bytes: 1, packIds: ['pack-a'], kind: 'chunk' },
        { fileName: 'build/third-party.css', contentDigest: 'third-party', bytes: 1, packIds: [], kind: 'css', unmapped: true },
      ],
      diagnostics: [{ code: 'QS1601', message: 'duplicate final payload' }],
      classOptimality: {
        status: 'unknown',
        lowerBound: { K: 1, T: 1 },
        upperBound: { K: 2, T: 2 },
        candidateCount: 2,
        exploredNodes: 3,
        modelVersion: 'native-class-cover-v1',
      },
    });
    const summary = summarizeNativeReport(duplicateAndUnmapped);
    expect(summary.failures).toEqual(expect.arrayContaining([
      'wholeSiteGuarantee=false',
      'duplicateDefinitionCount=1',
      'duplicatePayloadCount=1',
      'unmapped assets=1',
      'diagnostics=1',
      'classOptimality.status=unknown',
    ]));
    const formatted = formatNativeReportSummary(duplicateAndUnmapped);
    expect(formatted).toContain('unmapped: 1');
    expect(formatted).toContain('duplicateDefinitionCount=1');
    expect(() => assertNativeGuarantee(duplicateAndUnmapped)).toThrow(/duplicatePayloadCount=1/);
  });

  it('rejects malformed key data instead of inferring a guarantee', () => {
    const malformed = {
      ...report(),
      wholeSiteGuarantee: 'true',
      packs: [{ ...report().packs[0], cssBytes: -1 }],
      assets: [{ ...report().assets[0], packIds: ['missing-pack'] }],
      classOptimality: { ...report().classOptimality, status: 'optimal', upperBound: { K: 2, T: 2 } },
    } as unknown;
    const result = validateNativeReport(malformed);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toEqual(expect.stringContaining('wholeSiteGuarantee must be a boolean'));
    expect(result.errors.join('\n')).toEqual(expect.stringContaining('assets reference unknown pack missing-pack'));
    expect(result.errors.join('\n')).toEqual(expect.stringContaining('status=optimal requires equal'));
  });

  it('rejects a true guarantee with inconsistent delivery, references, or class counts', () => {
    const missingAsset = validateNativeReport(report({ assets: [] }));
    expect(missingAsset.valid).toBe(false);
    expect(missingAsset.errors).toContain('wholeSiteGuarantee=true requires pack pack-a to map to a final asset');

    const duplicateAsset = validateNativeReport(report({
      assets: [
        { fileName: 'build/first.js', contentDigest: 'first', bytes: 1, packIds: ['pack-a'], kind: 'chunk' },
        { fileName: 'build/second.js', contentDigest: 'second', bytes: 1, packIds: ['pack-a'], kind: 'chunk' },
      ],
    }));
    expect(duplicateAsset.valid).toBe(false);
    expect(duplicateAsset.errors).toContain('wholeSiteGuarantee=true requires pack pack-a to map to one final asset (found 2)');

    const inconsistentClasses = validateNativeReport(report({ classCount: 2 }));
    expect(inconsistentClasses.valid).toBe(false);
    expect(inconsistentClasses.errors).toContain('classCount 2 must equal classOptimality.upperBound.K 1');

    const unknownReferences = validateNativeReport(report({
      owners: [{ id: 'src/root.tsx#owner', demandIds: ['demand-1'] }],
      rules: [{ id: 'decl-1', declarationIds: ['decl-1'], ownerIds: ['missing-owner'], packIds: ['missing-pack'], fixed: false }],
      packs: [{ id: 'pack-a', declarationIds: ['decl-1'], ownerIds: ['missing-owner'], cssBytes: 12, cssDigest: 'digest-a' }],
    }));
    expect(unknownReferences.valid).toBe(false);
    expect(unknownReferences.errors).toEqual(expect.arrayContaining([
      'rules reference unknown owner missing-owner',
      'rules reference unknown pack missing-pack',
      'packs reference unknown owner missing-owner',
    ]));
  });
});
