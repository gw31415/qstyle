import { readFile } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import {
  analyzeStyleModule, emitStyleModule, lowerStyleExpression, parseStyleModule, resolveStyleGlobals,
  utilityRequests, composeUtilityStates, utilityAuxiliaryNodes, attachUtilityFoundation,
  resolveDocumentEntry,
  type AnalyzedStyleModule, type ParsedStyleModule, type StyleExpression, type UtilityAdapter, type UtilityCssNode,
} from '@qstyle/compiler';
import { NativeIdentityRegistry, NativeStyleError, optimizeStyleProgram, optimizeFixedStyleProgram, wrapNativeCss, type StyleProgramState, type NativeStylePack, type OptimizedStyleProgram } from '@qstyle/core';

export interface GraphResolution {
  readonly id: string;
  readonly external?: boolean;
}

export interface SourceGraphOptions {
  readonly utilities?: UtilityAdapter;
  readonly development?: boolean;
  readonly root: string;
  readonly entries: readonly string[];
  /** Additional application sources, without treating them as document renderers. */
  readonly discoveryEntries?: readonly string[];
  readonly resolve: (specifier: string, importer?: string) => Promise<GraphResolution | undefined>;
  /** Virtual entries may be supplied by Vite's loader. Files use raw source bytes. */
  readonly loadVirtual?: (id: string) => Promise<string | undefined>;
  readonly read?: (id: string) => Promise<string>;
}

export interface StyleSourceModule {
  readonly id: string;
  readonly key: string;
  readonly code: string;
  readonly digest: string;
  readonly parsed: ParsedStyleModule;
  readonly imports: ReadonlyMap<string, string>;
}

export interface FrozenStyleGraph {
  readonly generation: number;
  readonly digest: string;
  readonly modules: ReadonlyMap<string, StyleSourceModule>;
  readonly reverseDependencies: ReadonlyMap<string, ReadonlySet<string>>;
  readonly analyses: ReadonlyMap<string, AnalyzedStyleModule>;
  readonly program: OptimizedStyleProgram;
  readonly unmanagedStylesheets: readonly string[];
}

const SOURCE = /\.(?:[cm]?[jt]sx?)(?:$|\?)/;
const STYLESHEET = /\.(?:css|scss|sass|less|styl|stylus)(?:$|\?)/;

export function sourceModuleKey(root: string, id: string): string {
  return isAbsolute(id) ? relative(root, id).split('\\').join('/') : id;
}

