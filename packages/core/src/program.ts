import { solveClassCover, type ClassCoverResourceLimits, type ClassCoverResult, type ClassCoverState } from './class-cover.js';
import { verifyClassCover } from './verify-cover.js';
import { DeclarationDictionary, createNativePacks, type NativeStylePack, type RegisteredDeclaration } from './declarations.js';
import { NativeIdentityRegistry, nativeClassName } from './identity.js';
import type { DeclarationDefinition, DemandSite, NativeStyleRule } from './native-ir.js';
import { NativeStyleError } from './native-diagnostic.js';
import { longhandsOf } from './safety.js';

export interface StyleProgramState {
  readonly id: string;
  readonly demand: DemandSite;
  /** Rules in source/compose order. */
  readonly rules: readonly NativeStyleRule[];
}

export interface OptimizedStyleProgram {
  readonly declarations: readonly RegisteredDeclaration[];
  /** Fixed external selectors are unique declarations, outside generated-class minimization. */
  readonly fixedDeclarations?: readonly RegisteredDeclaration[];
  readonly cover: ClassCoverResult;
  readonly classes: readonly string[];
  readonly classesByState: ReadonlyMap<string, readonly string[]>;
  readonly packs: readonly NativeStylePack[];
  readonly packsByDemand: ReadonlyMap<string, readonly string[]>;
  readonly duplicateDefinitionCount: 0;
  readonly duplicatePayloadCount: 0;
}

/** Fixed selectors retain generator order and use the same unique-payload/demand checks. */
export function optimizeFixedStyleProgram(
  states: readonly StyleProgramState[], identities: NativeIdentityRegistry = new NativeIdentityRegistry(),
): { readonly declarations: readonly RegisteredDeclaration[]; readonly packs: readonly NativeStylePack[] } {
  const dictionary = new DeclarationDictionary(identities);
  const edges = new Map<string, readonly [string, string]>();
  for (const state of states) {
    const ordered: { id: string; property: string }[] = [];
    for (const rule of state.rules) {
      if (!rule.selector.alternatives.length || rule.selector.alternatives.some((parts) => parts.some((part) => part.kind === 'subject'))) {
        throw new NativeStyleError({ code: 'QS1101', message: 'Fixed rules must contain only parsed text selectors.' });
      }
      for (const declaration of rule.declarations) {
        if (declaration.value.kind !== 'static') throw new NativeStyleError({ code: 'QS1102', message: 'Fixed rules cannot contain dynamic slots.' });
        const definition = { selector: rule.selector, wrappers: rule.wrappers, dependencies: rule.dependencies, declaration };
        ordered.push({ id: dictionary.add(definition, state.demand, rule.source), property: declaration.property });
      }
    }
    for (let after = 0; after < ordered.length; after++) for (let before = 0; before < after; before++) {
      const a = ordered[before]!; const b = ordered[after]!;
      if (a.id !== b.id && mayConflict(a.property, b.property)) edges.set(JSON.stringify([a.id, b.id]), [a.id, b.id]);
    }
  }
  const records = dictionary.entries();
  const remaining = new Map(records.map((record) => [record.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const [a, b] of edges.values()) {
    remaining.set(b, remaining.get(b)! + 1);
    outgoing.set(a, [...(outgoing.get(a) ?? []), b]);
  }
  const order: string[] = [];
  const ready = [...remaining].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
  while (ready.length) {
    const id = ready.shift()!; order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      remaining.set(next, remaining.get(next)! - 1);
      if (remaining.get(next) === 0) { ready.push(next); ready.sort(); }
    }
  }
  if (order.length !== records.length) throw new NativeStyleError({ code: 'QS1601', message: 'Fixed declarations have contradictory cascade order.' });
  return { declarations: records, packs: createNativePacks(dictionary, new Map(), order, [...edges.values()]).map((pack) => ({
    ...pack, devKey: JSON.stringify(['fixed', ...pack.demandIds]),
  })) };
}

function mayConflict(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith('--') || b.startsWith('--')) return false;
  if (a === 'all' || b === 'all') return true;
  const expandedA = longhandsOf(a);
  const expandedB = longhandsOf(b);
  const left = new Set(expandedA.length ? expandedA : [a]);
  return (expandedB.length ? expandedB : [b]).some((property) => left.has(property));
}

