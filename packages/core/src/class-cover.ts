/**
 * Exact finite class-cover solver.
 *
 * The solver works on canonical declaration identities.  A class is a
 * non-empty set of declarations and may be assigned to a state only when the
 * class is a subset of that state's declarations.  The objective is
 * lexicographic: minimize the number of selected classes (K), then the total
 * number of state/class assignments (T).
 *
 * There are no selector-specific constraints in this core model.  Once the
 * union of the per-state order graphs is acyclic, one deterministic global
 * topological order is valid for every state.  That makes the usual
 * intersection-closure reduction complete: any feasible subset can be
 * expanded to the intersection of the states that can accept it (which
 * contains the original subset), without increasing K or T.  The independent
 * verifier and tests keep this proof boundary explicit.
 */

export interface ClassCoverState {
  readonly id: string;
  readonly declarations: readonly string[];
  readonly order?: readonly (readonly [string, string])[];
}

export interface ClassCoverResourceLimits {
  /** Maximum number of unique candidate classes. Defaults to 65,536. */
  readonly maxCandidates?: number;
  /** Maximum number of input states. Defaults to 65,536. */
  readonly maxStates?: number;
  /** Maximum exact-search / verification nodes. Defaults to 10,000,000. */
  readonly maxSearchNodes?: number;
}

export interface ClassCoverObjective {
  readonly K: number;
  readonly T: number;
}

export interface ClassCoverOptimality {
  readonly status: 'optimal';
  readonly lowerBound: ClassCoverObjective;
  readonly upperBound: ClassCoverObjective;
}

export type ClassCoverDiagnosticCode = 'QS1601' | 'QS1602';

export interface ClassCoverDiagnostic {
  readonly code: ClassCoverDiagnosticCode;
  readonly message: string;
  readonly details?: readonly string[];
}

export interface ClassCoverErrorOptions {
  readonly code: ClassCoverDiagnosticCode;
  readonly message: string;
  readonly details?: readonly string[];
  readonly exploredNodes?: number;
  readonly candidateCount?: number;
  readonly lowerBound?: ClassCoverObjective;
  readonly upperBound?: ClassCoverObjective;
}

/** A typed, fail-closed class-cover diagnostic. */
export class ClassCoverError extends Error {
  readonly code: ClassCoverDiagnosticCode;
  readonly diagnostic: ClassCoverDiagnostic;
  readonly exploredNodes: number;
  readonly candidateCount: number;
  readonly lowerBound: ClassCoverObjective | null;
  readonly upperBound: ClassCoverObjective | null;

  constructor(options: ClassCoverErrorOptions) {
    super(options.message);
    this.name = 'ClassCoverError';
    this.code = options.code;
    this.diagnostic =
      options.details === undefined
        ? { code: options.code, message: options.message }
        : { code: options.code, message: options.message, details: options.details };
    this.exploredNodes = options.exploredNodes ?? 0;
    this.candidateCount = options.candidateCount ?? 0;
    this.lowerBound = options.lowerBound ?? null;
    this.upperBound = options.upperBound ?? null;
  }
}

/** The result of an exact solve.  Assignment values are indexes into `basis`. */
export interface ClassCoverResult {
  /** Selected class declaration sets, in canonical order. */
  readonly basis: readonly (readonly string[])[];
  /** Alias for consumers that call the selected basis `classes`. */
  readonly classes: readonly (readonly string[])[];
  /** State id -> indexes of classes assigned to that state. */
  readonly assignments: ReadonlyMap<string, readonly number[]>;
  /** Alias for consumers that use the longer name. */
  readonly perStateAssignments: ReadonlyMap<string, readonly number[]>;
  /** One deterministic topological order for all declarations. */
  readonly globalOrder: readonly string[];
  /** Alias for the topological order. */
  readonly topologicalOrder: readonly string[];
  readonly K: number;
  readonly T: number;
  readonly classCount: number;
  readonly assignmentCount: number;
  readonly lowerBound: ClassCoverObjective;
  readonly upperBound: ClassCoverObjective;
  readonly optimality: ClassCoverOptimality;
  readonly candidateCount: number;
  readonly exploredNodes: number;
}

interface NormalizedState {
  readonly id: string;
  readonly declarations: readonly string[];
  readonly declarationSet: ReadonlySet<string>;
  readonly order: readonly (readonly [string, string])[];
}

interface Candidate {
  readonly declarations: readonly string[];
  readonly key: string;
}

