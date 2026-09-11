import { describe, expect, it } from 'vitest';
import { ClassCoverError, solveClassCover } from './class-cover.js';
import type { ClassCoverResult, ClassCoverState } from './class-cover.js';

interface OracleSolution {
  readonly K: number;
  readonly T: number;
  readonly basis: readonly (readonly string[])[];
}

function canonical(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function key(values: readonly string[]): string {
  return JSON.stringify(values);
}

function allSubsets(values: readonly string[]): readonly (readonly string[])[] {
  const result: (readonly string[])[] = [];
  const count: number = 1 << values.length;
  for (let mask: number = 1; mask < count; mask += 1) {
    const subset: string[] = [];
    for (let index: number = 0; index < values.length; index += 1) {
      if ((mask & (1 << index)) !== 0) subset.push(values[index]!);
    }
    result.push(subset);
  }
  return result;
}

function isSubset(candidate: readonly string[], state: readonly string[]): boolean {
  const stateSet: Set<string> = new Set<string>(state);
  return candidate.every((declaration: string): boolean => stateSet.has(declaration));
}

function unionOf(classes: readonly (readonly string[])[]): readonly string[] {
  const union: Set<string> = new Set<string>();
  for (const classDeclarations of classes) {
    for (const declaration of classDeclarations) union.add(declaration);
  }
  return [...union].sort();
}

function minimumAssignments(
  selected: readonly (readonly string[])[],
  state: readonly string[],
): number | null {
  let best: number | null = null;
  const count: number = 1 << selected.length;
  for (let mask: number = 0; mask < count; mask += 1) {
    const chosen: (readonly string[])[] = [];
    for (let index: number = 0; index < selected.length; index += 1) {
      if ((mask & (1 << index)) !== 0) chosen.push(selected[index]!);
    }
    if (unionOf(chosen).join('\u0000') !== state.join('\u0000')) continue;
    const assignmentCount: number = chosen.length;
    if (best === null || assignmentCount < best) best = assignmentCount;
  }
  return best;
}

/** Independent all-subset oracle for the small finite fixtures below. */
function exhaustiveOracle(states: readonly ClassCoverState[]): OracleSolution {
  const normalized: readonly string[][] = states.map((state: ClassCoverState): string[] => [
    ...canonical(state.declarations),
  ]);
  const candidatesByKey: Map<string, readonly string[]> = new Map<string, readonly string[]>();
  for (const state of normalized) {
    for (const subset of allSubsets(state)) candidatesByKey.set(key(subset), subset);
  }
  const candidates: readonly (readonly string[])[] = [...candidatesByKey.values()].sort(
    (a, b) => key(a).localeCompare(key(b)),
  );
  let best: OracleSolution | null = null;
  const combinationCount: number = 1 << candidates.length;
  for (let mask: number = 0; mask < combinationCount; mask += 1) {
    const selected: (readonly string[])[] = [];
    for (let index: number = 0; index < candidates.length; index += 1) {
      if ((mask & (1 << index)) !== 0) selected.push(candidates[index]!);
    }
    let totalAssignments: number = 0;
    let feasible: boolean = true;
    for (const state of normalized) {
      const assignmentCount: number | null = minimumAssignments(selected, state);
      if (assignmentCount === null) {
        feasible = false;
        break;
      }
      totalAssignments += assignmentCount;
    }
    if (!feasible) continue;
    const candidateSolution: OracleSolution = {
      K: selected.length,
      T: totalAssignments,
      basis: selected,
    };
    if (
      best === null ||
      candidateSolution.K < best.K ||
      (candidateSolution.K === best.K && candidateSolution.T < best.T)
    ) {
      best = candidateSolution;
    }
  }
  if (best === null) throw new Error('oracle failed to find a cover');
  return best;
}

function canonicalBasis(result: ClassCoverResult): readonly string[] {
  return result.basis.map((classDeclarations: readonly string[]): string => key(classDeclarations));
}

describe('solveClassCover', () => {
  it('matches an independent all-subset oracle for finite union-cover cases', () => {
    const states: readonly ClassCoverState[] = [
      { id: 'A', declarations: ['padding', 'red'] },
      { id: 'B', declarations: ['blue', 'padding'] },
    ];
    const expected: OracleSolution = exhaustiveOracle(states);
    const result: ClassCoverResult = solveClassCover(states);

    expect({ K: result.K, T: result.T }).toEqual({ K: expected.K, T: expected.T });
    expect([...result.globalOrder]).toEqual(['blue', 'padding', 'red']);
    expect(result.optimality.status).toBe('optimal');
    expect(result.lowerBound).toEqual(result.upperBound);
    expect(canonicalBasis(result)).toEqual(['["blue","padding"]', '["padding","red"]']);
    expect(result.assignments.get('A')).toEqual([1]);
    expect(result.assignments.get('B')).toEqual([0]);
  });

  it('matches the oracle across several overlapping state families', () => {
    const cases: readonly (readonly ClassCoverState[])[] = [
      [
        { id: 'one', declarations: ['a', 'b'] },
        { id: 'two', declarations: ['a', 'c'] },
      ],
      [
        { id: 'one', declarations: ['a', 'b'] },
        { id: 'two', declarations: ['b', 'c'] },
        { id: 'three', declarations: ['a', 'c'] },
      ],
      [
        { id: 'one', declarations: ['a', 'b', 'c'] },
        { id: 'two', declarations: ['a', 'b'] },
        { id: 'three', declarations: ['b', 'c'] },
      ],
    ];
    for (const states of cases) {
      const expected: OracleSolution = exhaustiveOracle(states);
      const result: ClassCoverResult = solveClassCover(states);
      expect({ K: result.K, T: result.T }).toEqual({ K: expected.K, T: expected.T });
    }
  });

  it('keeps classes and assignments deterministic when state traversal order changes', () => {
    const states: readonly ClassCoverState[] = [
      { id: 'z', declarations: ['b', 'c'] },
      { id: 'a', declarations: ['a', 'b'] },
      { id: 'm', declarations: ['a', 'c'] },
    ];
    const first: ClassCoverResult = solveClassCover(states);
    const second: ClassCoverResult = solveClassCover([states[2]!, states[0]!, states[1]!]);

    expect(second.basis).toEqual(first.basis);
    expect(second.globalOrder).toEqual(first.globalOrder);
    expect([...second.assignments]).toEqual([...first.assignments]);
    expect(second.K).toBe(first.K);
    expect(second.T).toBe(first.T);
  });

  it('returns no classes and an empty assignment for an empty state', () => {
    const result: ClassCoverResult = solveClassCover([
      { id: 'empty', declarations: [] },
    ]);

    expect(result.basis).toEqual([]);
    expect(result.globalOrder).toEqual([]);
    expect(result.assignments.get('empty')).toEqual([]);
    expect(result.K).toBe(0);
    expect(result.T).toBe(0);
  });

  it('returns a canonical global topological order', () => {
    const result: ClassCoverResult = solveClassCover([
      { id: 'second', declarations: ['a', 'b', 'c'], order: [['b', 'c']] },
      { id: 'first', declarations: ['a', 'b', 'c'], order: [['a', 'b']] },
    ]);

    expect(result.globalOrder).toEqual(['a', 'b', 'c']);
  });

  it('fails closed with QS1601 when order constraints form a cycle', () => {
    try {
      solveClassCover([
        { id: 'forward', declarations: ['a', 'b'], order: [['a', 'b']] },
        { id: 'reverse', declarations: ['a', 'b'], order: [['b', 'a']] },
      ]);
      throw new Error('expected order-cycle diagnostic');
    } catch (error) {
      expect(error).toBeInstanceOf(ClassCoverError);
      expect((error as ClassCoverError).code).toBe('QS1601');
      expect((error as ClassCoverError).diagnostic.details).toEqual(['a', 'b']);
    }
  });

  it('fails closed with QS1602 at the candidate resource bound', () => {
    try {
      solveClassCover(
        [
          { id: 'a', declarations: ['a'] },
          { id: 'b', declarations: ['b'] },
        ],
        { maxCandidates: 1 },
      );
      throw new Error('expected candidate resource diagnostic');
    } catch (error) {
      expect(error).toBeInstanceOf(ClassCoverError);
      expect((error as ClassCoverError).code).toBe('QS1602');
    }
  });

  it('fails closed when the search budget ends instead of treating an incumbent as optimal', () => {
    try {
      solveClassCover([{ id: 'a', declarations: ['a'] }], { maxSearchNodes: 2 });
      throw new Error('expected search resource diagnostic');
    } catch (error) {
      expect(error).toBeInstanceOf(ClassCoverError);
      expect((error as ClassCoverError).code).toBe('QS1602');
      expect((error as ClassCoverError).lowerBound).toBeNull();
      expect((error as ClassCoverError).upperBound).toEqual({ K: 1, T: 1 });
    }
  });
});