/**
 * Whole-graph optimization; this never processes each route in isolation.
 * Unproven cascade ordering is retained conservatively and rejected if it
 * cannot coexist with unique payloads and exact render-demand partitioning.
 */
export function optimizeStyleProgram(
  states: readonly StyleProgramState[],
  limits?: ClassCoverResourceLimits,
  identities: NativeIdentityRegistry = new NativeIdentityRegistry(),
  development = false,
): OptimizedStyleProgram {
  const dictionary = new DeclarationDictionary(identities);
  const coverStates: ClassCoverState[] = [];
  const allEdges = new Map<string, readonly [string, string]>();
  for (const state of states) {
    const ordered: { id: string; definition: DeclarationDefinition }[] = [];
    for (const rule of state.rules) {
      for (const declaration of rule.declarations) {
        const definition: DeclarationDefinition = {
          selector: rule.selector, wrappers: rule.wrappers, declaration, dependencies: rule.dependencies,
        };
        ordered.push({ id: dictionary.add(definition, state.demand, rule.source), definition });
      }
    }
    const edges = new Map<string, readonly [string, string]>();
    for (let later = 0; later < ordered.length; later++) {
      for (let earlier = 0; earlier < later; earlier++) {
        const a = ordered[earlier]!; const b = ordered[later]!;
        if (a.id !== b.id && mayConflict(a.definition.declaration.property, b.definition.declaration.property)) {
          const edge = [a.id, b.id] as const;
          edges.set(JSON.stringify(edge), edge);
          allEdges.set(JSON.stringify(edge), edge);
        }
      }
    }
    coverStates.push({ id: state.id, declarations: [...new Set(ordered.map(({ id }) => id))], order: [...edges.values()] });
  }
  const cover = solveClassCover(coverStates, limits);
  const verified = verifyClassCover(coverStates, cover);
  if (!verified.ok) {
    throw new NativeStyleError({ code: 'QS1601', message: `Class cover failed independent verification: ${verified.errors.join('; ')}` });
  }
  const memberships = new Map<string, number>();
  const classes = cover.basis.map((basis, index) => {
    if (!development) return nativeClassName(basis, identities);
    // CSS-only edits must continue matching the existing resumed DOM. Production
    // remains content-addressed; development identifies a class by its consumers.
    const sites = [...cover.assignments].filter(([, assigned]) => assigned.includes(index))
      .map(([id]) => id).sort();
    const membership = JSON.stringify(sites);
    const ordinal = memberships.get(membership) ?? 0;
    memberships.set(membership, ordinal + 1);
    return `q1_${identities.identify('class', JSON.stringify(['dev', sites, ordinal]))}`;
  });
  const classesByState = new Map<string, readonly string[]>();
  const classesByDeclaration = new Map<string, string[]>();
  for (const [stateId, assignments] of cover.assignments) {
    classesByState.set(stateId, assignments.map((index) => classes[index]!));
  }
  for (let index = 0; index < cover.basis.length; index++) {
    for (const declaration of cover.basis[index]!) {
      const applyingClasses = classesByDeclaration.get(declaration) ?? [];
      applyingClasses.push(classes[index]!);
      classesByDeclaration.set(declaration, applyingClasses);
    }
  }
  const packs = createNativePacks(dictionary, classesByDeclaration, cover.globalOrder, [...allEdges.values()]);
  const packsByDemand = new Map<string, string[]>();
  for (const state of states) packsByDemand.set(state.demand.id, []);
  const emittedIds = new Set<string>();
  for (const pack of packs) {
    for (const declaration of pack.declarationIds) {
      if (emittedIds.has(declaration)) {
        throw new NativeStyleError({ code: 'QS1601', message: `Declaration ${declaration} is repeated in independent pack payloads.` });
      }
      emittedIds.add(declaration);
    }
    for (const demand of pack.demandIds) packsByDemand.get(demand)!.push(pack.id);
  }
  return {
    declarations: dictionary.entries(), cover, classes, classesByState, packs, packsByDemand,
    duplicateDefinitionCount: 0, duplicatePayloadCount: 0,
  };
}