interface RequirementChoice {
  readonly stateIndex: number;
  readonly declaration: string;
  readonly candidates: readonly number[];
}

interface SelectionEvaluation {
  readonly T: number;
  readonly assignments: readonly (readonly number[])[];
}

interface SearchSolution {
  readonly selected: readonly number[];
  readonly evaluation: SelectionEvaluation;
}

const DEFAULT_MAX_CANDIDATES: number = 65_536;
const DEFAULT_MAX_STATES: number = 65_536;
const DEFAULT_MAX_SEARCH_NODES: number = 10_000_000;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareStringArrays(a: readonly string[], b: readonly string[]): number {
  const length: number = Math.min(a.length, b.length);
  for (let index: number = 0; index < length; index += 1) {
    const left: string = a[index]!;
    const right: string = b[index]!;
    const comparison: number = compareStrings(left, right);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function compareNumberArrays(a: readonly number[], b: readonly number[]): number {
  const length: number = Math.min(a.length, b.length);
  for (let index: number = 0; index < length; index += 1) {
    const comparison: number = a[index]! - b[index]!;
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function candidateKey(declarations: readonly string[]): string {
  return JSON.stringify(declarations);
}

function checkedLimit(value: number | undefined, fallback: number, name: string): number {
  const limit: number = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return limit;
}

function resourceError(
  message: string,
  exploredNodes: number,
  candidateCount: number,
  lowerBound?: ClassCoverObjective,
  upperBound?: ClassCoverObjective,
): ClassCoverError {
  const options: ClassCoverErrorOptions = {
    code: 'QS1602',
    message,
    exploredNodes,
    candidateCount,
    ...(lowerBound === undefined ? {} : { lowerBound }),
    ...(upperBound === undefined ? {} : { upperBound }),
  };
  return new ClassCoverError(options);
}

function sortUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareStrings);
}

function normalizeStates(
  states: readonly ClassCoverState[],
  maxStates: number,
): readonly NormalizedState[] {
  if (states.length > maxStates) {
    throw resourceError(
      `class-cover state count ${states.length} exceeds maxStates ${maxStates}`,
      0,
      0,
    );
  }

  const seenIds: Set<string> = new Set<string>();
  const normalized: NormalizedState[] = [];
  for (const state of states) {
    if (seenIds.has(state.id)) {
      throw new TypeError(`class-cover state id must be unique: ${JSON.stringify(state.id)}`);
    }
    seenIds.add(state.id);
    const declarations: readonly string[] = sortUnique(state.declarations);
    const declarationSet: ReadonlySet<string> = new Set<string>(declarations);
    const edges: (readonly [string, string])[] = [];
    const edgeKeys: Set<string> = new Set<string>();
    for (const edge of state.order ?? []) {
      const before: string = edge[0];
      const after: string = edge[1];
      if (!declarationSet.has(before) || !declarationSet.has(after)) {
        throw new ClassCoverError({
          code: 'QS1601',
          message:
            `order edge in state ${JSON.stringify(state.id)} references a declaration ` +
            'outside that state',
          details: [before, after],
        });
      }
      const key: string = JSON.stringify([before, after]);
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        edges.push([before, after]);
      }
    }
    normalized.push({
      id: state.id,
      declarations,
      declarationSet,
      order: edges.sort((a, b) => {
        const first: number = compareStrings(a[0], b[0]);
        return first === 0 ? compareStrings(a[1], b[1]) : first;
      }),
    });
  }

  normalized.sort((a, b) => {
    const idComparison: number = compareStrings(a.id, b.id);
    if (idComparison !== 0) return idComparison;
    return compareStringArrays(a.declarations, b.declarations);
  });
  return normalized;
}

function insertSorted(values: string[], value: string): void {
  let low: number = 0;
  let high: number = values.length;
  while (low < high) {
    const middle: number = (low + high) >>> 1;
    if (compareStrings(values[middle]!, value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function topologicalOrder(
  states: readonly NormalizedState[],
  declarations: readonly string[],
): readonly string[] {
  const adjacency: Map<string, Set<string>> = new Map<string, Set<string>>();
  const indegree: Map<string, number> = new Map<string, number>();
  for (const declaration of declarations) {
    adjacency.set(declaration, new Set<string>());
    indegree.set(declaration, 0);
  }

  for (const state of states) {
    for (const edge of state.order) {
      const before: string = edge[0];
      const after: string = edge[1];
      const neighbors: Set<string> = adjacency.get(before)!;
      if (!neighbors.has(after)) {
        neighbors.add(after);
        indegree.set(after, indegree.get(after)! + 1);
      }
    }
  }

  const ready: string[] = declarations.filter((declaration: string): boolean => indegree.get(declaration) === 0);
  ready.sort(compareStrings);
  const result: string[] = [];
  while (ready.length > 0) {
    const current: string = ready.shift()!;
    result.push(current);
    for (const next of [...adjacency.get(current)!].sort(compareStrings)) {
      const nextIndegree: number = indegree.get(next)! - 1;
      indegree.set(next, nextIndegree);
      if (nextIndegree === 0) insertSorted(ready, next);
    }
  }

  if (result.length !== declarations.length) {
    const cycleNodes: readonly string[] = declarations.filter(
      (declaration: string): boolean => indegree.get(declaration)! > 0,
    );
    throw new ClassCoverError({
      code: 'QS1601',
      message: 'the union of class-cover order constraints contains a cycle',
      details: cycleNodes,
    });
  }
  return result;
}

function intersectSorted(a: readonly string[], b: readonly string[]): readonly string[] {
  const result: string[] = [];
  let left: number = 0;
  let right: number = 0;
  while (left < a.length && right < b.length) {
    const comparison: number = compareStrings(a[left]!, b[right]!);
    if (comparison === 0) {
      result.push(a[left]!);
      left += 1;
      right += 1;
    } else if (comparison < 0) {
      left += 1;
    } else {
      right += 1;
    }
  }
  return result;
}

function isSubset(candidate: readonly string[], state: readonly string[]): boolean {
  let candidateIndex: number = 0;
  let stateIndex: number = 0;
  while (candidateIndex < candidate.length && stateIndex < state.length) {
    const comparison: number = compareStrings(candidate[candidateIndex]!, state[stateIndex]!);
    if (comparison === 0) {
      candidateIndex += 1;
      stateIndex += 1;
    } else if (comparison > 0) {
      stateIndex += 1;
    } else {
      return false;
    }
  }
  return candidateIndex === candidate.length;
}

function generateCandidates(
  states: readonly NormalizedState[],
  maxCandidates: number,
): readonly Candidate[] {
  const candidatesByKey: Map<string, readonly string[]> = new Map<string, readonly string[]>();
  const frontier: string[][] = [];

  const add = (declarations: readonly string[]): void => {
    if (declarations.length === 0) return;
    const canonical: string[] = [...declarations];
    const key: string = candidateKey(canonical);
    if (candidatesByKey.has(key)) return;
    if (candidatesByKey.size >= maxCandidates) {
      throw resourceError(
        `class-cover candidate count exceeds maxCandidates ${maxCandidates}`,
        0,
        candidatesByKey.size + 1,
      );
    }
    candidatesByKey.set(key, canonical);
    frontier.push(canonical);
  };

  // Intersection closure is complete for this API: after the order union is
  // proven acyclic, every subset class is order-safe under globalOrder.
  for (const state of states) add(state.declarations);
  for (let index: number = 0; index < frontier.length; index += 1) {
    const current: readonly string[] = frontier[index]!;
    for (const state of states) add(intersectSorted(current, state.declarations));
  }

  const candidates: Candidate[] = [...candidatesByKey.values()].map(
    (declarations: readonly string[]): Candidate => ({
      declarations,
      key: candidateKey(declarations),
    }),
  );
  candidates.sort((a, b) => compareStringArrays(a.declarations, b.declarations));
  return candidates;
}

function lexicographicallySmaller(a: readonly number[], b: readonly number[]): boolean {
  return compareNumberArrays(a, b) < 0;
}

export function solveClassCover(
  states: readonly ClassCoverState[],
  limits: ClassCoverResourceLimits = {},
): ClassCoverResult {
  const maxCandidates: number = checkedLimit(
    limits.maxCandidates,
    DEFAULT_MAX_CANDIDATES,
    'maxCandidates',
  );
  const maxStates: number = checkedLimit(limits.maxStates, DEFAULT_MAX_STATES, 'maxStates');
  const maxSearchNodes: number = checkedLimit(
    limits.maxSearchNodes,
    DEFAULT_MAX_SEARCH_NODES,
    'maxSearchNodes',
  );
  const normalizedStates: readonly NormalizedState[] = normalizeStates(states, maxStates);
  const declarationSet: Set<string> = new Set<string>();
  for (const state of normalizedStates) {
    for (const declaration of state.declarations) declarationSet.add(declaration);
  }
  const declarations: readonly string[] = [...declarationSet].sort(compareStrings);
  const globalOrder: readonly string[] = topologicalOrder(normalizedStates, declarations);

  if (normalizedStates.length === 0 || declarations.length === 0) {
    const emptyObjective: ClassCoverObjective = { K: 0, T: 0 };
    const emptyAssignmentEntries: Array<readonly [string, readonly number[]]> = normalizedStates.map(
      (state: NormalizedState): readonly [string, readonly number[]] => [state.id, []],
    );
    const emptyAssignments: ReadonlyMap<string, readonly number[]> = new Map(emptyAssignmentEntries);
    const emptyBasis: readonly (readonly string[])[] = [];
    return {
      basis: emptyBasis,
      classes: emptyBasis,
      assignments: emptyAssignments,
      perStateAssignments: emptyAssignments,
      globalOrder,
      topologicalOrder: globalOrder,
      K: 0,
      T: 0,
      classCount: 0,
      assignmentCount: 0,
      lowerBound: emptyObjective,
      upperBound: emptyObjective,
      optimality: { status: 'optimal', lowerBound: emptyObjective, upperBound: emptyObjective },
      candidateCount: 0,
      exploredNodes: 0,
    };
  }

  const candidates: readonly Candidate[] = generateCandidates(normalizedStates, maxCandidates);
  const candidateCount: number = candidates.length;
  const candidateIndexByKey: Map<string, number> = new Map<string, number>();
  for (let index: number = 0; index < candidates.length; index += 1) {
    candidateIndexByKey.set(candidates[index]!.key, index);
  }

  const eligibleByState: number[][] = normalizedStates.map(() => []);
  const candidateEligibleStates: number[][] = candidates.map(() => []);
  const optionsByStateDeclaration: Array<Map<string, number[]>> = normalizedStates.map(
    () => new Map<string, number[]>(),
  );
  for (let candidateIndex: number = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate: Candidate = candidates[candidateIndex]!;
    for (let stateIndex: number = 0; stateIndex < normalizedStates.length; stateIndex += 1) {
      const state: NormalizedState = normalizedStates[stateIndex]!;
      if (!isSubset(candidate.declarations, state.declarations)) continue;
      eligibleByState[stateIndex]!.push(candidateIndex);
      candidateEligibleStates[candidateIndex]!.push(stateIndex);
      const options: Map<string, number[]> = optionsByStateDeclaration[stateIndex]!;
      for (const declaration of candidate.declarations) {
        const existing: number[] | undefined = options.get(declaration);
        if (existing === undefined) options.set(declaration, [candidateIndex]);
        else existing.push(candidateIndex);
      }
    }
  }

  const covered: Array<Set<string>> = normalizedStates.map(() => new Set<string>());
  const selected: boolean[] = candidates.map(() => false);
  const selectedList: number[] = [];
  let exploredNodes: number = 0;
  let best: SearchSolution | null = null;

  const tick = (): void => {
    exploredNodes += 1;
    if (exploredNodes > maxSearchNodes) {
      const upperBound: ClassCoverObjective | undefined =
        best === null ? undefined : { K: best.selected.length, T: best.evaluation.T };
      throw resourceError(
        `class-cover exact search exceeded maxSearchNodes ${maxSearchNodes}`,
        exploredNodes,
        candidateCount,
        undefined,
        upperBound,
      );
    }
  };

  const applyCandidate = (candidateIndex: number): readonly (readonly [number, string])[] => {
    const candidate: Candidate = candidates[candidateIndex]!;
    const changed: Array<readonly [number, string]> = [];
    for (const stateIndex of candidateEligibleStates[candidateIndex]!) {
      const stateCovered: Set<string> = covered[stateIndex]!;
      for (const declaration of candidate.declarations) {
        if (!stateCovered.has(declaration)) {
          stateCovered.add(declaration);
          changed.push([stateIndex, declaration]);
        }
      }
    }
    return changed;
  };

  const rollback = (changed: readonly (readonly [number, string])[]): void => {
    for (let index: number = changed.length - 1; index >= 0; index -= 1) {
      const change: readonly [number, string] = changed[index]!;
      covered[change[0]]!.delete(change[1]);
    }
  };

  const chooseRequirement = (): RequirementChoice | null => {
    let choice: RequirementChoice | null = null;
    for (let stateIndex: number = 0; stateIndex < normalizedStates.length; stateIndex += 1) {
      const state: NormalizedState = normalizedStates[stateIndex]!;
      const stateCovered: Set<string> = covered[stateIndex]!;
      const options: Map<string, number[]> = optionsByStateDeclaration[stateIndex]!;
      for (const declaration of state.declarations) {
        if (stateCovered.has(declaration)) continue;
        const available: readonly number[] = (options.get(declaration) ?? []).filter(
          (candidateIndex: number): boolean => !selected[candidateIndex],
        );
        if (available.length === 0) {
          return { stateIndex, declaration, candidates: [] };
        }
        if (
          choice === null ||
          available.length < choice.candidates.length ||
          (available.length === choice.candidates.length &&
            (state.id < normalizedStates[choice.stateIndex]!.id ||
              (state.id === normalizedStates[choice.stateIndex]!.id &&
                declaration < choice.declaration)))
        ) {
          choice = { stateIndex, declaration, candidates: available };
        }
      }
    }
    return choice;
  };

  const uncoveredCount = (): number => {
    let count: number = 0;
    for (let stateIndex: number = 0; stateIndex < normalizedStates.length; stateIndex += 1) {
      count += normalizedStates[stateIndex]!.declarations.length - covered[stateIndex]!.size;
    }
    return count;
  };

  const lowerBoundForUncovered = (remaining: number): number => {
    if (remaining === 0) return 0;
    let maxCoverage: number = 0;
    for (let candidateIndex: number = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      if (selected[candidateIndex]) continue;
      const candidate: Candidate = candidates[candidateIndex]!;
      let coverage: number = 0;
      for (const stateIndex of candidateEligibleStates[candidateIndex]!) {
        const stateCovered: Set<string> = covered[stateIndex]!;
        for (const declaration of candidate.declarations) {
          if (!stateCovered.has(declaration)) coverage += 1;
        }
      }
      if (coverage > maxCoverage) maxCoverage = coverage;
    }
    if (maxCoverage === 0) return Number.POSITIVE_INFINITY;
    return Math.ceil(remaining / maxCoverage);
  };

  interface DpEntry {
    readonly count: number;
    readonly assignment: readonly number[];
  }

  const stateCandidateMaskCache: Array<Map<number, bigint>> = normalizedStates.map(
    () => new Map<number, bigint>(),
  );

  const candidateMaskForState = (stateIndex: number, candidateIndex: number): bigint => {
    const cache: Map<number, bigint> = stateCandidateMaskCache[stateIndex]!;
    const cached: bigint | undefined = cache.get(candidateIndex);
    if (cached !== undefined) return cached;
    const state: NormalizedState = normalizedStates[stateIndex]!;
    const localIndex: Map<string, number> = new Map<string, number>();
    for (let index: number = 0; index < state.declarations.length; index += 1) {
      localIndex.set(state.declarations[index]!, index);
    }
    let mask: bigint = 0n;
    for (const declaration of candidates[candidateIndex]!.declarations) {
      mask |= 1n << BigInt(localIndex.get(declaration)!);
    }
    cache.set(candidateIndex, mask);
    return mask;
  };

  const evaluateSelection = (selectedIndexes: readonly number[]): SelectionEvaluation => {
    const selectedSet: Set<number> = new Set<number>(selectedIndexes);
    const assignments: (readonly number[])[] = [];
    let total: number = 0;
    for (let stateIndex: number = 0; stateIndex < normalizedStates.length; stateIndex += 1) {
      const state: NormalizedState = normalizedStates[stateIndex]!;
      const fullMask: bigint = (1n << BigInt(state.declarations.length)) - 1n;
      const eligibleSelected: readonly number[] = eligibleByState[stateIndex]!.filter(
        (candidateIndex: number): boolean => selectedSet.has(candidateIndex),
      );
      const dp: Map<bigint, DpEntry> = new Map<bigint, DpEntry>();
      dp.set(0n, { count: 0, assignment: [] });
      for (const candidateIndex of eligibleSelected) {
        const mask: bigint = candidateMaskForState(stateIndex, candidateIndex);
        const snapshot: readonly (readonly [bigint, DpEntry])[] = [...dp.entries()];
        for (const entry of snapshot) {
          tick();
          const previousMask: bigint = entry[0];
          const nextMask: bigint = previousMask | mask;
          if (nextMask === previousMask) continue;
          const previous: DpEntry = entry[1];
          const assignment: readonly number[] = [...previous.assignment, candidateIndex];
          const existing: DpEntry | undefined = dp.get(nextMask);
          if (
            existing === undefined ||
            previous.count + 1 < existing.count ||
            (previous.count + 1 === existing.count &&
              lexicographicallySmaller(assignment, existing.assignment))
          ) {
            dp.set(nextMask, { count: previous.count + 1, assignment });
          }
        }
      }
      const complete: DpEntry | undefined = dp.get(fullMask);
      if (complete === undefined) {
        throw new Error(`internal class-cover selection does not cover state ${state.id}`);
      }
      assignments.push(complete.assignment);
      total += complete.count;
    }
    return { T: total, assignments };
  };

  const consider = (selectedIndexes: readonly number[]): void => {
    const canonicalSelected: readonly number[] = [...selectedIndexes].sort((a, b) => a - b);
    const evaluation: SelectionEvaluation = evaluateSelection(canonicalSelected);
    const solution: SearchSolution = { selected: canonicalSelected, evaluation };
    if (best === null) {
      best = solution;
      return;
    }
    const currentK: number = canonicalSelected.length;
    const bestK: number = best.selected.length;
    if (
      currentK < bestK ||
      (currentK === bestK && evaluation.T < best.evaluation.T) ||
      (currentK === bestK && evaluation.T === best.evaluation.T &&
        lexicographicallySmaller(canonicalSelected, best.selected))
    ) {
      best = solution;
    }
  };

  // A deterministic feasible upper bound: one full-state candidate per state.
  const seedSet: Set<number> = new Set<number>();
  for (const state of normalizedStates) {
    const index: number | undefined = candidateIndexByKey.get(candidateKey(state.declarations));
    if (index !== undefined) seedSet.add(index);
  }
  const seedIndexes: readonly number[] = [...seedSet].sort((a, b) => a - b);
  tick();
  consider(seedIndexes);

  const dfs = (): void => {
    tick();
    const remaining: number = uncoveredCount();
    if (remaining === 0) {
      consider(selectedList);
      return;
    }
    const bestKnown: number = best?.selected.length ?? Number.POSITIVE_INFINITY;
    const lowerAdditional: number = lowerBoundForUncovered(remaining);
    if (selectedList.length + lowerAdditional > bestKnown) return;

    const choice: RequirementChoice | null = chooseRequirement();
    if (choice === null || choice.candidates.length === 0) return;
    for (const candidateIndex of choice.candidates) {
      if (selected[candidateIndex]) continue;
      selected[candidateIndex] = true;
      selectedList.push(candidateIndex);
      const changed: readonly (readonly [number, string])[] = applyCandidate(candidateIndex);
      dfs();
      rollback(changed);
      selectedList.pop();
      selected[candidateIndex] = false;
    }
  };

  dfs();
  if (best === null) {
    throw new ClassCoverError({
      code: 'QS1601',
      message: 'no class cover satisfies the finite declaration and order model',
      candidateCount,
      exploredNodes,
    });
  }
  const finalBest: SearchSolution = best as SearchSolution;

  const selectedIndexes: readonly number[] = [...finalBest.selected].sort((a, b) => a - b);
  const compactIndexByCandidate: Map<number, number> = new Map<number, number>();
  for (let index: number = 0; index < selectedIndexes.length; index += 1) {
    compactIndexByCandidate.set(selectedIndexes[index]!, index);
  }
  const basis: readonly (readonly string[])[] = selectedIndexes.map(
    (candidateIndex: number): readonly string[] => candidates[candidateIndex]!.declarations,
  );
  const assignmentEntries: Array<readonly [string, readonly number[]]> = [];
  for (let stateIndex: number = 0; stateIndex < normalizedStates.length; stateIndex += 1) {
    assignmentEntries.push([
      normalizedStates[stateIndex]!.id,
      finalBest.evaluation.assignments[stateIndex]!.map(
        (candidateIndex: number): number => compactIndexByCandidate.get(candidateIndex)!,
      ),
    ]);
  }
  const assignments: ReadonlyMap<string, readonly number[]> = new Map(assignmentEntries);
  const objective: ClassCoverObjective = { K: basis.length, T: finalBest.evaluation.T };
  const optimality: ClassCoverOptimality = {
    status: 'optimal',
    lowerBound: objective,
    upperBound: objective,
  };
  return {
    basis,
    classes: basis,
    assignments,
    perStateAssignments: assignments,
    globalOrder,
    topologicalOrder: globalOrder,
    K: objective.K,
    T: objective.T,
    classCount: objective.K,
    assignmentCount: objective.T,
    lowerBound: objective,
    upperBound: objective,
    optimality,
    candidateCount,
    exploredNodes,
  };
}
