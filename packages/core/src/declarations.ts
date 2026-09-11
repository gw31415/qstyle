import { canonicalDeclaration } from './canonical.js';
import { NativeIdentityRegistry } from './identity.js';
import { NativeStyleError } from './native-diagnostic.js';
import type { DeclarationDefinition, DemandSite, SourceSpan } from './native-ir.js';
import { serializeDeclarationDefinition } from './serialize.js';

export interface RegisteredDeclaration {
  readonly id: string;
  readonly definition: DeclarationDefinition;
  readonly demands: readonly DemandSite[];
  readonly sources: readonly SourceSpan[];
}

function immutableCopy<T>(value: T): T {
  const clone: T = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== 'object' || Object.isFrozen(entry)) return;
    for (const child of Object.values(entry)) freeze(child);
    Object.freeze(entry);
  };
  freeze(clone);
  return clone;
}

/** Site-wide table. No source-local registry or owner-specific declaration identity. */
export class DeclarationDictionary {
  readonly identities: NativeIdentityRegistry;
  private readonly records: Map<string, {
    definition: DeclarationDefinition; demands: Map<string, DemandSite>; sources: SourceSpan[];
  }> = new Map();
  private readonly sites: Map<string, string> = new Map();

  constructor(identities: NativeIdentityRegistry = new NativeIdentityRegistry()) {
    this.identities = identities;
  }

  add(definition: DeclarationDefinition, demand: DemandSite, source?: SourceSpan): string {
    const demandPayload = JSON.stringify([demand.owner, demand.renderPath, demand.styleState, demand.lazyBoundary, demand.predicate]);
    const existingSite = this.sites.get(demand.id);
    if (existingSite !== undefined && existingSite !== demandPayload) {
      throw new NativeStyleError({ code: 'QS1401', message: `Demand site ${demand.id} has inconsistent render predicates.` });
    }
    this.sites.set(demand.id, demandPayload);
    const id = this.identities.identify('declaration', canonicalDeclaration(definition), source);
    let record = this.records.get(id);
    if (!record) {
      record = { definition: immutableCopy(definition), demands: new Map(), sources: [] };
      this.records.set(id, record);
    } else {
      // Dependencies describe delivery, not different meanings for identical CSS.
      record.definition = immutableCopy({ ...record.definition,
        dependencies: [...new Set([...record.definition.dependencies, ...definition.dependencies])].sort() });
    }
    record.demands.set(demand.id, immutableCopy(demand));
    if (source && !record.sources.some((s) => s.file === source.file && s.start === source.start && s.end === source.end)) {
      record.sources.push(immutableCopy(source));
    }
    return id;
  }

  entries(): readonly RegisteredDeclaration[] {
    return [...this.records].sort(([a], [b]) => a.localeCompare(b)).map(([id, record]) => ({
      id, definition: record.definition,
      demands: [...record.demands.values()].sort((a, b) => a.id.localeCompare(b.id)),
      sources: [...record.sources].sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start),
    }));
  }
}

export interface NativeStylePack {
  readonly id: string;
  readonly declarationIds: readonly string[];
  readonly globalIds?: readonly string[];
  readonly devKey?: string;
  readonly demandIds: readonly string[];
  readonly css: string;
  readonly cssBytes: number;
}

/**
 * Share only declarations with identical render demand. The supplied total order must
 * already be proved safe by the cascade verifier; grouping never reorders across packs.
 */
export function createNativePacks(
  dictionary: DeclarationDictionary,
  classesByDeclaration: ReadonlyMap<string, readonly string[]>,
  order: readonly string[],
  orderEdges: readonly (readonly [string, string])[] = [],
): readonly NativeStylePack[] {
  const records = dictionary.entries();
  const ids = new Set(records.map((record) => record.id));
  if (order.length !== ids.size || new Set(order).size !== order.length || order.some((id) => !ids.has(id))) {
    throw new NativeStyleError({ code: 'QS1601', message: 'Pack order must contain every declaration exactly once.' });
  }
  const positions = new Map(order.map((id, index) => [id, index]));
  const byId = new Map(records.map((record) => [record.id, record]));
  const demandKey = (record: RegisteredDeclaration): string => JSON.stringify(record.demands.map((demand) => demand.id));
  for (const [before, after] of orderEdges) {
    const a = byId.get(before); const b = byId.get(after);
    if (!a || !b || positions.get(before)! >= positions.get(after)!) {
      throw new NativeStyleError({ code: 'QS1601', message: 'Pack order violates a declaration dependency.' });
    }
    if (demandKey(a) !== demandKey(b)) {
      throw new NativeStyleError({ code: 'QS1601', message: 'A cascade dependency crosses independently loaded style demands.' });
    }
  }
  const groups = new Map<string, RegisteredDeclaration[]>();
  for (const id of order) {
    const record = byId.get(id)!;
    const key = demandKey(record);
    const group = groups.get(key) ?? [];
    group.push(record); groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const css = group.map((record) => {
      const classes = classesByDeclaration.get(record.id);
      const fixed = record.definition.selector.alternatives.length > 0 && record.definition.selector.alternatives.every((parts) => parts.every((part) => part.kind === 'text'));
      if (!classes?.length && !fixed) {
        throw new NativeStyleError({ code: 'QS1601', message: `Declaration ${record.id} has no applying class.` });
      }
      return serializeDeclarationDefinition(record.definition, classes ?? [], dictionary.identities);
    }).join('');
    const dependencies = [...new Set(group.flatMap((record) => record.definition.dependencies))].sort();
    return {
      id: dictionary.identities.identify('pack', JSON.stringify([css, dependencies])),
      declarationIds: group.map((record) => record.id),
      demandIds: group[0]!.demands.map((demand) => demand.id),
      css, cssBytes: Buffer.byteLength(css, 'utf8'),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
