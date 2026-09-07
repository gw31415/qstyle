// Safety analysis for safe declaration atomicization (plan.md §17, §18, §93).
// CSS-* / DED-013 / FLB-010: 判定できないものは residual に落とし、決して黙って並び替えない。
import {
  canonicalProperty,
  fnv1aHex,
  isReservedCustomPropertyName,
  isValidCustomPropertyName,
  RESERVED_CUSTOM_PROPERTY_PREFIX,
  RESERVED_CUSTOM_PROPERTY_ROOT,
} from './atom.js';
import type { ResidualReason, StaticAtom } from './ir.js';

export {
  isReservedCustomPropertyName,
  isValidCustomPropertyName,
  RESERVED_CUSTOM_PROPERTY_PREFIX,
  RESERVED_CUSTOM_PROPERTY_ROOT,
} from './atom.js';

/**
 * canonical kebab-case shorthand -> 覆う longhand 一覧 (plan.md §17-2)。
 * 完全な CSS 仕様表ではなく、atomicization の ordering 判定に必要な範囲のみ。
 * `gap` / `grid-gap` は shorthand ではないため含めない。
 */
export const SHORTHAND_MAP: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  ['margin', ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']],
  ['padding', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']],
  ['border', ['border-width', 'border-style', 'border-color', 'border-image']],
  [
    'border-width',
    [
      'border-top-width',
      'border-right-width',
      'border-bottom-width',
      'border-left-width',
    ],
  ],
  [
    'border-style',
    [
      'border-top-style',
      'border-right-style',
      'border-bottom-style',
      'border-left-style',
    ],
  ],
  [
    'border-color',
    [
      'border-top-color',
      'border-right-color',
      'border-bottom-color',
      'border-left-color',
    ],
  ],
  ['border-top', ['border-top-width', 'border-top-style', 'border-top-color']],
  ['border-right', ['border-right-width', 'border-right-style', 'border-right-color']],
  [
    'border-bottom',
    ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  ],
  ['border-left', ['border-left-width', 'border-left-style', 'border-left-color']],
  [
    'border-radius',
    [
      'border-top-left-radius',
      'border-top-right-radius',
      'border-bottom-right-radius',
      'border-bottom-left-radius',
    ],
  ],
  [
    'font',
    [
      'font-style',
      'font-variant',
      'font-weight',
      'font-stretch',
      'font-size',
      'line-height',
      'font-family',
      'font-size-adjust',
    ],
  ],
  [
    'background',
    [
      'background-color',
      'background-image',
      'background-position',
      'background-size',
      'background-repeat',
      'background-origin',
      'background-clip',
      'background-attachment',
    ],
  ],
  ['outline', ['outline-width', 'outline-style', 'outline-color']],
  ['list-style', ['list-style-type', 'list-style-position', 'list-style-image']],
  ['overflow', ['overflow-x', 'overflow-y']],
  ['overscroll-behavior', ['overscroll-behavior-x', 'overscroll-behavior-y']],
  ['inset', ['top', 'right', 'bottom', 'left']],
  ['flex', ['flex-grow', 'flex-shrink', 'flex-basis']],
  ['flex-flow', ['flex-direction', 'flex-wrap']],
  [
    'transition',
    [
      'transition-property',
      'transition-duration',
      'transition-timing-function',
      'transition-delay',
    ],
  ],
  [
    'animation',
    [
      'animation-name',
      'animation-duration',
      'animation-timing-function',
      'animation-delay',
      'animation-iteration-count',
      'animation-direction',
      'animation-fill-mode',
      'animation-play-state',
    ],
  ],
  ['place-content', ['align-content', 'justify-content']],
  ['place-items', ['align-items', 'justify-items']],
  ['place-self', ['align-self', 'justify-self']],
  [
    'text-decoration',
    [
      'text-decoration-line',
      'text-decoration-style',
      'text-decoration-color',
      'text-decoration-thickness',
    ],
  ],
  [
    'mask',
    [
      'mask-image',
      'mask-position',
      'mask-size',
      'mask-repeat',
      'mask-origin',
      'mask-clip',
      'mask-composite',
      'mask-mode',
    ],
  ],
]);

/** property を canonical 化してから shorthand が覆う longhand を返す (なければ空配列)。 */
export function longhandsOf(property: string): readonly string[] {
  return SHORTHAND_MAP.get(canonicalProperty(property)) ?? [];
}

/** canonical 化した property が shorthand かどうか。 */
export function isShorthand(property: string): boolean {
  return SHORTHAND_MAP.has(canonicalProperty(property));
}

/** expand(p) = 自身 + 覆う longhand。共通要素があれば並び替えの危険がある。 */
function expansion(property: string): ReadonlySet<string> {
  return new Set<string>([property, ...longhandsOf(property)]);
}

/**
 * logical / physical 対応の axis group (plan.md §18, CSS-003)。
 * `margin-inline-start` と `margin-left` のように shorthand 展開では検出できない競合。
 * key は `<base>#<axis>`。
 */
