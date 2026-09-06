import { canonicalProperty, classSelectors, fnv1aHex, wrapContextAtRules } from './atom.js';
import { hasInvalidDeclarationChars } from './safety.js';
import type {
  OrderingConstraints,
  ParametricAtom,
  Provenance,
  RuleContext,
  RuntimeSlotNode,
  RuntimeValueType,
  ValueTemplatePart,
} from './ir.js';

export type TemplateSlotInput = {
  readonly valueType: RuntimeValueType;
  readonly fallback?: string | undefined;
};

export type TemplatePartInput =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'slot'; readonly slotIndex: number };

export interface CreateParametricAtomInput {
  readonly property: string;
  readonly parts: readonly TemplatePartInput[];
  readonly slots: readonly TemplateSlotInput[];
  readonly important?: boolean | undefined;
  readonly context?: RuleContext | undefined;
  readonly ordering?: OrderingConstraints | undefined;
  readonly provenance?: readonly Provenance[] | undefined;
}

/** text 断片の正規化: 内部連続空白の単一化 (端空白は保つ)。 */
function normalizeFragment(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function structureOf(
  property: string,
  parts: readonly TemplatePartInput[],
  slots: readonly TemplateSlotInput[],
  important: boolean,
  context: RuleContext,
  ordering: OrderingConstraints,
): unknown {
  return [
    'parametric-atom',
    property,
    parts.map((p) =>
      p.kind === 'text'
        ? ['t', normalizeFragment(p.text)]
        : ['s', slots[p.slotIndex]?.valueType ?? 'custom'],
    ),
    important,
    context,
    ordering,
  ];
}

/**
 * ParametricAtom を生成する (plan.md §11, §29)。
 * slot id は構造 hash から決定的に割り当てる (`--qstyle-<hash6>-<i>`)。
 * `--qstyle-` prefix は予約語とし、user 定義との衝突を避ける (DYN-024)。
 * 実際の runtime 値は保持せず hash にも含めない。
 */
export function createParametricAtom(input: CreateParametricAtomInput): ParametricAtom {
  const property: string = canonicalProperty(input.property);
  const important: boolean = input.important ?? false;
  const context: RuleContext = input.context ?? {};
  const ordering: OrderingConstraints = input.ordering ?? {};
  const provenance: readonly Provenance[] = input.provenance ?? [];

  if (input.slots.length === 0) {
    throw new Error('createParametricAtom: at least one slot is required');
  }
  for (const slot of input.slots) {
    // fallback は var() の第 2 引数として CSS text に直接現れるため、
    // declaration 境界を壊す文字列は受理しない (DYN-019)。
    if (slot.fallback !== undefined && hasInvalidDeclarationChars(slot.fallback)) {
      throw new Error(
        `createParametricAtom: fallback ${JSON.stringify(slot.fallback)} contains characters that would break the declaration boundary`,
      );
    }
  }
  for (const part of input.parts) {
    if (part.kind === 'slot') {
      if (!Number.isInteger(part.slotIndex) || part.slotIndex < 0 || part.slotIndex >= input.slots.length) {
        throw new Error(
          `createParametricAtom: slotIndex ${part.slotIndex} out of range (slots: ${input.slots.length})`,
        );
      }
    }
  }

  const hash: string = fnv1aHex(
    JSON.stringify(structureOf(property, input.parts, input.slots, important, context, ordering)),
  );
  const slots: RuntimeSlotNode[] = input.slots.map((s, i) => ({
    kind: 'runtime-slot' as const,
    id: `--qstyle-${hash.slice(0, 6)}-${i}`,
    valueType: s.valueType,
    ...(s.fallback === undefined ? {} : { fallback: s.fallback }),
  }));
  const valueTemplate: ValueTemplatePart[] = input.parts.map((p) =>
    p.kind === 'text'
      ? { kind: 'text' as const, text: normalizeFragment(p.text) }
      : { kind: 'slot' as const, slotIndex: p.slotIndex },
  );
  return {
    kind: 'parametric-atom',
    property,
    valueTemplate,
    slots,
    important,
    context,
    ordering,
    provenance,
  };
}

/**
 * ParametricAtom の semantic hash (plan.md §43)。
 * 構造・型・context のみを含み、slot id や実際の値は含めない。
 */
export function hashParametricAtom(atom: ParametricAtom): string {
  return `q_${fnv1aHex(
    JSON.stringify(
      structureOf(
        atom.property,
        atom.valueTemplate,
        atom.slots.map((s) => ({ valueType: s.valueType })),
        atom.important,
        atom.context,
        atom.ordering,
      ),
    ),
  )}`;
}

/**
 * ParametricAtom を CSS rule へ serialize する。
 * slot は `var(--id[, fallback])` 参照になる。
 */
export function serializeParametricCss(atom: ParametricAtom, className: string): string {
  return wrapParametricRule(className, atom.context, serializeParametricDecl(atom));
}

/** declaration 部分のみ (unit merge 用)。slot は `var(--id[, fallback])` 参照。 */
export function serializeParametricDecl(atom: ParametricAtom): string {
  const byIndex = new Map<number, RuntimeSlotNode>();
  atom.slots.forEach((s, i) => byIndex.set(i, s));
  const value: string = atom.valueTemplate
    .map((p) => {
      if (p.kind === 'text') return p.text;
      const slot: RuntimeSlotNode | undefined = byIndex.get(p.slotIndex);
      if (slot === undefined) {
        throw new Error(`serializeParametricDecl: missing slot ${p.slotIndex}`);
      }
      return slot.fallback === undefined
        ? `var(${slot.id})`
        : `var(${slot.id}, ${slot.fallback})`;
    })
    .join('');
  return `${atom.property}:${value}${atom.important ? '!important' : ''}`;
}

function wrapParametricRule(className: string, context: RuleContext, decl: string): string {
  return wrapContextAtRules(classSelectors(className, context), context, decl);
}

const LENGTH_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(px|em|rem|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pt|pc|lh|rlh|cap|ic|vi|vb|cqw|cqh|cqi|cqb|cqmin|cqmax)$/i;
const PERCENT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)%$/;
const ANGLE_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(deg|rad|grad|turn)$/i;
const TIME_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(ms|s)$/i;
const INTEGER_RE = /^[+-]?\d+$/;

/**
 * 既知の runtime 値から slot 型を推測する (best-effort)。
 * 不明なものは 'custom' になる。identity には型のみが使われる。
 */
export function inferSlotType(value: unknown): RuntimeValueType {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  if (typeof value !== 'string') return 'custom';
  const v: string = value.trim();
  if (INTEGER_RE.test(v)) return 'integer';
  if (LENGTH_RE.test(v)) return 'length';
  if (PERCENT_RE.test(v)) return 'percentage';
  if (ANGLE_RE.test(v)) return 'angle';
  if (TIME_RE.test(v)) return 'time';
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return 'color';
  if (/^(?:rgb|hsl)a?\(/i.test(v)) return 'color';
  return 'custom';
}
