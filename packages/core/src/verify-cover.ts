/**
 * Independent verifier for finite class-cover results.
 *
 * This module intentionally does not call the solver or reuse its search
 * state.  It checks the public declaration-set result as a consumer would:
 * canonical classes, exact per-state coverage, global order constraints, and
 * one logical declaration definition in the emitted union.
 */

import type { ClassCoverResult, ClassCoverState } from './class-cover.js';

export type ClassCoverVerificationCode =
  | 'CANONICAL'
  | 'ASSIGNMENT'
  | 'COVERAGE'
  | 'EXTRA'
  | 'ORDER';

export interface ClassCoverVerificationIssue {
  readonly code: ClassCoverVerificationCode;
  readonly message: string;
  readonly stateId?: string;
  readonly declaration?: string;
}

export interface ClassCoverVerification {
  readonly ok: boolean;
  readonly valid: boolean;
  readonly issues: readonly ClassCoverVerificationIssue[];
  readonly errors: readonly string[];
  /**
   * Logical IR-union occurrence counts. This does not inspect final CSS
   * payloads; the final artifact verifier owns payload-duplication checks.
   */
  readonly declarationOccurrences: ReadonlyMap<string, number>;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareStringArrays(a: readonly string[], b: readonly string[]): number {
  const length: number = Math.min(a.length, b.length);
  for (let index: number = 0; index < length; index += 1) {
    const comparison: number = compareStrings(a[index]!, b[index]!);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function keyOf(declarations: readonly string[]): string {
  return JSON.stringify(declarations);
}

function isCanonicalDeclarations(declarations: readonly string[]): boolean {
  for (let index: number = 1; index < declarations.length; index += 1) {
    if (compareStrings(declarations[index - 1]!, declarations[index]!) >= 0) return false;
  }
  return true;
}

function containsAll(
  candidate: readonly string[],
  state: ReadonlySet<string>,
): boolean {
  for (const declaration of candidate) {
    if (!state.has(declaration)) return false;
  }
  return true;
}

function addIssue(
  issues: ClassCoverVerificationIssue[],
  code: ClassCoverVerificationCode,
  message: string,
  stateId?: string,
  declaration?: string,
): void {
  const issue: ClassCoverVerificationIssue =
    stateId === undefined
      ? declaration === undefined
        ? { code, message }
        : { code, message, declaration }
      : declaration === undefined
        ? { code, message, stateId }
        : { code, message, stateId, declaration };
  issues.push(issue);
}

/** Verify a solver result without relying on solver implementation details. */
export function verifyClassCover(
  states: readonly ClassCoverState[],
  result: ClassCoverResult,
): ClassCoverVerification {
  const issues: ClassCoverVerificationIssue[] = [];
  const stateById: Map<string, ClassCoverState> = new Map<string, ClassCoverState>();
  const stateSets: Map<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>();
  const stateOrder: Map<string, readonly (readonly [string, string])[]> =
    new Map<string, readonly (readonly [string, string])[]>();

  for (const state of states) {
    if (stateById.has(state.id)) {
      addIssue(issues, 'CANONICAL', `duplicate state id ${JSON.stringify(state.id)}`, state.id);
      continue;
    }
    const canonicalDeclarations: readonly string[] = [...new Set(state.declarations)].sort(compareStrings);
    if (canonicalDeclarations.length !== state.declarations.length) {
      addIssue(
        issues,
        'CANONICAL',
        `state ${JSON.stringify(state.id)} declarations repeat a canonical declaration`,
        state.id,
      );
    }
    stateById.set(state.id, state);
    stateSets.set(state.id, new Set<string>(canonicalDeclarations));
    stateOrder.set(state.id, state.order ?? []);
  }

  const basis: readonly (readonly string[])[] = result.basis;
  const basisKeys: Set<string> = new Set<string>();
  for (let classIndex: number = 0; classIndex < basis.length; classIndex += 1) {
    const declarations: readonly string[] = basis[classIndex]!;
    const key: string = keyOf(declarations);
    if (declarations.length === 0) {
      addIssue(issues, 'CANONICAL', `basis class ${classIndex} is empty`);
    }
    if (!isCanonicalDeclarations(declarations)) {
      addIssue(issues, 'CANONICAL', `basis class ${classIndex} is not sorted and unique`);
    }
    if (basisKeys.has(key)) {
      addIssue(issues, 'CANONICAL', `basis class ${classIndex} duplicates an earlier class`);
    }
    basisKeys.add(key);
  }

  const declarationUnion: Set<string> = new Set<string>();
  for (const state of states) {
    for (const declaration of state.declarations) declarationUnion.add(declaration);
  }
  const occurrenceMap: Map<string, number> = new Map<string, number>();
  // Overlapping basis classes are allowed: this is the logical IR union, not
  // the final serialized CSS payload, and is therefore counted once.
  for (const classDeclarations of basis) {
    for (const declaration of classDeclarations) {
      if (!declarationUnion.has(declaration)) {
        addIssue(
          issues,
          'EXTRA',
          `basis contains declaration absent from all states: ${JSON.stringify(declaration)}`,
          undefined,
          declaration,
        );
      }
      occurrenceMap.set(declaration, 1);
    }
  }
  for (const declaration of declarationUnion) {
    if (!occurrenceMap.has(declaration)) occurrenceMap.set(declaration, 0);
  }
  for (const [declaration, occurrences] of occurrenceMap) {
    if (occurrences !== 1 && declarationUnion.has(declaration)) {
      addIssue(
        issues,
        'CANONICAL',
        `canonical declaration ${JSON.stringify(declaration)} is emitted ${occurrences} times`,
        undefined,
        declaration,
      );
    }
  }

  const order: readonly string[] = result.globalOrder;
  const orderPositions: Map<string, number> = new Map<string, number>();
  for (let index: number = 0; index < order.length; index += 1) {
    const declaration: string = order[index]!;
    if (orderPositions.has(declaration)) {
      addIssue(issues, 'CANONICAL', `global order repeats ${JSON.stringify(declaration)}`, undefined, declaration);
    } else {
      orderPositions.set(declaration, index);
    }
  }
  if (order.length !== declarationUnion.size || orderPositions.size !== declarationUnion.size) {
    addIssue(issues, 'ORDER', 'global order does not contain each canonical declaration exactly once');
  }
  for (const declaration of declarationUnion) {
    if (!orderPositions.has(declaration)) {
      addIssue(issues, 'ORDER', `global order omits ${JSON.stringify(declaration)}`, undefined, declaration);
    }
  }
  for (const declaration of order) {
    if (!declarationUnion.has(declaration)) {
      addIssue(issues, 'EXTRA', `global order contains unknown declaration ${JSON.stringify(declaration)}`, undefined, declaration);
    }
  }

  const assignments: ReadonlyMap<string, readonly number[]> = result.assignments;
  const seenAssignmentIds: Set<string> = new Set<string>();
  let assignmentCount: number = 0;
  for (const [stateId, assignedClasses] of assignments) {
    if (seenAssignmentIds.has(stateId)) {
      addIssue(issues, 'ASSIGNMENT', `assignment repeats state ${JSON.stringify(stateId)}`, stateId);
      continue;
    }
    seenAssignmentIds.add(stateId);
    const stateSet: ReadonlySet<string> | undefined = stateSets.get(stateId);
    if (stateSet === undefined) {
      addIssue(issues, 'ASSIGNMENT', `assignment references unknown state ${JSON.stringify(stateId)}`, stateId);
      continue;
    }
    const covered: Set<string> = new Set<string>();
    const seenClassIndexes: Set<number> = new Set<number>();
    for (const classIndex of assignedClasses) {
      assignmentCount += 1;
      if (!Number.isInteger(classIndex) || classIndex < 0 || classIndex >= basis.length) {
        addIssue(issues, 'ASSIGNMENT', `assignment references invalid class ${classIndex}`, stateId);
        continue;
      }
      if (seenClassIndexes.has(classIndex)) {
        addIssue(issues, 'ASSIGNMENT', `assignment repeats class ${classIndex}`, stateId);
        continue;
      }
      seenClassIndexes.add(classIndex);
      const classDeclarations: readonly string[] = basis[classIndex]!;
      if (!containsAll(classDeclarations, stateSet)) {
        addIssue(issues, 'EXTRA', `assigned class ${classIndex} adds declarations to the state`, stateId);
      }
      for (const declaration of classDeclarations) covered.add(declaration);
    }
    for (const declaration of covered) {
      if (!stateSet.has(declaration)) {
        addIssue(issues, 'EXTRA', `state receives undeclared ${JSON.stringify(declaration)}`, stateId, declaration);
      }
    }
    for (const declaration of stateSet) {
      if (!covered.has(declaration)) {
        addIssue(issues, 'COVERAGE', `state is missing ${JSON.stringify(declaration)}`, stateId, declaration);
      }
    }
  }
  for (const state of states) {
    if (!seenAssignmentIds.has(state.id)) {
      addIssue(issues, 'ASSIGNMENT', `state has no assignment entry`, state.id);
    }
  }

  for (const state of states) {
    const stateEdges: readonly (readonly [string, string])[] = stateOrder.get(state.id) ?? [];
    for (const edge of stateEdges) {
      const before: number | undefined = orderPositions.get(edge[0]);
      const after: number | undefined = orderPositions.get(edge[1]);
      if (before === undefined || after === undefined || before >= after) {
        addIssue(
          issues,
          'ORDER',
          `global order violates ${JSON.stringify(edge[0])} before ${JSON.stringify(edge[1])}`,
          state.id,
        );
      }
    }
  }

  if (result.K !== basis.length || result.classCount !== basis.length) {
    addIssue(issues, 'CANONICAL', 'reported K/classCount does not equal basis length');
  }
  if (result.T !== assignmentCount || result.assignmentCount !== assignmentCount) {
    addIssue(issues, 'CANONICAL', 'reported T/assignmentCount does not equal assignment count');
  }
  if (
    result.lowerBound.K !== result.K ||
    result.lowerBound.T !== result.T ||
    result.upperBound.K !== result.K ||
    result.upperBound.T !== result.T ||
    result.optimality.status !== 'optimal'
  ) {
    addIssue(issues, 'CANONICAL', 'result does not report equal optimal K/T bounds');
  }

  const errors: readonly string[] = issues.map(
    (issue: ClassCoverVerificationIssue): string =>
      issue.stateId === undefined ? issue.message : `${issue.stateId}: ${issue.message}`,
  );
  const ok: boolean = issues.length === 0;
  return {
    ok,
    valid: ok,
    issues,
    errors,
    declarationOccurrences: occurrenceMap,
  };
}

/** Short alias used by callers that name the module's operation `verifyCover`. */
export function verifyCover(
  states: readonly ClassCoverState[],
  result: ClassCoverResult,
): ClassCoverVerification {
  return verifyClassCover(states, result);
}

/** Throw a regular Error when an independently verified result is invalid. */
export function assertClassCover(
  states: readonly ClassCoverState[],
  result: ClassCoverResult,
): void {
  const verification: ClassCoverVerification = verifyClassCover(states, result);
  if (!verification.ok) {
    throw new Error(`invalid class cover: ${verification.errors.join('; ')}`);
  }
}
