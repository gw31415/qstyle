// number semantics (plan.md §20.2) の versioned fixture。
// unitless table の変更は意図せぬ serialize 差分を生むため breaking behavior として扱う。

/** unitless fixture のバージョン。table 内容と対で更新する。 */
export const UNITLESS_VERSION: string = 'm1.0';

/**
 * 数値をそのまま serialize する canonical (kebab-case) property の集合。
 * 検索は serializeCssValue / isUnitlessProperty 経由で行う。
 */
export const UNITLESS_PROPERTIES: ReadonlySet<string> = new Set<string>([
  'animation-iteration-count',
  'aspect-ratio',
  'column-count',
  'fill-opacity',
  'flex',
  'flex-grow',
  'flex-order',
  'flex-shrink',
  'flood-opacity',
  'font-weight',
  'grid-column',
  'grid-column-end',
  'grid-column-start',
  'grid-row',
  'grid-row-end',
  'grid-row-start',
  'line-clamp',
  'line-height',
  'opacity',
  'order',
  'orphans',
  'stop-opacity',
  'stroke-miterlimit',
  'stroke-opacity',
  'tab-size',
  'widows',
  'z-index',
  'zoom',
]);

/**
 * atom.ts との循環 import を避けるための局所コピー。
 * atom.ts の canonicalProperty と同一規則 (camelCase→kebab、custom property は不変、
 * 小文字始まりの `ms` vendor prefix は `-ms-` 化)。
 */
function toCanonicalProperty(input: string): string {
  if (input.startsWith('--')) return input;
  const kebab: string = input.replace(/[A-Z]/g, (m: string) => `-${m.toLowerCase()}`);
  return kebab.startsWith('ms-') ? `-${kebab}` : kebab;
}

/** atom.ts の canonicalValue と同一規則 (前後 trim + 内部連続空白の単一化)。 */
function collapseWhitespace(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

/** canonical property 名が unitless table に含まれるか (camelCase 入力可)。 */
export function isUnitlessProperty(property: string): boolean {
  return UNITLESS_PROPERTIES.has(toCanonicalProperty(property));
}

/**
 * plan.md §20.2 の number semantics:
 * - unitless property は数値をそのまま
 * - length 系は数値に `px` 補完 (Emotion/React 互換の MVP 規則)
 * - `0` は単位を付けない
 * - 文字列は canonicalValue 素通し (CSS-wide keyword / var() / calc() 等の意味を変えない)
 * - custom property (`--*`) の数値は単位推測せずそのまま (呼び出し側の token を尊重)
 */
export function serializeCssValue(property: string, value: string | number): string {
  if (typeof value === 'string') {
    return collapseWhitespace(value);
  }
  if (value === 0) {
    return '0';
  }
  const canonical: string = toCanonicalProperty(property);
  if (canonical.startsWith('--')) {
    return String(value);
  }
  if (UNITLESS_PROPERTIES.has(canonical)) {
    return String(value);
  }
  return `${value}px`;
}