const LOGICAL_BASES: readonly {
  readonly base: string;
  readonly inline: readonly string[];
  readonly block: readonly string[];
}[] = [
  {
    base: 'margin',
    inline: ['margin-left', 'margin-right', 'margin-inline-start', 'margin-inline-end'],
    block: ['margin-top', 'margin-bottom', 'margin-block-start', 'margin-block-end'],
  },
  {
    base: 'padding',
    inline: ['padding-left', 'padding-right', 'padding-inline-start', 'padding-inline-end'],
    block: ['padding-top', 'padding-bottom', 'padding-block-start', 'padding-block-end'],
  },
  {
    base: 'inset',
    inline: ['left', 'right', 'inset-inline-start', 'inset-inline-end'],
    block: ['top', 'bottom', 'inset-block-start', 'inset-block-end'],
  },
  {
    base: 'border-width',
    inline: [
      'border-left-width',
      'border-right-width',
      'border-inline-start-width',
      'border-inline-end-width',
    ],
    block: [
      'border-top-width',
      'border-bottom-width',
      'border-block-start-width',
      'border-block-end-width',
    ],
  },
  {
    base: 'border-style',
    inline: [
      'border-left-style',
      'border-right-style',
      'border-inline-start-style',
      'border-inline-end-style',
    ],
    block: [
      'border-top-style',
      'border-bottom-style',
      'border-block-start-style',
      'border-block-end-style',
    ],
  },
  {
    base: 'border-color',
    inline: [
      'border-left-color',
      'border-right-color',
      'border-inline-start-color',
      'border-inline-end-color',
    ],
    block: [
      'border-top-color',
      'border-bottom-color',
      'border-block-start-color',
      'border-block-end-color',
    ],
  },
];

const LOGICAL_AXES: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const entry of LOGICAL_BASES) {
    const inlineGroup: string = `${entry.base}#inline`;
    const blockGroup: string = `${entry.base}#block`;
    for (const prop of entry.inline) map.set(prop, inlineGroup);
    for (const prop of entry.block) map.set(prop, blockGroup);
  }
  return map;
})();

/** 共通の shorthand 祖先 (例: margin-top と margin-left は margin を共有) を持つか。 */
function sharesShorthandAncestor(a: string, b: string): boolean {
  for (const longhands of SHORTHAND_MAP.values()) {
    if (longhands.includes(a) && longhands.includes(b)) return true;
  }
  return false;
}

function logicalAxisConflict(a: string, b: string): boolean {
  const ga: string | undefined = LOGICAL_AXES.get(a);
  if (ga === undefined) return false;
  return LOGICAL_AXES.get(b) === ga;
}

/**
 * a と b を独立に atomicize すると並び替え bug の危険があるか (plan.md §18)。
 * 同一 property / shorthand と longhand / shorthand 祖先共有 / 同一 logical axis で true。
 * custom property は var 解決経由で参照され atomic-safe passthrough とし、group 対象外。
 */
export function needsOrderingGroup(a: string, b: string): boolean {
  const pa: string = canonicalProperty(a);
  const pb: string = canonicalProperty(b);
  if (pa.startsWith('--') || pb.startsWith('--')) return false;
  if (pa === pb) return true;
  for (const la of expansion(pa)) {
    if (expansion(pb).has(la)) return true;
  }
  if (sharesShorthandAncestor(pa, pb)) return true;
  return logicalAxisConflict(pa, pb);
}

/** ordering.group id の対象を決める member key (property / value / important / context)。 */
function memberKey(atom: StaticAtom): string {
  return JSON.stringify([atom.property, atom.value, atom.important, atom.context]);
}

/** noUncheckedIndexedAccess 対応: 範囲外 index は呼び出し側 bug として失敗させる。 */
function atomAt(atoms: readonly StaticAtom[], index: number): StaticAtom {
  const atom: StaticAtom | undefined = atoms[index];
  if (atom === undefined) throw new Error(`assignOrderingGroups: missing atom ${index}`);
  return atom;
}

/**
 * pairwise で needsOrderingGroup になる atom 同士を 1 つの ordering group にまとめる。
 * group id は member key の fnv1aHex 6 桁 (`og_<hash6>`) で決定的。入力順は保持し、
 * 独立な atom の ordering はそのまま (group なし)。
 */
