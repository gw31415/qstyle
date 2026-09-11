import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseStyleModule } from '@qstyle/compiler';
import type { DeclarationDefinition, DemandSite, NativeStylePack, OptimizedStyleProgram, RegisteredDeclaration, StyleSelector } from '@qstyle/core';
import type { FrozenStyleGraph, StyleSourceModule } from './graph.js';
import { createNativeReport, type NativeReportBundle, type NativeReportBundleItem } from './native-report.js';

function emptyProgram(
  packs: readonly NativeStylePack[],
  overrides: {
    readonly declarations?: readonly RegisteredDeclaration[];
    readonly fixedDeclarations?: readonly RegisteredDeclaration[];
    readonly cover?: OptimizedStyleProgram['cover'];
    readonly classes?: readonly string[];
    readonly classesByState?: ReadonlyMap<string, readonly string[]>;
  } = {},
): OptimizedStyleProgram {
  const objective = { K: 0, T: 0 };
  const cover = {
    basis: [], classes: [], assignments: new Map(), perStateAssignments: new Map(), globalOrder: [], topologicalOrder: [],
    K: 0, T: 0, classCount: 0, assignmentCount: 0, lowerBound: objective, upperBound: objective,
    optimality: { status: 'optimal' as const, lowerBound: objective, upperBound: objective }, candidateCount: 0, exploredNodes: 0,
  };
  return { declarations: overrides.declarations ?? [], fixedDeclarations: overrides.fixedDeclarations ?? [], cover: overrides.cover ?? cover,
    classes: overrides.classes ?? [], classesByState: overrides.classesByState ?? new Map(), packs: [...packs],
    packsByDemand: new Map(), duplicateDefinitionCount: 0, duplicatePayloadCount: 0 };
}

function graphFor(
  packs: readonly NativeStylePack[], modules: readonly StyleSourceModule[] = [], unmanagedStylesheets: readonly string[] = [],
): FrozenStyleGraph {
  return {
    generation: 1, digest: 'graph-digest', modules: new Map(modules.map((module) => [module.id, module])),
    reverseDependencies: new Map(), analyses: new Map(), program: emptyProgram(packs), unmanagedStylesheets,
  };
}

function pack(
  id: string,
  css: string,
  demandIds: readonly string[] = [],
  options: { readonly declarationIds?: readonly string[]; readonly globalIds?: readonly string[] } = {},
): NativeStylePack {
  return { id, declarationIds: options.declarationIds ?? [], demandIds, css, cssBytes: new TextEncoder().encode(css).length,
    ...(options.globalIds ? { globalIds: options.globalIds } : {}) };
}

function registered(id: string, selector: StyleSelector, demandId = 'demand'): RegisteredDeclaration {
  const declaration: DeclarationDefinition['declaration'] = {
    property: 'color', value: { kind: 'static', css: 'red' }, important: false,
  };
  const definition: DeclarationDefinition = { selector, wrappers: [], declaration, dependencies: [] };
  const demand: DemandSite = { id: demandId, owner: 'owner', renderPath: 'render', styleState: '0', lazyBoundary: 'owner', predicate: 'true' };
  return { id, definition, demands: [demand], sources: [] };
}

function bundle(...items: readonly NativeReportBundleItem[]): NativeReportBundle {
  return Object.fromEntries(items.map((item) => [item.fileName, item]));
}

function chunk(fileName: string, code: string): NativeReportBundleItem {
  return { type: 'chunk', fileName, code };
}

function asset(fileName: string, source: string | Uint8Array): NativeReportBundleItem {
  return { type: 'asset', fileName, source };
}

function sourceModule(fileName: string, code: string): StyleSourceModule {
  return {
    id: fileName, key: fileName, code, digest: createHash('sha256').update(code).digest('hex'),
    parsed: parseStyleModule(code, fileName), imports: new Map(),
  };
}

const metadata = { root: '/private/qstyle-project', compilerVersion: 'test-compiler', targetVersions: { qwik: '2', vite: '8' } };