function sourceDigest(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Collect import edges with the same parser as the style frontend. */
function importSpecifiers(module: ParsedStyleModule): readonly string[] {
  const specifiers = new Set<string>();
  module.program.traverse({
    ImportDeclaration(path) {
      if (path.node.importKind !== 'type' && (path.node.specifiers.length === 0 || path.node.specifiers.some((item) =>
        item.type !== 'ImportSpecifier' || item.importKind !== 'type'))) specifiers.add(path.node.source.value);
    },
    ExportNamedDeclaration(path) {
      if (path.node.source && path.node.exportKind !== 'type' && (path.node.specifiers.length === 0 || path.node.specifiers.some((item) =>
        item.type !== 'ExportSpecifier' || item.exportKind !== 'type'))) specifiers.add(path.node.source.value);
    },
    ExportAllDeclaration(path) { if (path.node.exportKind !== 'type') specifiers.add(path.node.source.value); },
    ImportExpression(path) {
      if (path.node.source.type === 'StringLiteral') specifiers.add(path.node.source.value);
      else throw new NativeStyleError({ code: 'QS1401', message: 'Dynamic import paths must be finite before style graph freeze.',
        source: { file: module.file, start: path.node.start ?? 0, end: path.node.end ?? 0 } });
    },
  });
  return [...specifiers].sort();
}

/** Build a new graph atomically. The caller retains its previous generation on failure. */
export async function buildStyleGraph(options: SourceGraphOptions, generation = 0): Promise<FrozenStyleGraph> {
  const modules = new Map<string, StyleSourceModule>();
  const reverse = new Map<string, Set<string>>();
  const unmanaged = new Set<string>();
  const loading = new Set<string>();
  const entryIds = new Set<string>();
  const read = options.read ?? ((id: string) => readFile(id, 'utf8'));
  const visit = async (id: string, entry = false): Promise<void> => {
    if (modules.has(id) || loading.has(id)) return;
    if (STYLESHEET.test(id)) { unmanaged.add(sourceModuleKey(options.root, id)); return; }
    if (id.includes('/node_modules/') && !id.split('?')[0]!.endsWith('.qstyle.ts')) return;
    if (!SOURCE.test(id) && !entry && isAbsolute(id)) return;
    loading.add(id);
    const file = isAbsolute(id);
    const code = file ? await read(id.split('?')[0]!) : await options.loadVirtual?.(id);
    if (code === undefined) {
      throw new NativeStyleError({ code: 'QS1401', message: `Cannot discover generated module ${id} before graph freeze.` });
    }
    const key = sourceModuleKey(options.root, id);
    const parsed = parseStyleModule(code, SOURCE.test(id) ? key : `${key}.ts`);
    const imports = new Map<string, string>();
    // Insert before traversing to terminate ordinary ESM cycles.
    modules.set(id, { id, key, code, digest: sourceDigest(code), parsed, imports });
    for (const specifier of importSpecifiers(parsed)) {
      if (specifier.startsWith('node:')) continue;
      const resolved = await options.resolve(specifier, id);
      if (!resolved) {
        throw new NativeStyleError({ code: 'QS1401', message: `Cannot resolve ${JSON.stringify(specifier)} from ${key}.` });
      }
      if (resolved.external) continue;
      imports.set(specifier, resolved.id);
      const parents = reverse.get(resolved.id) ?? new Set<string>();
      parents.add(id); reverse.set(resolved.id, parents);
      await visit(resolved.id);
    }
    loading.delete(id);
  };
  for (const entry of [...new Set(options.entries)].sort()) {
    const resolved = await options.resolve(entry);
    if (!resolved || resolved.external) throw new NativeStyleError({ code: 'QS1401', message: `Cannot discover application entry ${entry}.` });
    entryIds.add(resolved.id);
    await visit(resolved.id, true);
  }
  for (const entry of [...new Set(options.discoveryEntries ?? [])].sort()) {
    const resolved = await options.resolve(entry);
    if (!resolved || resolved.external) throw new NativeStyleError({ code: 'QS1401', message: `Cannot discover application source ${entry}.` });
    await visit(resolved.id, true);
  }
  const exporting = new Set<string>();
  const exported = new Map<string, StyleExpression>();
  const exportOrigins = new Map<string, string>();
  let exportCycleEpoch = 0;
  interface ResolvedExport {
    readonly value: StyleExpression;
    readonly origin: string;
  }
  const resolveExportRecord = (id: string, name: string): ResolvedExport | undefined => {
    const cacheKey = JSON.stringify([id, name]);
    const cached = exported.get(cacheKey);
    if (cached) {
      const origin = exportOrigins.get(cacheKey);
      if (origin) return { value: cached, origin };
    }
    // ESM star cycles stop this search branch; another branch may reach the
    // concrete binding. Results reached through a cycle are not globally cached.
    if (exporting.has(cacheKey)) { exportCycleEpoch++; return; }
    const cycleEpoch = exportCycleEpoch;
    const module = modules.get(id);
    if (!module || !id.endsWith('.qstyle.ts')) throw new NativeStyleError({ code: 'QS1102',
      message: `Compile-time style imports must resolve to a static .qstyle.ts module: ${id}.` });
    exporting.add(cacheKey);
    try {
      let result: ResolvedExport | undefined;
      for (const statement of module.parsed.program.get('body')) {
        if (!statement.isExportNamedDeclaration()) continue;
        const declaration = statement.get('declaration');
        if (declaration?.isVariableDeclaration()) {
          for (const binding of declaration.get('declarations')) {
            if (binding.node.id.type !== 'Identifier' || binding.node.id.name !== name) continue;
            const init = binding.get('init');
            if (!init.isExpression()) throw new NativeStyleError({ code: 'QS1102', message: `Style export ${name} has no initializer.` });
            result = { value: lowerStyleExpression(init, module.parsed, { resolveImport: (specifier, imported) => {
              const target = module.imports.get(specifier); return target ? resolveExport(target, imported) : undefined;
            } }), origin: `${id}#${name}` };
          }
        }
        for (const specifier of statement.get('specifiers')) {
          if (!specifier.isExportSpecifier()) continue;
          const exportedName = specifier.node.exported.type === 'Identifier' ? specifier.node.exported.name : specifier.node.exported.value;
          if (exportedName !== name) continue;
          const localName = specifier.node.local.name;
          const source = statement.node.source?.value;
          if (source) {
            const target = module.imports.get(source);
            const resolved = target ? resolveExportRecord(target, localName) : undefined;
            if (resolved) result = resolved;
          } else {
            const binding = specifier.scope.getBinding(localName);
            if (binding?.path.isVariableDeclarator()) {
              const init = binding.path.get('init');
              if (init.isExpression()) result = { value: lowerStyleExpression(init, module.parsed, {
                resolveImport: (specifier, imported) => {
                  const target = module.imports.get(specifier); return target ? resolveExport(target, imported) : undefined;
                },
              }), origin: `${id}#${localName}` };
            } else if (binding?.path.isImportSpecifier() && binding.path.parentPath?.isImportDeclaration()) {
              const target = module.imports.get(binding.path.parentPath.node.source.value);
              const imported = binding.path.node.imported;
              const resolved = target ? resolveExportRecord(target, imported.type === 'Identifier' ? imported.name : imported.value) : undefined;
              if (resolved) result = resolved;
            }
          }
        }
      }

      // `export *` contributes only when this module has no explicit export of
      // the requested name. ESM excludes `default` from star exports.
      if (!result && name !== 'default') {
        const candidates: ResolvedExport[] = [];
        for (const statement of module.parsed.program.get('body')) {
          if (!statement.isExportAllDeclaration()) continue;
          const target = module.imports.get(statement.node.source.value);
          const resolved = target ? resolveExportRecord(target, name) : undefined;
          if (resolved && !candidates.some((candidate) => candidate.origin === resolved.origin)) candidates.push(resolved);
        }
        if (candidates.length > 1) {
          throw new NativeStyleError({ code: 'QS1102',
            message: `Ambiguous .qstyle export ${name} in ${module.key}.` });
        }
        result = candidates[0];
      }
      if (result && cycleEpoch === exportCycleEpoch) {
        exported.set(cacheKey, result.value);
        exportOrigins.set(cacheKey, result.origin);
      }
      return result;
    } finally {
      exporting.delete(cacheKey);
    }
  };
  const resolveExport = (id: string, name: string): StyleExpression => {
    const result = resolveExportRecord(id, name);
    if (!result) {
      const module = modules.get(id);
      throw new NativeStyleError({ code: 'QS1102', message: `Unknown .qstyle export ${name} in ${module?.key ?? id}.` });
    }
    return result.value;
  };
  const analyses = new Map<string, AnalyzedStyleModule>();
  for (const module of [...modules.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    if (!SOURCE.test(module.id)) continue;
    analyses.set(module.id, analyzeStyleModule(module.code, module.key, { utilities: !!options.utilities, resolveImport: (specifier, imported) => {
      const target = module.imports.get(specifier); return target ? resolveExport(target, imported) : undefined;
    } }));
  }
  let foundation: readonly UtilityCssNode[] = [];
  if (options.utilities) {
    const result = await options.utilities.resolve([...analyses.values()].flatMap(utilityRequests));
    if (new Set(result.states.map((state) => state.id)).size !== result.states.length) {
      throw new NativeStyleError({ code: 'QS1401', message: 'Duplicate resolved utility state identities.' });
    }
    const states = new Map(result.states.map((state) => [state.id, state]));
    for (const [id, analysis] of analyses) analyses.set(id, composeUtilityStates(analysis, states));
    foundation = result.foundation;
  }
  let foundationDemand: string | undefined;
  if (options.utilities && (foundation.length || options.development)) {
    if (foundation.some((node) => node.kind === 'local')) throw new NativeStyleError({ code: 'QS1101', message: 'Utility foundation cannot contain local subjects.' });
    const heads = new Map<string, { id: string; analysis: AnalyzedStyleModule }>();
    const resolving = new Set<string>();
    const resolvedHeads = new Map<string, { id: string; analysis: AnalyzedStyleModule } | null>();
    const findHead = (id: string, exported = 'default'): { id: string; analysis: AnalyzedStyleModule } | undefined => {
      const key = JSON.stringify([id, exported]);
      if (resolvedHeads.has(key)) return resolvedHeads.get(key) ?? undefined;
      if (resolving.has(key)) return;
      resolving.add(key);
      const analysis = analyses.get(id);
      const source = modules.get(id);
      let target: { id: string; analysis: AnalyzedStyleModule } | undefined;
      if (source) {
        const entry = resolveDocumentEntry(analysis?.module ?? source.parsed, exported);
        if (entry?.kind === 'reference') {
          const targetId = source.imports.get(entry.source);
          if (targetId) target = findHead(targetId, entry.imported);
        } else if (entry?.kind === 'head') {
          if (!analysis) throw new NativeStyleError({ code: 'QS1401', message: `Document root ${source.key} must be available to the TSX source transform.` });
          target = { id, analysis: attachUtilityFoundation(analysis, entry.opening) };
        }
      }
      resolving.delete(key);
      resolvedHeads.set(key, target ?? null);
      return target;
    };
    const unresolvedEntries: string[] = [];
    for (const id of entryIds) {
      const target = findHead(id);
      if (target) heads.set(`${target.id}:${target.analysis.foundation!.opening.node.start}`, target);
      else unresolvedEntries.push(sourceModuleKey(options.root, id));
    }
    if (foundation.length && unresolvedEntries.length) throw new NativeStyleError({ code: 'QS1103',
      message: `Cannot prove a document head from Qwik application entries: ${unresolvedEntries.join(', ')}. Return the document root directly, or pass it directly to the public Qwik renderToString/renderToStream API or Router createRenderer callback.` });
    if (heads.size > 1) throw new NativeStyleError({ code: 'QS1103', message: 'Utility foundation requires one document head across application render entries.' });
    for (const { id, analysis } of heads.values()) {
      analyses.set(id, analysis); foundationDemand = analysis.foundation!.demandId;
    }
    if (foundation.length && !foundationDemand) throw new NativeStyleError({ code: 'QS1103',
      message: 'Cannot prove a document head from the Qwik application entries. Return the document root directly, or pass it directly to the public Qwik renderToString/renderToStream API or Router createRenderer callback.' });
  }
  const identities = new NativeIdentityRegistry();
  const globals = new Map<string, { css: string; demands: Set<string>; devSites: Set<string> }>();
  const fontEdges = new Map<string, readonly [string, string]>();
  const recordFontOrder = (payloads: ReturnType<typeof resolveStyleGlobals>['globals']): void => {
    const fonts = payloads.filter((payload) => payload.kind === 'font-face');
    for (let index = 1; index < fonts.length; index++) {
      const edge = [fonts[index - 1]!.id, fonts[index]!.id] as const;
      fontEdges.set(JSON.stringify(edge), edge);
    }
  };
  const foundationGlobals = foundation.flatMap((node) => node.kind === 'global' ? [{ ...node.value, wrappers: node.wrappers }] : []);
  const resolvedFoundation = resolveStyleGlobals(foundation.flatMap((node) => node.kind === 'global-rule' ? [node.rule] : []), foundationGlobals, identities);
  recordFontOrder(resolvedFoundation.globals);
  const foundationIds = new Set(resolvedFoundation.globals.map((global) => global.id));
  const fixedStates: StyleProgramState[] = [];
  if (foundationDemand) {
    fixedStates.push({ id: foundationDemand, rules: resolvedFoundation.rules,
      demand: { id: foundationDemand, owner: foundationDemand, renderPath: foundationDemand,
        styleState: 'foundation', lazyBoundary: foundationDemand, predicate: 'render(head)' } });
    for (const [index, payload] of resolvedFoundation.globals.entries()) globals.set(payload.id,
      { css: payload.css, demands: new Set([foundationDemand]), devSites: new Set([`${foundationDemand}/global:${index}`]) });
  }
  const states = [...analyses.values()].flatMap((analysis) => analysis.sites.flatMap((site) => {
    const { plan } = site;
    return (
    plan.states.map((state, index) => {
      const auxiliary = utilityAuxiliaryNodes(site, index);
      if (auxiliary.some((node) => node.kind === 'layer-order')) throw new NativeStyleError({ code: 'QS1101', message: 'Layer order must be established by the utility foundation.' });
      const fixed = auxiliary.flatMap((node) => node.kind === 'global-rule' ? [node.rule] : []);
      const resolved = resolveStyleGlobals([...state.rules, ...fixed], [...foundationGlobals, ...plan.alternatives[index]!.globals], identities);
      recordFontOrder(resolved.globals);
      for (const [globalIndex, payload] of resolved.globals.entries()) {
        if (foundationIds.has(payload.id)) continue;
        const existing = globals.get(payload.id);
        if (existing && existing.css !== payload.css) throw new NativeStyleError({ code: 'QS1301',
          message: `Global ${payload.id} has conflicting serialized content.` });
        const record = existing ?? { css: payload.css, demands: new Set<string>(), devSites: new Set<string>() };
        record.devSites.add(`${state.demand.id}/global:${globalIndex}`);
        record.demands.add(state.demand.id); globals.set(payload.id, record);
      }
      if (fixed.length) fixedStates.push({ ...state, rules: resolved.rules.slice(state.rules.length) });
      return { ...state, rules: resolved.rules.slice(0, state.rules.length) };
    }));
  }));
  const local = optimizeStyleProgram(states, undefined, identities, options.development);
  const fixed = optimizeFixedStyleProgram(fixedStates, identities);
  const globalDegrees = new Map([...globals.keys()].map((id) => [id, 0]));
  const globalOutgoing = new Map<string, string[]>();
  const globalDemandKey = (id: string): string => JSON.stringify([...globals.get(id)!.demands].sort());
  for (const [before, after] of fontEdges.values()) {
    if (!foundationIds.has(before) && globalDemandKey(before) !== globalDemandKey(after)) {
      throw new NativeStyleError({ code: 'QS1601', message: 'Font face order crosses independently loaded render demands.' });
    }
    globalDegrees.set(after, globalDegrees.get(after)! + 1);
    globalOutgoing.set(before, [...(globalOutgoing.get(before) ?? []), after]);
  }
  const insertionOrder = new Map([...globals.keys()].map((id, index) => [id, index]));
  const readyGlobals = [...globalDegrees].filter(([, degree]) => degree === 0).map(([id]) => id);
  const globalOrder: string[] = [];
  while (readyGlobals.length) {
    readyGlobals.sort((a, b) => insertionOrder.get(a)! - insertionOrder.get(b)!);
    const id = readyGlobals.shift()!; globalOrder.push(id);
    for (const next of globalOutgoing.get(id) ?? []) {
      globalDegrees.set(next, globalDegrees.get(next)! - 1);
      if (globalDegrees.get(next) === 0) readyGlobals.push(next);
    }
  }
  if (globalOrder.length !== globals.size) throw new NativeStyleError({ code: 'QS1601', message: 'Font faces have contradictory source order.' });
  const globalGroups = new Map<string, string[]>();
  for (const id of globalOrder) {
    const key = globalDemandKey(id);
    globalGroups.set(key, [...(globalGroups.get(key) ?? []), id]);
  }
  const globalPacks: NativeStylePack[] = [...globalGroups].map(([key, ids]) => {
    const css = ids.map((id) => globals.get(id)!.css).join('');
    return { id: identities.identify('pack', JSON.stringify([css, ids])), declarationIds: [], globalIds: ids,
      demandIds: [...globals.get(ids[0]!)!.demands].sort(), devKey: JSON.stringify(['global', key]), css, cssBytes: Buffer.byteLength(css) };
  });
  const packsByDemand = new Map<string, readonly string[]>();
  const layerOrder = foundation.filter((node) => node.kind === 'layer-order').map((node) =>
    wrapNativeCss(`@layer ${node.names.join(',')};`, node.wrappers ?? [])).join('');
  const orderPacks: NativeStylePack[] = layerOrder && foundationDemand ? [{
    id: identities.identify('pack', JSON.stringify([layerOrder, []])), declarationIds: [],
    demandIds: [foundationDemand], devKey: 'utility-layer-order', css: layerOrder, cssBytes: Buffer.byteLength(layerOrder),
  }] : [];
  const localPacks = options.development
    ? [...local.packs].sort((a, b) => JSON.stringify(a.demandIds).localeCompare(JSON.stringify(b.demandIds)))
    : local.packs;
  for (const state of [...fixedStates, ...states]) packsByDemand.set(state.demand.id, [
    ...orderPacks.filter((pack) => pack.demandIds.includes(state.demand.id)).map((pack) => pack.id),
    ...globalPacks.filter((pack) => pack.demandIds.includes(state.demand.id)).map((pack) => pack.id),
    ...fixed.packs.filter((pack) => pack.demandIds.includes(state.demand.id)).map((pack) => pack.id),
    ...localPacks.filter((pack) => pack.demandIds.includes(state.demand.id)).map((pack) => pack.id),
  ]);
  let packs = [...orderPacks, ...globalPacks, ...fixed.packs, ...local.packs];
  // Root layer order, preflight declarations and eager globals are one ordered
  // native owner; Qwik must not reorder independently extracted root styles.
  if (foundationDemand) {
    const rootPacks = packs.filter((pack) => pack.demandIds.includes(foundationDemand));
    const css = rootPacks.map((pack) => pack.css).join('');
    const globalIds = [...new Set(rootPacks.flatMap((pack) => pack.globalIds ?? []))].sort();
    const rootPack: NativeStylePack = {
      id: identities.identify('pack', JSON.stringify([css, globalIds])), css, cssBytes: Buffer.byteLength(css),
      devKey: 'foundation', declarationIds: rootPacks.flatMap((pack) => pack.declarationIds), globalIds,
      demandIds: [...new Set([foundationDemand, ...rootPacks.flatMap((pack) => pack.demandIds)])].sort(),
    };
    const rootIds = new Set(rootPacks.map((pack) => pack.id));
    packs = [rootPack, ...packs.filter((pack) => !rootIds.has(pack.id))];
    for (const [demand, ids] of packsByDemand) packsByDemand.set(demand,
      [...new Set(ids.map((id) => rootIds.has(id) ? rootPack.id : id))]);
    packsByDemand.set(foundationDemand, [rootPack.id]);
  }
  const program: OptimizedStyleProgram = { ...local, fixedDeclarations: fixed.declarations, packs, packsByDemand };
  const digest = sourceDigest(JSON.stringify([
    [...modules.values()].sort((a, b) => a.key.localeCompare(b.key))
      .map((module) => [module.key, module.digest, [...module.imports].map(([source, id]) => [source, sourceModuleKey(options.root, id)])]),
    packs.map((pack) => pack.id),
  ]));
  return { generation, digest, modules, reverseDependencies: reverse, analyses, program,
    unmanagedStylesheets: [...unmanaged].sort() };
}

export function transformGraphModule(
  graph: FrozenStyleGraph, id: string, code: string,
  options: Parameters<typeof emitStyleModule>[2] = {},
): ReturnType<typeof emitStyleModule> | undefined {
  const analysis = graph.analyses.get(id);
  if (!analysis) {
    if (code.includes('@qstyle/qwik') || /\bcss\s*=/.test(code)) throw new NativeStyleError({ code: 'QS1401', message: `New styled source ${id} appeared after graph freeze.` });
    return;
  }
  if (analysis.module.code !== code) throw new NativeStyleError({ code: 'QS1401', message: `Source ${id} changed after style graph freeze.` });
  if (!analysis.sites.length && !analysis.macros.length && !analysis.foundation) return;
  return emitStyleModule(analysis, graph.program, options);
}

export function affectedStyleModules(graph: FrozenStyleGraph, changed: readonly string[]): ReadonlySet<string> {
  const affected = new Set(changed);
  const queue = [...changed];
  for (let i = 0; i < queue.length; i++) {
    for (const parent of graph.reverseDependencies.get(queue[i]!) ?? []) {
      if (!affected.has(parent)) { affected.add(parent); queue.push(parent); }
    }
  }
  return affected;
}