export function assignOrderingGroups(atoms: readonly StaticAtom[]): StaticAtom[] {
  const parent = new Map<number, number>();
  for (let i = 0; i < atoms.length; i += 1) parent.set(i, i);

  const find = (start: number): number => {
    let root: number = start;
    for (;;) {
      const up: number | undefined = parent.get(root);
      if (up === undefined || up === root) break;
      root = up;
    }
    let cursor: number | undefined = start;
    while (cursor !== undefined && cursor !== root) {
      const next: number | undefined = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  for (let i = 0; i < atoms.length; i += 1) {
    for (let j = i + 1; j < atoms.length; j += 1) {
      if (!needsOrderingGroup(atomAt(atoms, i).property, atomAt(atoms, j).property)) continue;
      const ri: number = find(i);
      const rj: number = find(j);
      if (ri !== rj) parent.set(Math.max(ri, rj), Math.min(ri, rj));
    }
  }

  const members = new Map<number, number[]>();
  for (let i = 0; i < atoms.length; i += 1) {
    const root: number = find(i);
    const list: number[] | undefined = members.get(root);
    if (list === undefined) members.set(root, [i]);
    else list.push(i);
  }

  const groupOf = new Map<number, string>();
  for (const list of members.values()) {
    if (list.length < 2) continue;
    const keys: readonly string[] = list.map((i) => memberKey(atomAt(atoms, i))).sort();
    const id: string = `og_${fnv1aHex(keys.join(' ')).slice(0, 6)}`;
    for (const i of list) groupOf.set(i, id);
  }

  return atoms.map((atom, i) => {
    const group: string | undefined = groupOf.get(i);
    if (group === undefined || atom.ordering.group === group) return atom;
    return { ...atom, ordering: { ...atom.ordering, group } };
  });
}

const PROPERTY_RE = /^[a-z-][a-z0-9-]*$/;

/**
 * custom property 名の保守的 ASCII grammar (release blocker 2)。
 * `--` + ident (先頭は英字または `_`) に限定し、declaration / rule 境界を壊す
 * 文字 (`}` `;` `{` `<` quote 等) や escape・non-ASCII を持つ名前は入力時点で
 * 拒否する。既存の有効名 (`--brand-color` / `--my-Var` / `--a-b_c` 等) は維持する。
 * escape (`\30 `) と non-ASCII 名の拒否は意図的なもので、docs/css.md に記載する。
 */
const FORBIDDEN_VALUE_RE = /expression\(|url\(\s*javascript:/i;
const FORBIDDEN_PROPERTIES: ReadonlySet<string> = new Set<string>(['behavior', '-moz-binding']);
const URL_OPEN_RE = /^url\(/i;

/** `"` / `'` で始まる quoted string の閉じ位置 (exclusive)。escape は 2 文字消費。 */
function skipQuotedValue(text: string, start: number): number {
  const quote: string = text[start] ?? '';
  let i: number = start + 1;
  while (i < text.length) {
    const ch: string = text[i] ?? '';
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return -1;
}

/**
 * declaration value / var() fallback 中に、quoted string・url() token の外側で
 * declaration / rule 境界を壊す文字 (`<` `>` `;` `{` `}`) が出現するか
 * (OBJ-023 / DYN-019)。unterminated quote / url も invalid とする。
 */
export function hasInvalidDeclarationChars(value: string): boolean {
  let i = 0;
  while (i < value.length) {
    const ch: string = value[i] ?? '';
    if (ch === '"' || ch === "'") {
      const end: number = skipQuotedValue(value, i);
      if (end < 0) return true;
      i = end;
      continue;
    }
    if (ch === '\\') {
      // unquoted context の backslash は escape。次の 1 文字を消費する。
      i += 2;
      continue;
    }
    if ((ch === 'u' || ch === 'U') && URL_OPEN_RE.test(value.slice(i))) {
      const close: number = value.indexOf(')', i);
      if (close < 0) return true;
      i = close + 1;
      continue;
    }
    if (ch === '<' || ch === '>' || ch === ';' || ch === '{' || ch === '}') return true;
    i += 1;
  }
  return false;
}

/**
 * declaration が安全に atomicize 可能か判定する (plan.md §17, FLB-010)。
 * 証明できない場合は residual を返し、best-effort rewrite はしない。
 * `!important` suffix は upstream で分割済みのため、ここでは扱わない。
 */
export function classifyDeclaration(
  property: string,
  value: string,
): 'atomic' | { residual: ResidualReason } {
  if (property.length === 0 || value.trim().length === 0) return { residual: 'unsupported-syntax' };
  // 大文字 / 空白を含む property は canonical 化せず residual (曖昧な寄せを実装しない)。
  // custom property (`--*`) のみ case-sensitive な名前をそのまま許す
  // (名前の検証は共有 validator に一元化する。release blocker 2)。
  if (property.startsWith('--')) {
    if (!isValidCustomPropertyName(property)) return { residual: 'unsupported-syntax' };
  } else {
    if (!PROPERTY_RE.test(property)) return { residual: 'unsupported-syntax' };
  }
  if (FORBIDDEN_PROPERTIES.has(property)) return { residual: 'unsupported-syntax' };
  if (FORBIDDEN_VALUE_RE.test(value)) return { residual: 'unsupported-syntax' };
  if (hasInvalidDeclarationChars(value)) return { residual: 'unsupported-syntax' };
  return 'atomic';
}
