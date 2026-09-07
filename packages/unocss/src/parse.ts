// UnoCSS 生成 CSS-text → rule 列の最小 parser。
// default 層の utility rules のみ対象。theme / properties / base 層は素通しする。
// string・escape・comment・parens を考慮する。解釈不能箇所は throw せず
// caller が token を unknown に戻せるよう、構造化されたまま返す。

export interface RawDecl {
  readonly prop: string;
  readonly value: string;
}

export interface CssWrapper {
  readonly kind: 'media' | 'supports' | 'container' | 'layer';
  readonly prelude: string;
}

export interface RawRule {
  readonly selectors: readonly string[];
  /** `@property` / `@keyframes` 等の非 declaration rule。decls は空。 */
  readonly opaqueAt: string | null;
  readonly decls: readonly RawDecl[];
  readonly wrappers: readonly CssWrapper[];
  /** source 内の byte 範囲 (verbatim 切り出し用)。 */
  readonly start: number;
  readonly end: number;
}

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function skipComment(text: string, i: number): number {
  // text[i] === '/' && text[i+1] === '*' が前提。閉じなければ末尾。
  const close: number = text.indexOf('*/', i + 2);
  return close < 0 ? text.length : close + 2;
}

function skipWsComments(text: string, i: number): number {
  for (;;) {
    while (i < text.length && isWs(text[i] ?? '')) i += 1;
    if (text[i] === '/' && text[i + 1] === '*') {
      i = skipComment(text, i);
      continue;
    }
    return i;
  }
}

/**
 * 開き括弧に対応する閉じ括弧の offset (exclusive)。quote・escape・comment・
 * parens を考慮する。閉じなしは -1。
 */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  let i: number = open;
  let quote: string | null = null;
  let paren = 0;
  while (i < text.length) {
    const ch: string = text[i] ?? '';
    if (quote !== null) {
      if (ch === '\\') i += 2;
      else {
        if (ch === quote) quote = null;
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      // declaration 文脈の `//` は URL (`https://`) の可能性があるため、
      // block comment のみ数える。line comment は text として残す。
      if (text[i + 1] === '*') {
        i = skipComment(text, i);
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '(') paren += 1;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '{' && paren === 0) depth += 1;
    else if (ch === '}' && paren === 0) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

/** `;` を含まない宣言断片列へ分割する (paren/brace depth 0・quote 外の `;` のみ)。 */
function splitDecls(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const ch: string = body[i] ?? '';
    if (quote !== null) {
      if (ch === '\\') i += 2;
      else {
        if (ch === quote) quote = null;
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '(' || ch === '{') depth += 1;
    else if (ch === ')' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  out.push(body.slice(start));
  return out;
}

/** selector list を depth 考慮で `,` 分割する。 */
function splitSelectors(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch: string = text[i] ?? '';
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter((s) => s !== '');
}

function parseDecl(chunk: string): RawDecl | null {
  const text: string = chunk.trim();
  if (text === '') return null;
  // nested rule 混じりは対象外 (caller が token を unknown に戻す)。
  if (text.includes('{') || text.includes('}')) return null;
  const colon: number = text.indexOf(':');
  if (colon < 0) return null;
  const prop: string = text.slice(0, colon).trim();
  const value: string = text.slice(colon + 1).trim();
  if (prop === '' || value === '') return null;
  return { prop, value };
}

function wrapperOf(header: string): CssWrapper | null {
  const m: RegExpMatchArray | null = /^@(media|supports|container|layer)\b([\s\S]*)$/.exec(
    header.trim(),
  );
  if (m === null) return null;
  return {
    kind: m[1] as CssWrapper['kind'],
    prelude: (m[2] ?? '').trim().replace(/\s+/g, ' '),
  };
}

/**
 * CSS-text を top-level rule 列へ。block を持たない文 (`@charset` 等) は捨てる。
 * 未知 at-rule block は opaque として保持する (caller が globals へ回せる)。
 */
export function parseCssRules(cssText: string): RawRule[] {
  const rules: RawRule[] = [];
  const walk = (text: string, wrappers: readonly CssWrapper[], base: number): void => {
    let i: number = skipWsComments(text, 0);
    while (i < text.length) {
      const ruleStart: number = base + i;
      if (text[i] === '@') {
        const brace: number = text.indexOf('{', i);
        const semi: number = text.indexOf(';', i);
        if (brace < 0 || (semi >= 0 && semi < brace)) {
          i = skipWsComments(text, semi < 0 ? text.length : semi + 1);
          continue;
        }
        const header: string = text.slice(i, brace);
        const end: number = matchBrace(text, brace);
        if (end < 0) return;
        const inner: string = text.slice(brace + 1, end - 1);
        const wrapper: CssWrapper | null = wrapperOf(header);
        if (wrapper !== null) {
          walk(inner, [...wrappers, wrapper], brace + 1);
        } else {
          rules.push({
            selectors: [],
            opaqueAt: `${header.trim()}{${inner}}`,
            decls: [],
            wrappers,
            start: ruleStart,
            end: base + end,
          });
        }
        i = skipWsComments(text, end);
        continue;
      }
      const brace: number = text.indexOf('{', i);
      if (brace < 0) return;
      const end: number = matchBrace(text, brace);
      if (end < 0) return;
      const selectors: string[] = splitSelectors(text.slice(i, brace));
      const decls: RawDecl[] = [];
      for (const chunk of splitDecls(text.slice(brace + 1, end - 1))) {
        const decl: RawDecl | null = parseDecl(chunk);
        if (decl !== null) decls.push(decl);
      }
      rules.push({
        selectors,
        opaqueAt: null,
        decls,
        wrappers,
        start: ruleStart,
        end: base + end,
      });
      i = skipWsComments(text, end);
    }
  };
  walk(cssText, [], 0);
  return rules;
}
