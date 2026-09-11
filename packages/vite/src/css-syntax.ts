
/** Conservative parser and cascade helpers for generated qstyle CSS, not arbitrary CSS. */
export interface DedupMeta {
  /** unit class が適用されたタグ名 (q_xxxxxxxx -> {"span", ...})。 */
  readonly unitTags: ReadonlyMap<string, ReadonlySet<string>>;
  /** 条件付き (ternary 等) で適用される unit class。dedup 対象外かつ block 判定は保守的にする。 */
  readonly condUnitIds: ReadonlySet<string>;
}

export interface ParsedRule {
  /** ルール全体の範囲。 */
  start: number;
  end: number;
  /** Physical wrapper instance; identical media text can occur at different cascade positions. */
  scope: number;
  selector: string;
  bodyStart: number;
  bodyEnd: number;
  body: string;
}

export interface QSelectorInfo {
  cls: string;
  /** true: base `.q_x`。false: pseudo / descendant を含む。 */
  base: boolean;
  /** Whether the selected element is a descendant of the unit's subject. */
  descendant: boolean;
  /** Actual descendant tag (`.q_x span`), never a descendant class name. */
  descTag: string | null;
  /** 詳細度 (b=class/pseudo, c=element)。順序比較のみに使用。 */
  spec: [number, number];
  cond: boolean;
}

const Q_SELECTOR_RE =
  /^\.q_[0-9a-f]{8,}((?::[-a-zA-Z]+(?:\([^)]*\))?)*)((?:\s+(?:[A-Za-z][A-Za-z0-9-]*|\.[A-Za-z][\w-]*))?)$/;

export function parseQSelector(selector: string, condUnitIds: ReadonlySet<string>): QSelectorInfo | null {
  const m: RegExpExecArray | null = Q_SELECTOR_RE.exec(selector);
  if (m === null || selector.includes('(')) return null;
  const head: RegExpMatchArray | null = /^\.q_[0-9a-f]{8,}/.exec(selector);
  if (head === null) return null;
  const cls: string = head[0].slice(1);
  const pseudoPart: string = m[1] ?? '';
  const descPart: string = (m[2] ?? '').trim();
  const pseudoCount: number = pseudoPart === '' ? 0 : (pseudoPart.match(/:/g) ?? []).length;
  let descTag: string | null = null;
  let descClass = false;
  if (descPart !== '') {
    if (descPart.startsWith('.')) {
      descClass = true;
    } else {
      // HTML type selectors are ASCII case-insensitive. Do not infer
      // disjointness from a spelling that may also be a case-sensitive XML tag.
      if (descPart !== descPart.toLowerCase()) return null;
      descTag = descPart;
    }
  }
  const b: number = 1 + pseudoCount + (descClass ? 1 : 0);
  const c: number = descTag !== null && !descClass ? 1 : 0;
  return {
    cls,
    base: pseudoPart === '' && descPart === '',
    descendant: descPart !== '',
    descTag,
    spec: [b, c],
    cond: condUnitIds.has(cls),
  };
}

