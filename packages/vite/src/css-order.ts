import { collectRules, parseDecls, parseQSelector, propertyOf } from './css-syntax.js';
import type { DedupMeta, ParsedRule, QSelectorInfo } from './css-syntax.js';

export type DeclarationOrder = 'source' | 'alphabetical' | 'frequency';
export type RuleOrder = 'source' | 'body' | 'properties' | 'similarity';

// A closed set, deliberately coarser than individual longhands. Unknown/new
// properties are barriers, not assumed independent. Within a reset/alias family
// the source order always wins (e.g. font/line-height, border/border-image).
const DOMAINS: Readonly<Record<string, readonly string[]>> = {
  color: ['color'],
  background: ['background', 'background-color', 'background-image', 'background-position',
    'background-size', 'background-repeat', 'background-origin', 'background-clip', 'background-attachment'],
  font: ['font', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch',
    'font-variant', 'font-size-adjust', 'font-kerning', 'font-feature-settings', 'font-variation-settings', 'line-height'],
  border: ['border', 'border-width', 'border-style', 'border-color', 'border-radius', 'border-image',
    'border-top', 'border-right', 'border-bottom', 'border-left',
    ...['top', 'right', 'bottom', 'left'].flatMap((side) => ['width', 'style', 'color'].map((part) => `border-${side}-${part}`)),
    ...['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((corner) => `border-${corner}-radius`)],
  margin: ['margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-inline', 'margin-block',
    'margin-inline-start', 'margin-inline-end', 'margin-block-start', 'margin-block-end'],
  padding: ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-inline', 'padding-block',
    'padding-inline-start', 'padding-inline-end', 'padding-block-start', 'padding-block-end'],
  size: ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'inline-size', 'block-size', 'min-inline-size', 'min-block-size', 'max-inline-size', 'max-block-size'],
  inset: ['inset', 'top', 'right', 'bottom', 'left', 'inset-inline', 'inset-block',
    'inset-inline-start', 'inset-inline-end', 'inset-block-start', 'inset-block-end'],
  flex: ['flex', 'flex-grow', 'flex-shrink', 'flex-basis', 'flex-flow', 'flex-direction', 'flex-wrap'],
  grid: ['grid', 'grid-template', 'grid-template-columns', 'grid-template-rows', 'grid-template-areas',
    'grid-auto-columns', 'grid-auto-rows', 'grid-auto-flow', 'grid-area', 'grid-column', 'grid-row',
    'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end', 'gap', 'row-gap', 'column-gap', 'grid-gap'],
  alignment: ['place-content', 'place-items', 'place-self', 'align-content', 'align-items', 'align-self',
    'justify-content', 'justify-items', 'justify-self'],
  outline: ['outline', 'outline-color', 'outline-style', 'outline-width', 'outline-offset'],
  overflow: ['overflow', 'overflow-x', 'overflow-y'],
  text: ['text-align', 'text-align-last', 'text-decoration', 'text-decoration-line', 'text-decoration-style',
    'text-decoration-color', 'text-decoration-thickness', 'text-transform', 'text-indent', 'text-shadow',
    'text-overflow', 'letter-spacing', 'word-spacing', 'white-space', 'word-break', 'overflow-wrap'],
  transition: ['transition', 'transition-property', 'transition-duration', 'transition-delay', 'transition-timing-function'],
  animation: ['animation', 'animation-name', 'animation-duration', 'animation-delay', 'animation-timing-function',
    'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state'],
};
const DOMAIN_OF = new Map(Object.entries(DOMAINS).flatMap(([domain, properties]) => properties.map((p) => [p, domain])));
// These named physical longhands have distinct effects even within their family.
// Resetting shorthands and logical aliases are deliberately absent.
const INDEPENDENT_LONGHANDS = new Set([
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-size-adjust',
  'font-kerning', 'font-feature-settings', 'font-variation-settings', 'line-height',
  'background-color', 'background-image', 'background-position', 'background-size',
  'background-repeat', 'background-origin', 'background-clip', 'background-attachment',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  ...['top', 'right', 'bottom', 'left'].flatMap((side) => [side, `margin-${side}`, `padding-${side}`]),
  'align-content', 'align-items', 'align-self', 'justify-content', 'justify-items', 'justify-self',
  'outline-color', 'outline-style', 'outline-width', 'outline-offset', 'overflow-x', 'overflow-y',
  'text-align', 'text-align-last', 'text-transform', 'text-indent', 'text-shadow', 'text-overflow',
  'letter-spacing', 'word-spacing', 'word-break', 'overflow-wrap',
  'flex-grow', 'flex-shrink', 'flex-basis', 'flex-direction', 'flex-wrap',
  'transition-property', 'transition-duration', 'transition-delay', 'transition-timing-function',
  'animation-name', 'animation-duration', 'animation-delay', 'animation-timing-function',
  'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state',
]);
for (const property of ['content', 'display', 'position', 'box-sizing', 'box-shadow', 'opacity', 'visibility',
  'z-index', 'cursor', 'pointer-events', 'user-select', 'object-fit', 'object-position', 'aspect-ratio',
  'transform', 'transform-origin', 'transform-style', 'filter', 'backdrop-filter', 'isolation']) {
  DOMAIN_OF.set(property, property);
}

