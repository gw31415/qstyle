import { describe, expect, it } from 'vitest';
import { solveClassCover } from './class-cover.js';
import type { ClassCoverResult, ClassCoverState } from './class-cover.js';
import { verifyClassCover, verifyCover } from './verify-cover.js';

function resultFor(states: readonly ClassCoverState[]): ClassCoverResult {
  return solveClassCover(states);
}

describe('verifyClassCover', () => {
  it('accepts a valid result and counts an overlapping logical declaration once', () => {
    const states: readonly ClassCoverState[] = [
      { id: 'a', declarations: ['a', 'b'] },
      { id: 'b', declarations: ['a', 'c'] },
    ];
    const result: ClassCoverResult = resultFor(states);
    const verification = verifyClassCover(states, result);

    expect(verification.ok).toBe(true);
    expect(verification.valid).toBe(true);
    expect(verification.issues).toEqual([]);
    expect(verification.declarationOccurrences.get('a')).toBe(1);
    expect(verifyCover(states, result)).toEqual(verification);
  });

  it('detects missing coverage and an extra declaration assignment', () => {
    const states: readonly ClassCoverState[] = [
      { id: 'a', declarations: ['a'] },
      { id: 'b', declarations: ['b'] },
    ];
    const original: ClassCoverResult = resultFor(states);
    const invalid: ClassCoverResult = {
      ...original,
      basis: [['a', 'b']],
      classes: [['a', 'b']],
      assignments: new Map<string, readonly number[]>([
        ['a', [0]],
        ['b', []],
      ]),
      perStateAssignments: new Map<string, readonly number[]>([
        ['a', [0]],
        ['b', []],
      ]),
      K: 1,
      classCount: 1,
      T: 1,
      assignmentCount: 1,
      lowerBound: { K: 1, T: 1 },
      upperBound: { K: 1, T: 1 },
      optimality: {
        status: 'optimal',
        lowerBound: { K: 1, T: 1 },
        upperBound: { K: 1, T: 1 },
      },
    };
    const verification = verifyClassCover(states, invalid);

    expect(verification.ok).toBe(false);
    expect(verification.issues.some((issue) => issue.code === 'EXTRA')).toBe(true);
    expect(verification.issues.some((issue) => issue.code === 'COVERAGE')).toBe(true);
  });

  it('detects canonical class duplication and an invalid global order', () => {
    const states: readonly ClassCoverState[] = [
      { id: 'state', declarations: ['a', 'b'], order: [['a', 'b']] },
    ];
    const original: ClassCoverResult = resultFor(states);
    const invalid: ClassCoverResult = {
      ...original,
      basis: [['a'], ['a'], ['b']],
      classes: [['a'], ['a'], ['b']],
      assignments: new Map<string, readonly number[]>([['state', [0, 2]]]),
      perStateAssignments: new Map<string, readonly number[]>([['state', [0, 2]]]),
      globalOrder: ['b', 'a'],
      topologicalOrder: ['b', 'a'],
      K: 3,
      classCount: 3,
      T: 2,
      assignmentCount: 2,
      lowerBound: { K: 3, T: 2 },
      upperBound: { K: 3, T: 2 },
      optimality: {
        status: 'optimal',
        lowerBound: { K: 3, T: 2 },
        upperBound: { K: 3, T: 2 },
      },
    };
    const verification = verifyClassCover(states, invalid);

    expect(verification.ok).toBe(false);
    expect(verification.issues.some((issue) => issue.code === 'CANONICAL')).toBe(true);
    expect(verification.issues.some((issue) => issue.code === 'ORDER')).toBe(true);
  });

  it('accepts unsorted input declarations while rejecting repeated input identities', () => {
    const states: readonly ClassCoverState[] = [
      { id: 'state', declarations: ['b', 'a'] },
    ];
    const result: ClassCoverResult = resultFor(states);
    expect(verifyClassCover(states, result).ok).toBe(true);

    const repeated: ClassCoverVerificationResult = verifyClassCover(
      [{ id: 'state', declarations: ['a', 'a'] }],
      result,
    );
    expect(repeated.ok).toBe(false);
    expect(repeated.issues.some((issue) => issue.code === 'CANONICAL')).toBe(true);
  });
});

type ClassCoverVerificationResult = ReturnType<typeof verifyClassCover>;