export function parseDecls(body: string): Map<string, string> {
  const out = new Map<string, string>();
  // This pass handles generated flat declarations. Leave opaque values and fallback
  // declaration sequences untouched; do not reconstruct them with a string split.
  if (/[{}\\]/.test(body) || body.includes('/*')) return out;
  let quote = '';
  let depth = 0;
  let start = 0;
  const properties = new Set<string>();
  for (let i = 0; i <= body.length; i++) {
    const ch = body[i];
    if (quote !== '') {
      if (ch === quote) quote = '';
      if (ch === undefined) return new Map();
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') { if (--depth < 0) return new Map(); }
    if ((ch === ';' && depth === 0) || ch === undefined) {
      if (depth !== 0) return new Map();
      const d = body.slice(start, i).trim();
      start = i + 1;
      if (d === '') continue;
      const colon = d.indexOf(':');
      const property = d.slice(0, colon).trim();
      if (colon <= 0 || !/^(?:--)?[a-zA-Z-]+$/.test(property) || properties.has(property)) return new Map();
      properties.add(property);
      out.set(d, d);
    }
  }
  return out;
}

/**
 * block 内を走査して rule を列挙する (at-rule は prefix に積んで再帰)。
 */

/**
 * blocker rule R (詳細度が member と一致し、宣言が競合する) が、member rule の
 * 対象要素と「同じ要素に当たりうる」場合に false を返す (その場合はグループ化しない)。
 *
 * 証明できる非共存:
 * - R も member も base `.q_x` / `.q_y` で id が異なる (1 要素が持つ static unit class
 *   は高々 1 つ。条件付き unit は除外済み)。
 * - member が `.q_c <tag>` の子孫で、tag が R (= `.q_c`) の適用タグ集合に含まれない
 *   (R 要素は tag が違うため member selector に一致しない。祖先自身は子孫ではない)。
 */
export function disjointWith(
  rInfo: QSelectorInfo,
  member: QSelectorInfo,
  meta: DedupMeta,
): boolean {
  if (rInfo.cond || member.cond) return false;
  if (!rInfo.base) return false; // R が pseudo / 子孫の場合は証明不能 (保守的)
  if (member.base) return member.cls !== rInfo.cls;
  // member は子孫 (または pseudo 付き)。pseudo のみ (descTag === null) は同一要素の
  // 可能性があるため証明できない。
  if (member.descTag === null) return false;
  const tags: ReadonlySet<string> | undefined = meta.unitTags.get(rInfo.cls);
  if (tags === undefined || tags.size === 0) return false; // 記録なし → 証明不能
  return !tags.has(member.descTag);
}
export function collectRules(css: string, out: ParsedRule[]): void {
  const walk = (start: number, end: number): void => {
    let i = start;
    while (i < end) {
      // 空白・コメントをスキップ
      while (i < end) {
        const ch = css[i];
        if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
          i += 1;
        } else if (ch === '/' && css[i + 1] === '*') {
          const close = css.indexOf('*/', i + 2);
          if (close < 0) throw new Error('Unclosed CSS comment');
          i = close + 2;
        } else {
          break;
        }
      }
      if (i >= end) break;
      // トークンを読み、最初の '{' か ';' を探す
      let j = i;
      let header = '';
      let found: '{' | ';' | null = null;
      while (j < end) {
        const ch = css[j];
        if (ch === '"' || ch === "'") {
          const q = ch;
          j += 1;
          while (j < end && css[j] !== q) j += css[j] === '\\' ? 2 : 1;
          if (j >= end) throw new Error('Unclosed CSS token');
          j += 1;
          continue;
        }
        if (ch === '/' && css[j + 1] === '*') {
          const close = css.indexOf('*/', j + 2);
          if (close < 0) throw new Error('Unclosed CSS comment');
          j = close + 2;
          continue;
        }
        if (ch === '(') {
          // url(...) 等の中に brace が現れても無視
          let depth = 0;
          while (j < end) {
            const c2 = css[j];
            if (c2 === '(') depth += 1;
            else if (c2 === ')') {
              depth -= 1;
              if (depth === 0) {
                j += 1;
                break;
              }
            } else if (c2 === '"' || c2 === "'") {
              const q = c2;
              j += 1;
              while (j < end && css[j] !== q) j += css[j] === '\\' ? 2 : 1;
            }
            j += 1;
          }
          continue;
        }
        if (ch === '{' || ch === ';') {
          found = ch;
          break;
        }
        j += 1;
      }
      if (found === null) throw new Error('Unparsed CSS tail');
      header = css.slice(i, j).trim();
      if (found === ';') {
        // @import 等の statement はスキップ
        i = j + 1;
        continue;
      }
      // '{' の対応を探す
      let depth = 0;
      let k = j;
      while (k < end) {
        const ch = css[k];
        if (ch === '"' || ch === "'") {
          const q = ch;
          k += 1;
          while (k < end && css[k] !== q) k += css[k] === '\\' ? 2 : 1;
          if (k >= end) throw new Error('Unclosed CSS block');
          k += 1;
          continue;
        }
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
        k += 1;
      }
      if (k >= end) throw new Error('Unclosed CSS block'); // 対応する '}' なし → 解析諦め (呼び出し元で原文返し)
      if (header.startsWith('@')) {
        walk(j + 1, k);
      } else {
        out.push({
          start: i,
          end: k + 1,
          scope: start,
          selector: header,
          bodyStart: j + 1,
          bodyEnd: k,
          body: css.slice(j + 1, k),
        });
      }
      i = k + 1;
    }
  };
  walk(0, css.length);
}

export const propertyOf = (decl: string): string => decl.slice(0, decl.indexOf(':')).trim();