/** Closed-world reset/alias test, also used when moving shared declarations. */
export function propertiesMayInteract(pa: string, pb: string): boolean {
  const x = DOMAIN_OF.get(pa); const y = DOMAIN_OF.get(pb);
  return x === undefined || y === undefined
    || (x === y && !(pa !== pb && INDEPENDENT_LONGHANDS.has(pa) && INDEPENDENT_LONGHANDS.has(pb)));
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Only choose among currently legal nodes; constraints are never heuristic. */
function topologicalOrder<T>(items: readonly T[], depends: (a: T, b: T) => boolean,
  compare: (a: T, b: T, previous: T | undefined) => number): T[] {
  const outgoing = items.map(() => [] as number[]);
  const degree = items.map(() => 0);
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    if (depends(items[i]!, items[j]!)) { outgoing[i]!.push(j); degree[j] = degree[j]! + 1; }
  }
  const ready = items.map((_, i) => i).filter((i) => degree[i] === 0);
  const result: T[] = [];
  while (ready.length > 0) {
    let best = 0;
    for (let i = 1; i < ready.length; i++) {
      if (compare(items[ready[i]!]!, items[ready[best]!]!, result.at(-1)) < 0) best = i;
    }
    const [index] = ready.splice(best, 1);
    result.push(items[index!]!);
    for (const next of outgoing[index!]!) {
      degree[next] = degree[next]! - 1;
      if (degree[next] === 0) ready.push(next);
    }
  }
  return result;
}

interface OrderedRule {
  readonly parsed: ParsedRule;
  readonly selectors: readonly QSelectorInfo[];
  readonly decls: readonly string[];
  readonly body: string;
  readonly text: string;
  readonly propertyKey: string;
}

