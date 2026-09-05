import type { OrderingConstraints, Provenance, RuleContext, StaticAtom } from './ir.js';

/** プロパティ名を canonical kebab-case へ (Milestone 1 で fixture 化する)。 */
export function canonicalProperty(input: string): string {
  const kebab = input.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  return kebab.startsWith('--') ? input : kebab.toLowerCase();
}

/** 値の最小 canonicalization: 前後空白の除去 + 内部連続空白の単一化。 */
export function canonicalValue(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

export interface CreateStaticAtomInput {
  readonly property: string;
  readonly value: string;
  readonly important?: boolean | undefined;
  readonly context?: RuleContext | undefined;
  readonly ordering?: OrderingConstraints | undefined;
  readonly provenance?: readonly Provenance[] | undefined;
}

export function createStaticAtom(input: CreateStaticAtomInput): StaticAtom {
  return {
    kind: 'static-atom',
    property: canonicalProperty(input.property),
    value: canonicalValue(input.value),
    important: input.important ?? false,
    context: input.context ?? {},
    ordering: input.ordering ?? {},
    provenance: input.provenance ?? [],
  };
}

/**
 * Semantic hash (plan.md §43 の最小版)。
 * chunk membership を含めない。FNV-1a 32bit → 8桁hex。
 * Milestone 1/6 で canonical template / ordering semantics を含める。
 */
export function hashStaticAtom(atom: StaticAtom): string {
  const payload = JSON.stringify([
    atom.property,
    atom.value,
    atom.important,
    atom.context,
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `q_${(h >>> 0).toString(16).padStart(8, '0')}`;
}
