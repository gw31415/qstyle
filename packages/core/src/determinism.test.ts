import { describe, expect, it } from 'vitest';
import {
  VERSION,
  assetFileName,
  buildRouteManifest,
  chunkHash,
  createStaticAtom,
  createUsageGraph,
  hashStaticAtom,
  parseManifest,
  planChunks,
  recordUsage,
  serializeManifest,
} from './index.js';
import type {
  ChunkInput,
  ChunkOptions,
  ChunkPlan,
  StaticAtom,
  StyleManifest,
  UsageGraph,
} from './index.js';

interface StyleSpec {
  readonly id: string;
  readonly property: string;
  readonly value: string;
  readonly bytes: number;
  readonly components: readonly string[];
}

const STYLE_SPECS: readonly StyleSpec[] = [
  { id: 'btn-bg', property: 'background-color', value: '#ff0000', bytes: 120, components: ['Button'] },
  { id: 'btn-padding', property: 'padding', value: '4px 8px', bytes: 96, components: ['Button'] },
  { id: 'card-border', property: 'border-width', value: '1px', bytes: 140, components: ['Card'] },
  { id: 'card-shadow', property: 'box-shadow', value: '0 1px 2px rgba(0, 0, 0, 0.2)', bytes: 210, components: ['Card'] },
  { id: 'shared-color', property: 'color', value: 'red', bytes: 40, components: ['Button', 'Card'] },
  { id: 'card-opacity', property: 'opacity', value: '0.8', bytes: 64, components: ['Card'] },
];

const CHUNK_OPTS: ChunkOptions = { minChunkBytes: 0, maxChunkBytes: 4096 };

const ROUTE_OF_COMPONENT: ReadonlyMap<string, string> = new Map<string, string>([
  ['Button', '/'],
  ['Card', '/card'],
]);

const SHUFFLE_SEEDS: readonly number[] = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

const naturalOrder: readonly string[] = STYLE_SPECS.map((spec: StyleSpec): string => spec.id);

function specOf(id: string): StyleSpec {
  const spec: StyleSpec | undefined = STYLE_SPECS.find((candidate: StyleSpec): boolean => candidate.id === id);
  if (spec === undefined) throw new Error(`unknown style id: ${id}`);
  return spec;
}

function atomFor(id: string): StaticAtom {
  const spec: StyleSpec = specOf(id);
  return createStaticAtom({
    property: spec.property,
    value: spec.value,
    provenance: [{ source: `/repo/src/${id}.tsx`, line: 1, column: 1 }],
  });
}

function graphFor(traversalOrder: readonly string[]): UsageGraph {
  const graph: UsageGraph = createUsageGraph();
  for (const id of traversalOrder) {
    for (const component of specOf(id).components) recordUsage(graph, id, component);
  }
  return graph;
}

function stylesFor(traversalOrder: readonly string[]): readonly ChunkInput[] {
  return traversalOrder.map((id: string): ChunkInput => ({ id, bytes: specOf(id).bytes }));
}

function serializePlanCss(plan: ChunkPlan, atoms: ReadonlyMap<string, StaticAtom>): string {
  const declarations: string[] = [];
  for (const member of plan.members) {
    const atom: StaticAtom | undefined = atoms.get(member);
    if (atom === undefined) continue;
    declarations.push(`.${member}{${atom.property}:${atom.value}}`);
  }
  return declarations.join('');
}

function routesRequiring(plan: ChunkPlan): readonly string[] {
  const routes: Set<string> = new Set<string>();
  for (const member of plan.members) {
    for (const component of specOf(member).components) {
      const route: string | undefined = ROUTE_OF_COMPONENT.get(component);
      if (route !== undefined) routes.add(route);
    }
  }
  return [...routes].sort();
}

interface ProjectBuild {
  readonly semanticHashes: readonly string[];
  readonly plans: readonly ChunkPlan[];
  readonly manifestText: string;
}