/** Reorder generated CSS only; opaque syntax/conditional rules/wrappers are barriers. */
export function reorderCss(css: string, meta: DedupMeta, declarations: DeclarationOrder, rules: RuleOrder,
  propertyOrder?: readonly string[]): string {
  if (declarations === 'source' && rules === 'source') return css;
  if (css.length > 1_000_000) return css;
  const parsed: ParsedRule[] = [];
  try { collectRules(css, parsed); } catch { return css; }
  if (parsed.length > 3000) return css;
  const frequency = new Map<string, number>();
  const rank = new Map(propertyOrder?.map((property, index) => [property, index]));
  const declsByRule = new Map(parsed.map((rule) => [rule, [...parseDecls(rule.body).keys()]]));
  for (const decls of declsByRule.values()) for (const decl of decls) {
    const p = propertyOf(decl);
    frequency.set(p, (frequency.get(p) ?? 0) + 1);
  }
  const edits = new Map<ParsedRule, string>();
  let segment: OrderedRule[] = [];
  const flush = (): void => {
    if (segment.length === 0) return;
    const similarity = (a: OrderedRule, previous: OrderedRule | undefined): number => {
      if (!previous) return 0;
      let prefix = 0;
      while (prefix < Math.min(a.body.length, previous.body.length, 258) && a.body[prefix] === previous.body[prefix]) prefix++;
      return prefix + a.decls.reduce((score, d) => score + (previous.decls.includes(d) ? Buffer.byteLength(d) : 0), 0);
    };
    const output = rules === 'source' ? segment : topologicalOrder(segment,
      // Order only matters for selectors that may overlap at equal specificity.
      // Keep that relation as a hard edge, without assuming anything about new
      // properties, shorthands or !important values.
      (a, b) => a.selectors.some((x) => b.selectors.some((y) => {
        if (x.spec[0] !== y.spec[0] || x.spec[1] !== y.spec[1]) return false;
        if (!x.descendant && !y.descendant && x.cls !== y.cls) return false;
        if (x.descTag && y.descTag && x.descTag !== y.descTag) return false;
        return true;
      })),
      (a, b, previous) => {
        if (rules === 'similarity') {
          const diff = similarity(b, previous) - similarity(a, previous);
          if (diff !== 0) return diff;
        }
        if (rules === 'properties') {
          const diff = compareText(a.propertyKey, b.propertyKey);
          if (diff !== 0) return diff;
        }
        return compareText(a.body, b.body) || a.parsed.start - b.parsed.start;
      });
    for (let i = 0; i < segment.length; i++) edits.set(segment[i]!.parsed, output[i]!.text);
    segment = [];
  };
  for (const rule of parsed) {
    const selectors = rule.selector.split(',').map((selector) => selector.trim());
    const info = selectors.map((selector) => parseQSelector(selector, meta.condUnitIds));
    const decls = declsByRule.get(rule)!;
    if (info.some((item) => !item || item.cond) || decls.length === 0 || decls.length > 128) {
      flush(); continue;
    }
    const sorted = declarations === 'source' ? decls : topologicalOrder(decls,
      (a, b) => {
        return propertiesMayInteract(propertyOf(a), propertyOf(b));
      },
      (a, b) => (propertyOrder ? (rank.get(propertyOf(a)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(propertyOf(b)) ?? Number.MAX_SAFE_INTEGER) : 0)
        || (declarations === 'frequency' ? (frequency.get(propertyOf(b)) ?? 0) - (frequency.get(propertyOf(a)) ?? 0) : 0)
        || compareText(propertyOf(a), propertyOf(b)));
    const body = sorted.every((decl, i) => decl === decls[i]) ? rule.body : sorted.join(';');
    const text = css.slice(rule.start, rule.bodyStart) + body + css.slice(rule.bodyEnd, rule.end);
    edits.set(rule, text);
    const previous = segment.at(-1)?.parsed;
    if (previous && (rule.scope !== previous.scope || css.slice(previous.end, rule.start).trim() !== '' || segment.length >= 256)) flush();
    segment.push({ parsed: rule, selectors: info.map((item) => item!), decls: sorted,
      body, text, propertyKey: sorted.map(propertyOf).join(';') });
  }
  flush();
  let output = css;
  for (const rule of [...edits.keys()].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, rule.start) + edits.get(rule)! + output.slice(rule.end);
  }
  return output;
}

export function orderableProperties(css: string): readonly string[] {
  const rules: ParsedRule[] = [];
  if (css.length > 1_000_000) return [];
  try { collectRules(css, rules); } catch { return []; }
  return [...new Set(rules.flatMap((r) => [...parseDecls(r.body).keys()].map(propertyOf)))].filter((p) => DOMAIN_OF.has(p)).sort();
}
