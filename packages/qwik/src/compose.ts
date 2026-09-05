import type { ResidualRuleNode, StaticAtom } from '@qstyle/core';
import { lowerStyleObject } from './object.js';
import type { Diagnostic } from './object.js';
import type { CssProp, StyleHandle, StyleObject } from './index.js';

export interface ComposedStyle {
  readonly atoms: StaticAtom[];
  readonly residuals: ResidualRuleNode[];
  readonly diagnostics: Diagnostic[];
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
function conflictKey(atom: StaticAtom): string {
  return JSON.stringify([atom.property, atom.context, atom.important]);
}

function semanticKey(atom: StaticAtom): string {
  return JSON.stringify([
    atom.property,
    atom.value,
    atom.important,
    atom.context,
  ]);
}

/**
 * css prop 配列を単一の Style IR 寄与へ composition する (plan.md §21)。
 * 同一 conflict key は後勝ち (earlier を除去して末尾へ移動) し、
 * 完全同一 semantic は dedup する。
 */
export function composeCssProp(
  prop: CssProp,
  opts: { readonly source?: string | undefined } = {},
): ComposedStyle {
  const atoms: StaticAtom[] = [];
  const residuals: ResidualRuleNode[] = [];
  const diagnostics: Diagnostic[] = [];
  // conflictKey -> atoms 内 index。semantic 重複はスキップする。
  const positions = new Map<string, number>();
  const seenSemantics = new Set<string>();

  for (const part of flattenCssProp(prop)) {
    const lowered = isStyleHandle(part)
      ? {
          atoms: part.atoms,
          residuals: part.residuals,
          diagnostics: [] as Diagnostic[],
        }
      : lowerStyleObject(part, opts);
    const partAtoms: readonly StaticAtom[] = lowered.atoms;
    const partResiduals: readonly ResidualRuleNode[] = lowered.residuals;
    const partDiagnostics: readonly Diagnostic[] = lowered.diagnostics;
    for (const residual of partResiduals) residuals.push(residual);
    for (const diagnostic of partDiagnostics) diagnostics.push(diagnostic);

    for (const atom of partAtoms) {
      const sem: string = semanticKey(atom);
      if (seenSemantics.has(sem)) continue;
      seenSemantics.add(sem);
      const key: string = conflictKey(atom);
      const existing: number | undefined = positions.get(key);
      if (existing === undefined) {
        positions.set(key, atoms.length);
        atoms.push(atom);
      } else {
        // 後勝ち: 旧位置を除去して末尾へ。
        atoms.splice(existing, 1);
        positions.clear();
        atoms.forEach((a, i) => positions.set(conflictKey(a), i));
        positions.set(key, atoms.length);
        atoms.push(atom);
      }
    }
  }
  return { atoms, residuals, diagnostics };
}