function buildProject(traversalOrder: readonly string[]): ProjectBuild {
  const graph: UsageGraph = graphFor(traversalOrder);
  const atoms: Map<string, StaticAtom> = new Map<string, StaticAtom>();
  const hashes: string[] = [];
  for (const id of traversalOrder) {
    const atom: StaticAtom = atomFor(id);
    atoms.set(id, atom);
    hashes.push(hashStaticAtom(atom));
  }
  const plans: readonly ChunkPlan[] = planChunks(graph, stylesFor(traversalOrder), CHUNK_OPTS);
  const routes: Map<string, string[]> = new Map<string, string[]>();
  for (const plan of plans) {
    const asset: string = assetFileName('chunk', chunkHash(serializePlanCss(plan, atoms)));
    for (const route of routesRequiring(plan)) {
      const assets: string[] | undefined = routes.get(route);
      if (assets === undefined) routes.set(route, [asset]);
      else assets.push(asset);
    }
  }
  const manifest: StyleManifest = buildRouteManifest(routes, { compilerVersion: VERSION });
  return { semanticHashes: hashes, plans, manifestText: serializeManifest(manifest) };
}

function lcgRandom(seed: number): () => number {
  let state: number = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function fisherYatesShuffle<T>(input: readonly T[], seed: number): readonly T[] {
  const random: () => number = lcgRandom(seed);
  const result: T[] = [...input];
  for (let i: number = result.length - 1; i > 0; i -= 1) {
    const j: number = Math.floor(random() * (i + 1));
    const tmp: T = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }
  return result;
}

function sortedHashes(hashes: readonly string[]): readonly string[] {
  return [...hashes].sort();
}

describe('Milestone 11 determinism gates (plan.md §75, core-verifiable subset)', () => {
  it('HASH-001: two clean builds of the same input are byte-for-byte identical', () => {
    const first: ProjectBuild = buildProject(naturalOrder);
    const second: ProjectBuild = buildProject(naturalOrder);
    expect(serializeManifest(parseManifest(first.manifestText) as StyleManifest)).toBe(first.manifestText);
    expect(second.manifestText).toBe(first.manifestText);
    expect(second.semanticHashes).toEqual(first.semanticHashes);
    expect(second.plans).toEqual(first.plans);
  });

  it('HASH-002: shuffled source traversal keeps the semantic hash set and chunk plan identical', () => {
    const orders: readonly string[] = SHUFFLE_SEEDS.map(
      (seed: number): string => fisherYatesShuffle(naturalOrder, seed).join('|'),
    );
    expect(new Set<string>(orders).size).toBe(SHUFFLE_SEEDS.length);
    expect(orders).not.toContain(naturalOrder.join('|'));
    const baseline: ProjectBuild = buildProject(naturalOrder);
    for (const seed of SHUFFLE_SEEDS) {
      const build: ProjectBuild = buildProject(fisherYatesShuffle(naturalOrder, seed));
      expect(sortedHashes(build.semanticHashes)).toEqual(sortedHashes(baseline.semanticHashes));
      expect(build.plans).toEqual(baseline.plans);
    }
  });

  it('HASH-003: input-order-only difference yields the identical chunk plan id set', () => {
    const baselineIds: readonly string[] = planChunks(
      graphFor(naturalOrder),
      stylesFor(naturalOrder),
      CHUNK_OPTS,
    )
      .map((plan: ChunkPlan): string => plan.id)
      .sort();
    for (const seed of SHUFFLE_SEEDS) {
      const order: readonly string[] = fisherYatesShuffle(naturalOrder, seed);
      const ids: readonly string[] = planChunks(graphFor(order), stylesFor(order), CHUNK_OPTS)
        .map((plan: ChunkPlan): string => plan.id)
        .sort();
      expect(ids).toEqual(baselineIds);
    }
    const reversed: readonly string[] = [...naturalOrder].reverse();
    expect(
      planChunks(graphFor(reversed), stylesFor(reversed), CHUNK_OPTS)
        .map((plan: ChunkPlan): string => plan.id)
        .sort(),
    ).toEqual(baselineIds);
  });

  it('HASH-004: semantic identity never contains absolute paths', () => {
    const inA: StaticAtom = createStaticAtom({
      property: 'color',
      value: 'red',
      provenance: [{ source: '/a/x.tsx', line: 3, column: 7 }],
    });
    const inB: StaticAtom = createStaticAtom({
      property: 'color',
      value: 'red',
      provenance: [{ source: '/b/x.tsx', line: 30, column: 77 }],
    });
    const inWindows: StaticAtom = createStaticAtom({
      property: 'color',
      value: 'red',
      provenance: [{ source: 'C:\\repo\\x.tsx', line: 1, column: 1 }],
    });
    expect(hashStaticAtom(inB)).toBe(hashStaticAtom(inA));
    expect(hashStaticAtom(inWindows)).toBe(hashStaticAtom(inA));
  });

  it('HASH-005: whitespace-only differences around the value do not change the atom hash', () => {
    const base: StaticAtom = createStaticAtom({ property: 'margin', value: '4px 8px' });
    const trailing: StaticAtom = createStaticAtom({ property: 'margin', value: '4px 8px  ' });
    const leading: StaticAtom = createStaticAtom({ property: 'margin', value: '  4px 8px' });
    const collapsed: StaticAtom = createStaticAtom({ property: 'margin', value: '4px   8px' });
    const mixed: StaticAtom = createStaticAtom({ property: 'margin', value: '\t4px\n8px\r\n' });
    for (const variant of [trailing, leading, collapsed, mixed]) {
      expect(hashStaticAtom(variant)).toBe(hashStaticAtom(base));
    }
    expect(hashStaticAtom(createStaticAtom({ property: 'margin', value: '4px 16px' }))).not.toBe(
      hashStaticAtom(base),
    );
  });

  it('HASH-006: adding an unrelated atom keeps existing pack members and pack id unchanged', () => {
    const mergeOpts: ChunkOptions = { minChunkBytes: 1024, maxChunkBytes: 4096 };
    const before: readonly ChunkPlan[] = planChunks(
      graphFor(['btn-bg', 'btn-padding']),
      stylesFor(['btn-bg', 'btn-padding']),
      mergeOpts,
    );
    expect(before).toHaveLength(1);
    const basePack: ChunkPlan = before[0]!;

    const withUnrelated: readonly string[] = ['btn-bg', 'btn-padding', 'card-shadow'];
    const after: readonly ChunkPlan[] = planChunks(
      graphFor(withUnrelated),
      stylesFor(withUnrelated),
      mergeOpts,
    );
    const existingPack: ChunkPlan | undefined = after.find((plan: ChunkPlan): boolean =>
      plan.members.includes('btn-bg'),
    );
    expect(existingPack).toBeDefined();
    expect(existingPack!.id).toBe(basePack.id);
    expect(existingPack!.members).toEqual(basePack.members);
    expect(existingPack!.bytes).toBe(basePack.bytes);
    const unrelatedPack: ChunkPlan | undefined = after.find((plan: ChunkPlan): boolean =>
      plan.members.includes('card-shadow'),
    );
    expect(unrelatedPack!.members).toEqual(['card-shadow']);
  });

  it('HASH-011: manifest records the compiler version', () => {
    const routes: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
      ['/', ['base.q_aa.css']],
      ['/card', ['base.q_aa.css', 'card.q_bb.css']],
    ]);
    const manifest: StyleManifest = buildRouteManifest(routes, { compilerVersion: VERSION });
    expect(manifest.compilerVersion).toBe(VERSION);
    expect(manifest.version).toBe(1);
    expect(serializeManifest(manifest)).toContain(`"compilerVersion": "${VERSION}"`);
    expect(parseManifest(serializeManifest(manifest))?.compilerVersion).toBe(VERSION);
  });

  it('HASH-012: any content change changes the content-addressed chunk hash', () => {
    const base: string = '.btn{padding:4px 8px}.card{box-shadow:0 1px 2px #000}';
    const baseline: string = chunkHash(base);
    for (let i: number = 0; i < base.length; i += 1) {
      const original: string = base[i]!;
      const mutated: string = base.slice(0, i) + (original === 'x' ? 'y' : 'x') + base.slice(i + 1);
      expect(chunkHash(mutated), `mutation at index ${i} (${original})`).not.toBe(baseline);
    }
    expect(chunkHash(base.replace('4px 8px', '4px 16px'))).not.toBe(baseline);
    expect(assetFileName('chunk', chunkHash('.shared{color:blue}'))).not.toBe(
      assetFileName('chunk', chunkHash('.shared{color:red}')),
    );
  });
});
