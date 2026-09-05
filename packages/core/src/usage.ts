/**
 * Usage graph (plan.md Part VIII: style -> components -> routes / lazy boundaries)。
 * chunk planning の第一段階 grouping (§38) と第二段階 clustering (§39) の入力になる。
 */

/** style -> components -> routes / lazy-boundaries の 3 段 graph。id はすべて string。 */
export interface UsageGraph {
  readonly styleToComponents: Map<string, Set<string>>;
  readonly componentToRoutes: Map<string, Set<string>>;
  readonly componentToLazyBoundaries: Map<string, Set<string>>;
  /** style -> provenance source (module path 等)。dedup atom の全 origins 保持用 (§58)。 */
  readonly styleToSources: Map<string, Set<string>>;
}

/** 空の usage graph を生成する。 */
export function createUsageGraph(): UsageGraph {
  return {
    styleToComponents: new Map<string, Set<string>>(),
    componentToRoutes: new Map<string, Set<string>>(),
    componentToLazyBoundaries: new Map<string, Set<string>>(),
    styleToSources: new Map<string, Set<string>>(),
  };
}

/** styleId が componentId で使われることを記録する (冪等)。 */
export function recordUsage(graph: UsageGraph, styleId: string, componentId: string): void {
  let components: Set<string> | undefined = graph.styleToComponents.get(styleId);
  if (components === undefined) {
    components = new Set<string>();
    graph.styleToComponents.set(styleId, components);
  }
  components.add(componentId);
}

/** styleId の provenance source (module path 等) を記録する (冪等、sorted 解決用)。 */
export function recordSource(graph: UsageGraph, styleId: string, source: string): void {
  let sources: Set<string> | undefined = graph.styleToSources.get(styleId);
  if (sources === undefined) {
    sources = new Set<string>();
    graph.styleToSources.set(styleId, sources);
  }
  sources.add(source);
}

/** componentId が routeId で描画されることを記録する (冪等)。 */
export function recordComponentRoute(graph: UsageGraph, componentId: string, routeId: string): void {
  let routes: Set<string> | undefined = graph.componentToRoutes.get(componentId);
  if (routes === undefined) {
    routes = new Set<string>();
    graph.componentToRoutes.set(componentId, routes);
  }
  routes.add(routeId);
}

/** componentId が boundaryId (lazy boundary) 配下にあることを記録する (冪等)。 */
export function recordComponentBoundary(
  graph: UsageGraph,
  componentId: string,
  boundaryId: string,
): void {
  let boundaries: Set<string> | undefined = graph.componentToLazyBoundaries.get(componentId);
  if (boundaries === undefined) {
    boundaries = new Set<string>();
    graph.componentToLazyBoundaries.set(componentId, boundaries);
  }
  boundaries.add(boundaryId);
}

/** styleId を使う component id の sorted list。未知なら空配列。 */
export function usageSignature(graph: UsageGraph, styleId: string): readonly string[] {
  return sortedOf(graph.styleToComponents.get(styleId) ?? []);
}

/** styleId の provenance source の sorted list。未知なら空配列。 */
export function sourceSignature(graph: UsageGraph, styleId: string): readonly string[] {
  return sortedOf(graph.styleToSources.get(styleId) ?? []);
}

/** styleId を使う全 component の route の sorted union。未知 / route 未記録なら空配列。 */
export function routeSignature(graph: UsageGraph, styleId: string): readonly string[] {
  const components: ReadonlySet<string> | undefined = graph.styleToComponents.get(styleId);
  if (components === undefined) return [];
  const routes: Set<string> = new Set<string>();
  for (const componentId of components) {
    for (const routeId of graph.componentToRoutes.get(componentId) ?? []) {
      routes.add(routeId);
    }
  }
  return sortedOf(routes);
}

/**
 * usage signature 完全一致 (§38) で style を group 化する。
 * key は usageSignature の JSON、value は sorted style id。
 * usage を持たない style は含めない。
 */
export function groupByUsageSignature(graph: UsageGraph): Map<string, readonly string[]> {
  const groups: Map<string, readonly string[]> = new Map<string, readonly string[]>();
  for (const styleId of sortedOf(graph.styleToComponents.keys())) {
    const signature: readonly string[] = usageSignature(graph, styleId);
    if (signature.length === 0) continue;
    const key: string = JSON.stringify(signature);
    const members: readonly string[] | undefined = groups.get(key);
    groups.set(key, members === undefined ? [styleId] : [...members, styleId]);
  }
  return groups;
}

/** |A ∩ B| / |A ∪ B|。両方空なら 1、片方空なら 0。 */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection: number = 0;
  for (const value of a) {
    if (b.has(value)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

function sortedOf(values: Iterable<string>): readonly string[] {
  return [...values].sort();
}
