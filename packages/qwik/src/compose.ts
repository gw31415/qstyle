import type { AnyAtom, GlobalAtRule, KeyframesRule, ParametricAtom, ResidualRuleNode } from '@qstyle/core';
import { lowerStyleObject } from './object.js';
import type { Diagnostic } from './object.js';
import type { CssProp, StyleHandle, StyleObject } from './index.js';

export interface ComposedStyle {
  readonly atoms: AnyAtom[];
  /** 最終的に残った ParametricAtom (atoms の subset、出現順)。 */
  readonly parametrics: ParametricAtom[];
  readonly residuals: ResidualRuleNode[];
  readonly diagnostics: Diagnostic[];
  readonly keyframes: KeyframesRule[];
  readonly globals: GlobalAtRule[];
}

export function isStyleHandle(value: unknown): value is StyleHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __qstyleBrand?: unknown }).__qstyleBrand === 'StyleHandle'
  );
}

/**
 * CssProp を左→右の順序を保ったまま flatten する (plan.md §21.1)。
 * falsy 値 (false/null/undefined) は無視し、nested array を展開する。
 */
export function flattenCssProp(prop: CssProp): Array<StyleObject | StyleHandle> {
  const out: Array<StyleObject | StyleHandle> = [];
  const walk = (p: CssProp): void => {
    if (p === false || p === null || p === undefined) return;
    if (isCssPropArray(p)) {
      for (const entry of p) walk(entry);
      return;
    }
    out.push(p);
  };
  walk(prop);
  return out;
}

function isCssPropArray(p: CssProp): p is readonly CssProp[] {
  return Array.isArray(p);
}

/**
 * composition 上の競合キー。property + context + important が一致すれば
 * 後の contribution が勝つ (class 文字列順序には依存させない。plan.md §112)。
 */
function conflictKey(atom: AnyAtom): string {
  return JSON.stringify([atom.property, atom.context, atom.important]);
}

/**
 * semantic 重複判定キー。static は value、parametric は value template と
 * slot 型で同一性を判定する (実際の runtime 値は含まない)。
 */
function semanticKey(atom: AnyAtom): string {
  if (atom.kind === 'parametric-atom') {
    return JSON.stringify([
      atom.property,
      atom.valueTemplate,
      atom.slots.map((slot) => slot.valueType),
      atom.important,
      atom.context,
    ]);
  }
  return JSON.stringify([atom.property, atom.value, atom.important, atom.context]);
}

/**
 * css prop 配列を単一の Style IR 寄与へ composition する (plan.md §21)。
 * 同一 conflict key は後勝ち (earlier を除去して末尾へ移動) し、
 * 完全同一 semantic は dedup する。
 */
export function composeCssProp(
  prop: CssProp,
  opts: { readonly source?: string | undefined; readonly keyframes?: ReadonlyMap<string, string> | undefined } = {},
): ComposedStyle {
  const atoms: AnyAtom[] = [];
  const residuals: ResidualRuleNode[] = [];
  const diagnostics: Diagnostic[] = [];
  const keyframes: KeyframesRule[] = [];
  const globals: GlobalAtRule[] = [];
  const seenKeyframes = new Set<string>();
  const seenGlobals = new Set<string>();
  const pushKeyframes = (rules: readonly KeyframesRule[]): void => {
    for (const rule of rules) {
      if (seenKeyframes.has(rule.name)) continue;
      seenKeyframes.add(rule.name);
      keyframes.push(rule);
    }
  };
  const pushGlobals = (rules: readonly GlobalAtRule[]): void => {
    for (const rule of rules) {
      if (seenGlobals.has(rule.id)) continue;
      seenGlobals.add(rule.id);
      globals.push(rule);
    }
  };
  // conflictKey -> atoms 内 index。semantic 重複はスキップする。
  const positions = new Map<string, number>();
  const seenSemantics = new Set<string>();

  for (const part of flattenCssProp(prop)) {
    const lowered = isStyleHandle(part)
      ? {
          // handle は静的 atom と parametric の両方を寄与する。
          atoms: part.atoms,
          parametrics: part.parametrics,
          residuals: part.residuals,
          diagnostics: [] as Diagnostic[],
          keyframes: part.keyframes,
          globals: part.globals,
        }
      : { ...lowerStyleObject(part, opts), parametrics: [] as readonly ParametricAtom[] };
    const partAtoms: readonly AnyAtom[] = lowered.atoms;
    const partResiduals: readonly ResidualRuleNode[] = lowered.residuals;
    const partDiagnostics: readonly Diagnostic[] = lowered.diagnostics;
    for (const residual of partResiduals) residuals.push(residual);
    for (const diagnostic of partDiagnostics) diagnostics.push(diagnostic);
    pushKeyframes(lowered.keyframes);
    pushGlobals(lowered.globals);

    for (const atom of [...lowered.parametrics, ...partAtoms]) {
      const sem: string = semanticKey(atom);
      if (seenSemantics.has(sem)) continue;
      seenSemantics.add(sem);
      const key: string = conflictKey(atom);
      const existing: number | undefined = positions.get(key);
      if (existing === undefined) {
        positions.set(key, atoms.length);
        atoms.push(atom);
      } else {
        // 後勝ち: 旧位置を除去して末尾へ (kind を問わない)。
        atoms.splice(existing, 1);
        positions.clear();
        atoms.forEach((a, i) => positions.set(conflictKey(a), i));
        positions.set(key, atoms.length);
        atoms.push(atom);
      }
    }
  }
  const parametrics: ParametricAtom[] = atoms.filter(
    (a): a is ParametricAtom => a.kind === 'parametric-atom',
  );
  return { atoms, parametrics, residuals, diagnostics, keyframes, globals };
}
