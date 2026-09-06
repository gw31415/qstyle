import type { OrderingConstraints, Provenance, RuleContext, StaticAtom } from './ir.js';
import { serializeCssValue } from './units.js';

/** プロパティ名を canonical kebab-case へ (Milestone 1 で fixture 化する)。 */
export function canonicalProperty(input: string): string {
  if (input.startsWith('--')) return input;
  const kebab = input.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  // `ms` は唯一小文字始まりの vendor prefix (`msTransform` -> `-ms-transform`)。
  // React の hyphenateStyleName と同一規則 (OBJ-004)。
  return kebab.startsWith('ms-') ? `-${kebab}` : kebab;
}

/** 値の最小 canonicalization: 前後空白の除去 + 内部連続空白の単一化。 */
export function canonicalValue(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

export interface CreateStaticAtomInput {
  readonly property: string;
  readonly value: string | number;
  readonly important?: boolean | undefined;
  readonly context?: RuleContext | undefined;
  readonly ordering?: OrderingConstraints | undefined;
  readonly provenance?: readonly Provenance[] | undefined;
}

export function createStaticAtom(input: CreateStaticAtomInput): StaticAtom {
  return {
    kind: 'static-atom',
    property: canonicalProperty(input.property),
    value: serializeCssValue(input.property, input.value),
    important: input.important ?? false,
    context: input.context ?? {},
    ordering: input.ordering ?? {},
    provenance: input.provenance ?? [],
  };
}

/**
 * Semantic hash (plan.md §43)。
 * canonical property / value・important・selector/conditional context・ordering semantics を含める。
 * chunk membership は含めない (style identity と delivery identity の分離, §3.3)。
 * FNV-1a 32bit → 8桁hex。
 */
export function hashStaticAtom(atom: StaticAtom): string {
  return `q_${fnv1aHex(
    JSON.stringify([
      atom.property,
      atom.value,
      atom.important,
      atom.context,
      atom.ordering,
    ]),
  )}`;
}

/** FNV-1a 32bit → 8桁hex。parametric 側と共有する。 */
export function fnv1aHex(payload: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * class に対する完全セレクタ列。suffix のカンマ区切りは各要素に class を付与する
 * (`.h:hover, .h:focus`)。単一時は従来と同一文字列になる。
 */
export function classSelectors(className: string, context: RuleContext): string[] {
  const base: string = `.${className}${(context.pseudo ?? []).join('')}`;
  const tail: string = `${context.descendant !== undefined ? ` ${context.descendant}` : ''}${context.suffix ?? ''}`;
  if (tail === '') return [base];
  return tail.split(',').map((part) => `${base}${part}`);
}

/**
 * context の at-rule wrapper (supports → container → media → layer、外側ほど広域)。
 * layer なしの従来 context では従来と同一文字列になる。
 */
export function wrapContextAtRules(selectors: readonly string[], context: RuleContext, body: string): string {
  let rule: string = `${selectors.join(',')}{${body}}`;
  if (context.supports !== undefined) {
    rule = `@supports ${context.supports}{${rule}}`;
  }
  if (context.container !== undefined) {
    rule = `@container ${context.container}{${rule}}`;
  }
  if (context.media !== undefined) {
    rule = `@media ${context.media}{${rule}}`;
  }
  if (context.layer !== undefined) {
    rule = `@layer${context.layer === '' ? '' : ` ${context.layer}`}{${rule}}`;
  }
  return rule;
}