describe('native final bundle report', () => {
  it('requires optimizer style symbols to map to the chunk that actually contains their CSS', () => {
    const nativePack = pack('12121212121212121212121212121212', '.mapped{color:red}');
    const outputs = [chunk('build/body.js', `const css=${JSON.stringify(nativePack.css)};export {css as style};`),
      chunk('build/other.js', 'export const text="not the CSS body";')];
    const manifest = (fileName: string) => asset('q-manifest.json', JSON.stringify({
      symbols: { style: { ctxName: 'useStyles$', hash: 'style', origin: `../.qstyle/native/${nativePack.id}.tsx` } },
      mapping: { style: fileName },
    }));
    expect(createNativeReport(graphFor([nativePack]), bundle(...outputs, manifest('body.js')), metadata).wholeSiteGuarantee).toBe(true);
    const wrong = createNativeReport(graphFor([nativePack]), bundle(...outputs, manifest('other.js')), metadata);
    expect(wrong.duplicatePayloadCount).toBe(0);
    expect(wrong.wholeSiteGuarantee).toBe(false);
    expect(wrong.diagnostics.some((item) => item.code === 'QS1601')).toBe(true);
    const unrelated = createNativeReport(graphFor([nativePack]), bundle(
      chunk('build/body.js', `export const unrelated=${JSON.stringify(nativePack.css)};`), manifest('body.js'),
    ), metadata);
    expect(unrelated.wholeSiteGuarantee).toBe(false);
    expect(unrelated.diagnostics.some((item) => item.code === 'QS1601')).toBe(true);
  });

  it('maps escaped string and static template literals, while counting duplicate payloads', () => {
    const css = '.escaped::before{content:"line";}';
    const nativePack = pack('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', css);
    const code = `const stringValue=${JSON.stringify(css)};const templateValue=\`${css}\`;`;
    const report = createNativeReport(graphFor([nativePack]), bundle(chunk('build/styles.js', code)), metadata);

    expect(report.assets[0]?.packIds).toEqual([nativePack.id]);
    expect(report.duplicatePayloadCount).toBe(1);
    expect(report.wholeSiteGuarantee).toBe(false);
  });

  it('maps a CSS asset only when its bytes are an exact pack concatenation', () => {
    const first = pack('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'a{}');
    const second = pack('cccccccccccccccccccccccccccccccc', 'b{}');
    const report = createNativeReport(graphFor([first, second]), bundle(asset('assets/styles.css', 'a{}b{}')), metadata);

    expect(report.assets[0]?.packIds).toEqual([first.id, second.id]);
    expect(report.assets[0]?.unmapped).toBe(false);
    expect(report.duplicatePayloadCount).toBe(0);
    expect(report.wholeSiteGuarantee).toBe(false); // Bytes map, but Qwik delivery provenance is missing.
  });

  it('fails closed for a known native reference without a decoded CSS payload', () => {
    const nativePack = pack('dddddddddddddddddddddddddddddddd', '.known{}');
    const report = createNativeReport(
      graphFor([nativePack]),
      bundle(chunk('build/native.js', `import "/.qstyle/native/${nativePack.id}.tsx";`)),
      metadata,
    );

    expect(report.wholeSiteGuarantee).toBe(false);
    expect(report.diagnostics.some((item) => item.code === 'QS1601')).toBe(true);
    expect(report.assets[0]?.unmapped).toBe(true);
  });

  it('uses structured Qwik manifest provenance for missing native payloads', () => {
    const nativePack = pack('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '.manifest{}');
    const manifest = JSON.stringify({
      symbols: { style: { origin: `../.qstyle/native/${nativePack.id}.tsx`, ctxName: 'useStyles$' } },
      mapping: { style: 'build/native.js' },
    });
    const report = createNativeReport(graphFor([nativePack]), bundle(asset('q-manifest.json', manifest)), metadata);

    expect(report.diagnostics.some((item) => item.code === 'QS1601')).toBe(true);
    expect(report.wholeSiteGuarantee).toBe(false);
  });

  it.each([undefined, null, 7, ''])('rejects an unprovable native style identity with hash %s', (hash) => {
    const nativePack = pack('12121212121212121212121212121212', '.mapped{color:red}');
    const report = createNativeReport(graphFor([nativePack]), bundle(
      chunk('style.js', `export const style=${JSON.stringify(nativePack.css)};`),
      asset('q-manifest.json', JSON.stringify({
        symbols: { style: { ctxName: 'useStyles$', hash, origin: `../.qstyle/native/${nativePack.id}.tsx` } },
        mapping: { style: 'style.js' },
      })),
    ), metadata);
    expect(report.wholeSiteGuarantee).toBe(false);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'QS1601', message: expect.stringContaining('valid hash'),
    }));
  });

  it('fails closed when distinct native symbols collide in Qwik beta.43 style IDs', () => {
    const first = pack('12121212121212121212121212121212', '.first{color:red}');
    const second = pack('34343434343434343434343434343434', '.second{color:blue}');
    // beta.43's styleKey hashes the manifest symbol.hash with rolling31 and uses hook index 0.
    const manifest = JSON.stringify({ symbols: {
      s_Aa: { ctxName: 'useStyles$', hash: 'Aa', origin: `../.qstyle/native/${first.id}.tsx` },
      s_BB: { ctxName: 'useStyles$', hash: 'BB', origin: `../.qstyle/native/${second.id}.tsx` },
    }, mapping: { s_Aa: 'first.js', s_BB: 'second.js' } });
    const report = createNativeReport(
      graphFor([first, second]),
      bundle(
        chunk('first.js', `export const s_Aa=${JSON.stringify(first.css)};`),
        chunk('second.js', `export const s_BB=${JSON.stringify(second.css)};`),
        asset('q-manifest.json', manifest),
      ),
      metadata,
    );

    expect(report.assets.find((item) => item.fileName === 'first.js')?.packIds).toEqual([first.id]);
    expect(report.assets.find((item) => item.fileName === 'second.js')?.packIds).toEqual([second.id]);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'QS1301',
      message: expect.stringContaining('1mo-0'),
    }));
    expect(report.diagnostics.find((item) => item.code === 'QS1301')?.message)
      .toEqual(expect.stringContaining('s_Aa'));
    expect(report.diagnostics.find((item) => item.code === 'QS1301')?.message)
      .toEqual(expect.stringContaining('s_BB'));
    expect(report.wholeSiteGuarantee).toBe(false);
  });

  it('reports authored style hooks and style/link elements as unmanaged', () => {
    const code = `import {useStyles$ as global,useStylesScoped$} from '@qwik.dev/core';
      import * as q from '@qwik.dev/core';
      export default function Root(){global("a{}");useStylesScoped$("b{}");q.useStyles$("c{}");
        return <><style/><link rel="stylesheet" href="/legacy.css"/></>}`;
    const module = sourceModule('src/root.tsx', code);
    const report = createNativeReport(graphFor([], [module], ['src/theme.css']), bundle(), metadata);

    expect(report.unmanagedStylesheets).toEqual(['src/root.tsx', 'src/theme.css']);
    expect(report.diagnostics.filter((item) => item.code === 'QS1603').length).toBeGreaterThan(0);
    expect(report.wholeSiteGuarantee).toBe(false);
    const start = code.indexOf('global("a{}")');
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'QS1603', file: 'src/root.tsx', start, end: start + 'global("a{}")'.length,
    }));
  });

  it('does not expose source CSS or absolute paths in the report', () => {
    const css = '.private{color:rgb(1,2,3)}';
    const nativePack = pack('ffffffffffffffffffffffffffffffff', css, ['/private/qstyle-project/src/root.tsx#state:0']);
    const module = sourceModule('/private/qstyle-project/src/root.tsx', `export const secret=${JSON.stringify(css)};`);
    const report = createNativeReport(
      graphFor([nativePack], [module]),
      bundle(chunk('build/styles.js', `const css=${JSON.stringify(css)};`)),
      metadata,
    );
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain('/private/qstyle-project');
    expect(serialized).not.toContain(css);
    expect(report.packs[0]?.cssDigest).toBe(createHash('sha256').update(css).digest('hex'));
    expect(report.assets[0]?.contentDigest).toBe(createHash('sha256').update(`const css=${JSON.stringify(css)};`).digest('hex'));
  });

  it('marks an unrelated final CSS asset as unmapped', () => {
    const nativePack = pack('11111111111111111111111111111111', '.known{}');
    const report = createNativeReport(graphFor([nativePack]), bundle(
      asset('assets/third-party.css', '.third-party{}'),
      chunk('build/native.js', JSON.stringify(nativePack.css)),
    ), metadata);

    expect(report.assets.find((item) => item.fileName.endsWith('third-party.css'))?.unmapped).toBe(true);
    expect(report.diagnostics.some((item) => item.code === 'QS1603')).toBe(true);
    expect(report.wholeSiteGuarantee).toBe(false);
  });

  it('counts duplicate declaration/global memberships and reports missing declaration membership', () => {
    const selector: StyleSelector = { alternatives: [[{ kind: 'text', text: '.fixed' }]] };
    const duplicate = registered('decl-duplicate', selector);
    const duplicatePack = pack('22222222222222222222222222222222', '.duplicate{}', ['demand'], {
      declarationIds: [duplicate.id, duplicate.id], globalIds: ['global-duplicate', 'global-duplicate'],
    });
    const duplicateReport = createNativeReport(
      { ...graphFor([duplicatePack]), program: emptyProgram([duplicatePack], { declarations: [duplicate] }) },
      bundle(chunk('build/duplicate.js', JSON.stringify(duplicatePack.css))), metadata,
    );
    expect(duplicateReport.duplicateDefinitionCount).toBe(2);
    expect(duplicateReport.diagnostics.filter((item) => item.code === 'QS1601').length).toBeGreaterThanOrEqual(2);
    expect(duplicateReport.wholeSiteGuarantee).toBe(false);

    const missing = registered('decl-missing', selector);
    const missingPack = pack('33333333333333333333333333333333', '.missing{}', ['demand']);
    const missingReport = createNativeReport(
      { ...graphFor([missingPack]), program: emptyProgram([missingPack], { declarations: [missing] }) },
      bundle(chunk('build/missing.js', JSON.stringify(missingPack.css))), metadata,
    );
    expect(missingReport.duplicateDefinitionCount).toBe(0);
    expect(missingReport.diagnostics.some((item) => item.code === 'QS1601'
      && item.message.includes('no final native pack membership'))).toBe(true);
    expect(missingReport.wholeSiteGuarantee).toBe(false);
  });

  it('counts unique decoded fixed selector class names rather than fixed declarations', () => {
    const selector: StyleSelector = { alternatives: [[{ kind: 'text',
      text: '.group .hover\\:active:is(.shared,.group)[data-label=".not-a-class"],.shared' }]] };
    const first = registered('fixed-one', selector);
    const second = registered('fixed-two', selector, 'demand-two');
    const nativePack = pack('44444444444444444444444444444444', '.fixed{}', ['demand', 'demand-two'], {
      declarationIds: [first.id, second.id],
    });
    const report = createNativeReport(
      { ...graphFor([nativePack]), program: emptyProgram([nativePack], { fixedDeclarations: [first, second] }) },
      bundle(chunk('build/fixed.js', JSON.stringify(nativePack.css))), metadata,
    );

    expect(report.fixedClassCount).toBe(3);
    expect(report.fixedClassCount).not.toBe(2);
  });

  it('fails the guarantee when class optimality bounds are not equal', () => {
    const nativePack = pack('55555555555555555555555555555555', '.known{}');
    const cover = emptyProgram([]).cover;
    const unknownCover = {
      ...cover,
      lowerBound: { K: 0, T: 0 }, upperBound: { K: 1, T: 1 },
    };
    const report = createNativeReport(
      { ...graphFor([nativePack]), program: emptyProgram([nativePack], { cover: unknownCover }) },
      bundle(chunk('build/optimality.js', JSON.stringify(nativePack.css))), metadata,
    );

    expect(report.classOptimality.status).toBe('unknown');
    expect(report.diagnostics.some((item) => item.code === 'QS1602')).toBe(true);
    expect(report.wholeSiteGuarantee).toBe(false);
  });

  it('reports malformed final manifests without throwing', () => {
    const report = createNativeReport(graphFor([]), bundle(asset('q-manifest.json', '{malformed')), metadata);

    expect(report.diagnostics.some((item) => item.code === 'QS1601'
      && item.message.includes('Cannot parse the final Qwik manifest'))).toBe(true);
    expect(report.wholeSiteGuarantee).toBe(false);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'QS1601', file: 'q-manifest.json', start: 0, end: '{malformed'.length,
    }));
  });

  it('flags unknown dependency style hooks from structured manifest symbols', () => {
    const manifest = JSON.stringify({ symbols: {
      dependencyStyle: { ctxName: 'useStylesScoped$', origin: '../node_modules/vendor/styles.tsx' },
    } });
    const report = createNativeReport(graphFor([]), bundle(asset('q-manifest.json', manifest)), metadata);

    expect(report.diagnostics.some((item) => item.code === 'QS1603'
      && item.message.includes('unmanaged authored style hook'))).toBe(true);
    expect(report.wholeSiteGuarantee).toBe(false);
  });

  it('ignores shadowed or unrelated useStyles names without a Qwik core binding', () => {
    const shadowed = sourceModule('src/shadowed.tsx', `const useStyles$=()=>{}; export default function Root(){useStyles$("x{}");return null;}`);
    const unrelated = sourceModule('src/unrelated.tsx', `import {useStyles$ as styles} from 'other'; export default function Root(){styles("x{}");return null;}`);
    const report = createNativeReport(graphFor([], [shadowed, unrelated]), bundle(), metadata);

    expect(report.unmanagedStylesheets).toEqual([]);
    expect(report.diagnostics).toEqual([]);
    expect(report.wholeSiteGuarantee).toBe(true);
  });
});
