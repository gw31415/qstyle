// `@qstyle/unocss` の Vite plugin (qstyle 本体より前に置く)。
// class ユーティリティを `css` prop へ翻訳し、qstyle 本体の配管に載せる。
// qstyle 本体はこの plugin の存在を知らない (境界面はコードのみ)。
// engine・config・変換意味論はすべてこの package 内に閉じる。
import { fnv1aHex } from '@qstyle/core';
import type { RuleContext, StaticAtom } from '@qstyle/core';
import type { UserConfig } from 'unocss';
import { createUnoResolver, loadUnoConfig, orderRiskProperty, tokenizeClassAttr } from './index.js';
import type { UnoResolver } from './index.js';

/**
 * `@unocss/vite` との入れ替え用引数。`VitePluginConfig` と構造互換
 * (inline config は `uno.config.ts` に merge され、文字列は config path。
 * 未知キーも受け付ける)。vite 固有の出力制御キーは宣言するが無視する。
 * `import type` を持たないのは tsdown の DTS バンドルが vite 系の型を
 * 束ねられないため。`@unocss/vite` のキー追加時はここに足す。
 */
export interface QstyleUnoOptions extends UserConfig {
  readonly inspector?: boolean | undefined;
  readonly mode?: 'global' | 'per-module' | 'vue-scoped' | 'dist-chunk' | 'shadow-dom' | undefined;
  readonly transformCSS?: boolean | 'pre' | 'post' | undefined;
  readonly postcss?: boolean | undefined;
  readonly hmrTopLevelAwait?: boolean | undefined;
  readonly fetchMode?: 'cors' | 'navigate' | 'no-cors' | 'same-origin' | undefined;
  readonly checkImport?: boolean | undefined;
  /**
   * true の場合、互換モード (従来動作): 解決した class を残し、
   * verbatim CSS も原文 selector のまま出す。
   * 未指定/false (既定) の削減モードでは、解決した token を転送物から消す
   * (静的 class は `css` prop か短縮 alias へ、動的 class・class 参照 const は
   * 短縮 alias へ)。実行時に utility class 名を参照するコード
   * (`querySelector('.flex')` 等) との非互換はルールとして許容する。
   */
  readonly preserveClass?: boolean | undefined;
  readonly [key: string]: unknown;
}

/**
 * 最小の Vite plugin 形状 (構造的)。`vite` への依存 (型含む) を持たないため、
 * `import type` もしない。Vite は構造で受け付ける。
 */
export interface QstyleUnoPlugin {
  readonly name: 'qstyle:unocss';
  readonly enforce: 'pre';
  configResolved(config: { root?: string }): void;
  configureServer(server: {
    middlewares: { use(handler: (req: unknown, res: unknown, next: () => void) => void): void };
  }): void;
  resolveId(id: string): string | null;
  load(id: string): string | null;
  transform(code: string, id: string): Promise<{ code: string; map: null } | null>;
}

// ponytail: 本家 UnoCSS (`__uno`) と衝突しないよう `qstyle-uno` 名義にする。
// id 形式は Qwik 自身の dev virtual (`\0virtual:qstyle/...`) と同じにする。
// 素の id だと Vite dev が JS ラッパーで配信し、SSR の `<link>` で読めない。
// `\0` 付きは Vite dev が CSS テキストとして配信する (qstyle 本体と同一方式)。
const VIRTUAL_PREFIX = 'virtual:qstyle-uno/';
const RESOLVED_PREFIX = '\0virtual:qstyle-uno/';

function resolveUnoId(id: string): string | null {
  // ponytail: dev の `?v=` / `?import` 等の query を落とす。
  const clean: string = id.split('?', 1)[0] ?? '';
  const path: string = clean.startsWith('/') ? clean.slice(1) : clean;
  if (path.startsWith(RESOLVED_PREFIX)) return path;
  if (path.startsWith(VIRTUAL_PREFIX)) return `${RESOLVED_PREFIX}${path.slice(VIRTUAL_PREFIX.length)}`;
  return null;
}

/**
 * engine 出力の `:where(` を `:is(` に置換する (文字列・コメント内は除外)。
 *
 * engine (unocss/tailwind 方式) は `:where()` (specificity 0) で出すため、
 * preflight の `*` (specificity 0) と同点になる。dev では virtual CSS が
 * module 解決順に遅延注入されるため、同点の勝敗が到着順で変わり、divide 等の
 * 幅が一瞬 0 になる (navigation 時のちらつき)。`:is()` は matching が同一で
 * specificity のみ上がるため、順序に依らず utility が勝つ。build 成果物の
 * 宣言内容は不変 (preview との等価性は differential で担保)。
 */
function whereToIs(cssText: string): string {
  let out = '';
  let i = 0;
  const n: number = cssText.length;
  while (i < n) {
    const ch: string = cssText[i] as string;
    if (ch === '"' || ch === "'") {
      const end: number = cssText.indexOf(ch, i + 1);
      const stop: number = end < 0 ? n : end + 1;
      out += cssText.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && cssText[i + 1] === '*') {
      const end: number = cssText.indexOf('*/', i + 2);
      const stop: number = end < 0 ? n : end + 2;
      out += cssText.slice(i, stop);
      i = stop;
      continue;
    }
    if (cssText.startsWith(':where(', i)) {
      out += ':is(';
      i += ':where('.length;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 内容 hash → CSS。本文は hash で一意に決まるため全 instance で共有する。
 * dev では環境ごと (client/ssr/…) に plugin 実体が分かれ、transform 側と
 * serve 側で別実体になるため共有が必須。 */
const sharedCssByHash = new Map<string, string>();

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

/** quote・template・comment を飛ばしながら `<...>` の閉じ `>` を探す。 */
function findTagEnd(code: string, lt: number): number | null {
  let i: number = lt + 1;
  let quote: string | null = null;
  let backtick = false;
  let local = 0;
  let depth = 0;
  while (i < code.length) {
    const ch: string = code[i] ?? '';
    const nx: string = code[i + 1] ?? '';
    if (quote !== null) {
      if (ch === '\\') i += 2;
      else if (ch === quote) {
        quote = null;
        i += 1;
      } else i += 1;
      continue;
    }
    if (backtick) {
      if (ch === '\\') i += 2;
      else if (ch === '`' && local === 0) {
        backtick = false;
        i += 1;
      } else if (ch === '$' && nx === '{') {
        local += 1;
        i += 2;
      } else if (ch === '}' && local > 0) {
        local -= 1;
        i += 1;
      } else i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      backtick = true;
      i += 1;
      continue;
    }
    if (ch === '/' && (nx === '/' || nx === '*')) {
      if (nx === '/') {
        const nl: number = code.indexOf('\n', i);
        i = nl < 0 ? code.length : nl + 1;
      } else {
        const cl: number = code.indexOf('*/', i);
        i = cl < 0 ? code.length : cl + 2;
      }
      continue;
    }
    if (ch === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      if (depth > 0) depth -= 1;
      i += 1;
      continue;
    }
    if (ch === '>' && depth === 0) return i;
    i += 1;
  }
  return null;
}

/** `{` に対応する `}` の末尾 (exclusive)。quote・template・comment 対応。 */
function matchBrace(code: string, open: number): number {
  let depth = 0;
  let i: number = open;
  let quote: string | null = null;
  let backtick = false;
  let local = 0;
  while (i < code.length) {
    const ch: string = code[i] ?? '';
    const nx: string = code[i + 1] ?? '';
    if (quote !== null) {
      if (ch === '\\') i += 2;
      else if (ch === quote) {
        quote = null;
        i += 1;
      } else i += 1;
      continue;
    }
    if (backtick) {
      if (ch === '\\') i += 2;
      else if (ch === '`' && local === 0) {
        backtick = false;
        i += 1;
      } else if (ch === '$' && nx === '{') {
        local += 1;
        i += 2;
      } else if (ch === '}' && local > 0) {
        local -= 1;
        i += 1;
      } else i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      backtick = true;
      i += 1;
      continue;
    }
    if (ch === '/' && (nx === '/' || nx === '*')) {
      if (nx === '/') {
        const nl: number = code.indexOf('\n', i);
        i = nl < 0 ? code.length : nl + 1;
      } else {
        const cl: number = code.indexOf('*/', i);
        i = cl < 0 ? code.length : cl + 2;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

/** quoted 領域を空白化した head (offset 保持)。attr 値内の誤検出防止用。 */
function blankQuoted(head: string): string {
  let out = '';
  let i = 0;
  while (i < head.length) {
    const ch: string = head[i] ?? '';
    if (ch === '"' || ch === "'") {
      const quote: string = ch;
      out += ' ';
      i += 1;
      while (i < head.length && (head[i] ?? '') !== quote) {
        out += ' ';
        i += 1;
      }
      if (i < head.length) {
        out += ' ';
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

interface ClassAttr {
  readonly keyword: string;
  readonly quote: string;
  readonly value: string;
  /** head 内 offset。 */
  readonly start: number;
  readonly end: number;
}

/** 静的 class リテラルを探す。動的式・spread 混じりは null。 */
function findClassAttr(head: string): ClassAttr | null {
  const flat: string = blankQuoted(head);
  const spread: RegExpExecArray | null = /\{\s*\.\.\./.exec(flat);
  // ponytail: quote は blank 化で消えるため、keyword + `=` までを flat で探し、
  // quote 自体は原文 offset で読む。`data-class=` 等の誤検出防止に直前は空白必須。
  const m: RegExpExecArray | null = /(?:^|\s)class(Name)?\s*=\s*/.exec(flat);
  if (m === null || m.index === undefined) return null;
  const kwStart: number = /^\s/.test(m[0]) ? m.index + 1 : m.index;
  if (spread !== null && spread.index !== undefined && spread.index < kwStart) {
    return null;
  }
  // ponytail: `=` 以降は原文基準で読む (flat の空白化で quote 位置が消えるため)。
  const eq: number = head.indexOf('=', kwStart);
  if (eq < 0) return null;
  let p: number = eq + 1;
  while (p < head.length && isWs(head[p] ?? '')) p += 1;
  const quote: string = head[p] ?? '';
  if (quote !== '"' && quote !== "'") return null;
  // JSX 文字列リテラルに escape は無い (同 quote まで)。
  const close: number = head.indexOf(quote, p + 1);
  if (close < 0) return null;
  return {
    keyword: `class${m[1] ?? ''}`,
    quote,
    value: head.slice(p + 1, close),
    start: kwStart,
    end: close + 1,
  };
}

interface CssProp {
  /** `css={` の `{` の offset (head 内)。 */
  readonly braceOpen: number;
  /** 対応する `}` の末尾 (exclusive)。 */
  readonly braceClose: number;
  /** keyword 開始 offset。 */
  readonly kwStart: number;
}

/** `css={...}` の span を探す。無ければ null。 */
function findCssProp(head: string): CssProp | null {
  const flat: string = blankQuoted(head);
  const m: RegExpExecArray | null = /(?:^|\s)css\s*=\s*\{/.exec(flat);
  if (m === null || m.index === undefined) return null;
  const kwStart: number = /^\s/.test(m[0]) ? m.index + 1 : m.index;
  const braceOpen: number = m.index + m[0].length - 1;
  // head はタグ内断片のため、code 全体基準の matcher は使わず数える。
  // template literal (`css={\`...\`}`) も正しく数える (bail しない)。
  let depth = 0;
  let i: number = braceOpen;
  let quote: string | null = null;
  let backtick = false;
  let local = 0;
  while (i < head.length) {
    const ch: string = head[i] ?? '';
    if (quote !== null) {
      if (ch === '\\') i += 2;
      else if (ch === quote) {
        quote = null;
        i += 1;
      } else i += 1;
      continue;
    }
    if (backtick) {
      if (ch === '\\') i += 2;
      else if (ch === '`' && local === 0) {
        backtick = false;
        i += 1;
      } else if (ch === '$' && (head[i + 1] ?? '') === '{') {
        local += 1;
        i += 2;
      } else if (ch === '}' && local > 0) {
        local -= 1;
        i += 1;
      } else i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      backtick = true;
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return { braceOpen, braceClose: i + 1, kwStart };
      }
    }
    i += 1;
  }
  return null;
}

/**
 * utility token → 短縮 alias (`qu_<hash8>`)。token の純関数のため
 * module をまたいで同一 token は同一 alias になり、cache 効率が落ちない。
 * `q_` / `qd_` (qstyle 本体) とは prefix が異なり衝突しない。
 */
export function aliasForUtilityToken(token: string): string {
  return `qu_${fnv1aHex(token).slice(0, 8)}`;
}

/** aliasForUtilityToken の出力形。冪等性のため preserved 扱いにする。 */
const UTILITY_ALIAS_RE = /^qu_[0-9a-f]{8}$/;

/** qstyle 本体・自 alias は変換対象外 (engine に投げない)。 */
function isPreservedToken(token: string): boolean {
  return token.startsWith('q_') || token.startsWith('qd_') || UTILITY_ALIAS_RE.test(token);
}

/**
 * 互換モード用の preserved 判定。`qu_<hash>` 形の user utility を
 * 従来どおり解決するため alias 予約は適用しない (strip 専用の名前空間)。
 */
function isPreservedTokenCompat(token: string): boolean {
  return token.startsWith('q_') || token.startsWith('qd_');
}

interface CodeRange {
  readonly start: number;
  readonly end: number;
}

function insideRanges(span: { start: number; end: number }, ranges: readonly CodeRange[]): boolean {
  return ranges.some((r) => r.start <= span.start && span.end <= r.end);
}

/** `{` に対応する `}` の index。quote・template・comment 対応。無ければ -1。 */
function matchBraceInText(text: string, open: number): number {
  let depth = 0;
  let i: number = open;
  let quote: string | null = null;
  let backtick = false;
  let local = 0;
  while (i < text.length) {
    const ch: string = text[i] ?? '';
    const nx: string = text[i + 1] ?? '';
    if (quote !== null) {
      if (ch === '\\') i += 2;
      else if (ch === quote) {
        quote = null;
        i += 1;
      } else i += 1;
      continue;
    }
    if (backtick) {
      if (ch === '\\') i += 2;
      else if (ch === '`' && local === 0) {
        backtick = false;
        i += 1;
      } else if (ch === '$' && nx === '{') {
        local += 1;
        i += 2;
      } else if (ch === '}' && local > 0) {
        local -= 1;
        i += 1;
      } else i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      backtick = true;
      i += 1;
      continue;
    }
    if (ch === '/' && (nx === '/' || nx === '*')) {
      if (nx === '/') {
        const nl: number = text.indexOf('\n', i);
        i = nl < 0 ? text.length : nl + 1;
      } else {
        const cl: number = text.indexOf('*/', i);
        i = cl < 0 ? text.length : cl + 2;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * 動的 `class={` / `className={` の式範囲 (brace 内側) を集める。
 * 中の文字列リテラルは class 用途のため削減モードの書換対象になる。
 */
export function findDynamicClassExprs(code: string): CodeRange[] {
  const out: CodeRange[] = [];
  let from = 0;
  for (;;) {
    const lt: number = code.indexOf('<', from);
    if (lt < 0) break;
    const gt: number | null = findTagEnd(code, lt);
    if (gt === null) break;
    const head: string = code.slice(lt, gt);
    from = gt;
    const flat: string = blankQuoted(head);
    const re = /(?:^|\s)class(Name)?\s*=\s*\{/g;
    let m: RegExpExecArray | null;
    for (;;) {
      m = re.exec(flat);
      if (m === null || m.index === undefined) break;
      const braceOpen: number = m.index + m[0].length - 1;
      const braceClose: number = matchBraceInText(head, braceOpen);
      if (braceClose < 0) continue;
      out.push({ start: lt + braceOpen + 1, end: lt + braceClose });
    }
  }
  return out;
}

/**
 * コード断片中の文字列・template 静的部分・comment を空白化する
 * (offset 保持)。`${}` 内の式は残す (参照 identifier 収集用)。
 */
function blankNonCode(text: string): string {
  const out: string[] = text.split('');
  const blank = (from: number, to: number): void => {
    for (let k: number = from; k < to; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch: string = text[i] ?? '';
    const nx: string = text[i + 1] ?? '';
    if (ch === '"' || ch === "'") {
      const quote: string = ch;
      let j: number = i + 1;
      while (j < text.length) {
        const c: string = text[j] ?? '';
        if (c === '\\') j += 2;
        else if (c === quote) {
          j += 1;
          break;
        } else j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '`') {
      let j: number = i + 1;
      let segStart: number = j;
      let depth = 0;
      while (j < text.length) {
        const c: string = text[j] ?? '';
        const c2: string = text[j + 1] ?? '';
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (depth === 0 && c === '`') break;
        if (c === '$' && c2 === '{') {
          blank(segStart, j);
          depth += 1;
          j += 2;
          continue;
        }
        if (c === '{') depth += 1;
        else if (c === '}') {
          depth -= 1;
          if (depth === 0) segStart = j + 1;
        }
        j += 1;
      }
      blank(segStart, j);
      i = j + 1;
      continue;
    }
    if (ch === '/' && nx === '/') {
      const nl: number = text.indexOf('\n', i);
      const stop: number = nl < 0 ? text.length : nl;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && nx === '*') {
      const cl: number = text.indexOf('*/', i);
      const stop: number = cl < 0 ? text.length : cl + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

const JS_KEYWORDS: ReadonlySet<string> = new Set([
  'as',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'null',
  'of',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

/**
 * class 式中で参照される identifier を集める (class 供給 const の検出用)。
 * member access (`a.b` の `b`)・keyword は除く。
 */
function collectExprIdents(code: string, ranges: readonly CodeRange[]): Set<string> {
  const idents = new Set<string>();
  for (const range of ranges) {
    const text: string = blankNonCode(code.slice(range.start, range.end));
    const re = /[A-Za-z_$][\w$]*/g;
    let m: RegExpExecArray | null;
    for (;;) {
      m = re.exec(text);
      if (m === null || m.index === undefined) break;
      const name: string = m[0];
      if (JS_KEYWORDS.has(name)) continue;
      let j: number = m.index - 1;
      while (j >= 0 && /\s/.test(text[j] ?? '')) j -= 1;
      if ((text[j] ?? '') === '.') continue;
      idents.add(name);
    }
  }
  return idents;
}

/** 初期化子の末尾 (`;` / `,` / ASI 改行。depth 0) を探す。 */
function scanInitEnd(code: string, from: number): number {
  let depth = 0;
  let i: number = from;
  let quote: string | null = null;
  let backtick = false;
  let local = 0;
  while (i < code.length) {
    const ch: string = code[i] ?? '';
    const nx: string = code[i + 1] ?? '';
    if (quote !== null) {
      if (ch === '\\') i += 2;
      else if (ch === quote) {
        quote = null;
        i += 1;
      } else i += 1;
      continue;
    }
    if (backtick) {
      if (ch === '\\') i += 2;
      else if (ch === '`' && local === 0) {
        backtick = false;
        i += 1;
      } else if (ch === '$' && nx === '{') {
        local += 1;
        i += 2;
      } else if (ch === '}' && local > 0) {
        local -= 1;
        i += 1;
      } else i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      backtick = true;
      i += 1;
      continue;
    }
    if (ch === '/' && (nx === '/' || nx === '*')) {
      if (nx === '/') {
        const nl: number = code.indexOf('\n', i);
        i = nl < 0 ? code.length : nl + 1;
      } else {
        const cl: number = code.indexOf('*/', i);
        i = cl < 0 ? code.length : cl + 2;
      }
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ';' || ch === ',')) return i;
    else if (depth === 0 && ch === '\n') return i;
    i += 1;
  }
  return i;
}

interface ConstInit {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/**
 * class 式から参照される `const/let/var Name = <init>` の初期化子範囲を集める。
 * 関数混じり (`=>` を含む) は対象外。複数宣言子 (`const a=.., b=..`) の
 * 後続要素は拾わない (単一宣言子がルール)。
 * top-level の宣言のみ (shadow された別 scope の同名 const を巻き込まない)。
 */
function findConstInits(code: string, names: ReadonlySet<string>): ConstInit[] {
  const out: ConstInit[] = [];
  const depths: Int32Array = bracketDepths(code);
  const re = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;{}]+)?=\s*/g;
  let m: RegExpExecArray | null;
  for (;;) {
    m = re.exec(code);
    if (m === null || m.index === undefined) break;
    if ((depths[m.index] ?? 0) !== 0) continue;
    const name: string = m[1] as string;
    if (!names.has(name)) continue;
    const initStart: number = m.index + m[0].length;
    const initEnd: number = scanInitEnd(code, initStart);
    if (initEnd <= initStart) continue;
    if (/=>/.test(code.slice(initStart, initEnd))) continue;
    out.push({ name, start: initStart, end: initEnd });
    re.lastIndex = initEnd;
  }
  return out;
}

/**
 * class 式中の `Name.prop` / `Name["prop"]` 参照を集める。
 * object literal 初期化子の書換を参照 prop に絞るための heuristic。
 */
function memberPropsOf(code: string, ranges: readonly CodeRange[], name: string): Set<string> {
  const props = new Set<string>();
  for (const range of ranges) {
    const text: string = code.slice(range.start, range.end);
    const dot = new RegExp(`${name}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
    let m: RegExpExecArray | null;
    for (;;) {
      m = dot.exec(text);
      if (m === null) break;
      props.add(m[1] as string);
    }
    const computed = new RegExp(`${name}\\s*\\[\\s*(?:"([^"]*)"|'([^']*)')\\s*\\]`, 'g');
    for (;;) {
      m = computed.exec(text);
      if (m === null) break;
      props.add((m[1] ?? m[2] ?? '') as string);
    }
  }
  return props;
}

/** quote 終端 (exclusive)。閉じなしは -1。 */
function findQuoteEnd(code: string, open: number): number {
  const quote: string = code[open] ?? '';
  let i: number = open + 1;
  while (i < code.length) {
    const ch: string = code[i] ?? '';
    if (ch === '\\') i += 2;
    else if (ch === quote) return i + 1;
    else i += 1;
  }
  return -1;
}

/**
 * object literal `{...}` の top-level entries を spans へ割る
 * (quote・template・comment・bracket 対応)。
 */
function splitTopEntries(code: string, open: number, close: number): CodeRange[] {
  const out: CodeRange[] = [];
  let depth = 0;
  let start: number = open + 1;
  let i: number = start;
  let quote: string | null = null;
  let backtick = false;
  let local = 0;
  const push = (end: number): void => {
    out.push({ start, end });
    start = end + 1;
  };
  while (i < close) {
    const ch: string = code[i] ?? '';
    const nx: string = code[i + 1] ?? '';
    if (quote !== null) {
      if (ch === '\\') i += 2;
      else if (ch === quote) {
        quote = null;
        i += 1;
      } else i += 1;
      continue;
    }
    if (backtick) {
      if (ch === '\\') i += 2;
      else if (ch === '`' && local === 0) {
        backtick = false;
        i += 1;
      } else if (ch === '$' && nx === '{') {
        local += 1;
        i += 2;
      } else if (ch === '}' && local > 0) {
        local -= 1;
        i += 1;
      } else i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      backtick = true;
      i += 1;
      continue;
    }
    if (ch === '/' && (nx === '/' || nx === '*')) {
      if (nx === '/') {
        const nl: number = code.indexOf('\n', i);
        i = nl < 0 ? close : Math.min(nl + 1, close);
      } else {
        const cl: number = code.indexOf('*/', i);
        i = cl < 0 ? close : Math.min(cl + 2, close);
      }
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      push(i);
      i += 1;
      continue;
    }
    i += 1;
  }
  out.push({ start, end: close });
  return out;
}

/**
 * object literal 初期化子のうち参照 prop の値範囲だけを返す。
 * 初期化子が object literal でない場合は空 (caller が全体を使う)。
 */
function propValueSpans(
  code: string,
  initStart: number,
  initEnd: number,
  props: ReadonlySet<string>,
): CodeRange[] {
  let p: number = initStart;
  while (p < initEnd && isWs(code[p] ?? '')) p += 1;
  if ((code[p] ?? '') !== '{') return [];
  const close: number = matchBraceInText(code, p);
  if (close < 0 || close > initEnd) return [];
  const out: CodeRange[] = [];
  for (const entry of splitTopEntries(code, p, close)) {
    let q: number = entry.start;
    while (q < entry.end && isWs(code[q] ?? '')) q += 1;
    let key: string | null = null;
    let rest: number = q;
    const ch: string = code[q] ?? '';
    if (ch === '"' || ch === "'") {
      const stop: number = findQuoteEnd(code, q);
      if (stop < 0 || stop > entry.end) continue;
      key = code.slice(q + 1, stop - 1);
      rest = stop;
    } else if (ch === '[') {
      const stop: number = code.indexOf(']', q);
      if (stop < 0 || stop > entry.end) continue;
      const inner: string = code.slice(q + 1, stop).trim();
      const first: string = inner[0] ?? '';
      const last: string = inner[inner.length - 1] ?? '';
      if ((first !== '"' && first !== "'") || last !== first || inner.length < 2) continue;
      key = inner.slice(1, -1);
      rest = stop + 1;
    } else {
      const m: RegExpMatchArray | null = /^[A-Za-z_$][\w$]*/.exec(code.slice(q, entry.end));
      if (m === null) continue;
      key = m[0];
      rest = q + m[0].length;
    }
    if (key === null || !props.has(key)) continue;
    while (rest < entry.end && isWs(code[rest] ?? '')) rest += 1;
    if ((code[rest] ?? '') !== ':') continue;
    let vs: number = rest + 1;
    while (vs < entry.end && isWs(code[vs] ?? '')) vs += 1;
    out.push({ start: vs, end: entry.end });
  }
  return out;
}

interface ClassAttrDynamic {
  readonly keyword: string;
  /** `{` の offset (head 内)。 */
  readonly braceOpen: number;
  /** 対応する `}` の index (head 内)。 */
  readonly braceClose: number;
  /** keyword 開始 offset。 */
  readonly kwStart: number;
}

/** head 内の動的 `class={` / `className={` を探す (先頭1件)。無ければ null。 */
function findDynamicClassInHead(head: string): ClassAttrDynamic | null {
  const flat: string = blankQuoted(head);
  const m: RegExpExecArray | null = /(?:^|\s)class(Name)?\s*=\s*\{/.exec(flat);
  if (m === null || m.index === undefined) return null;
  const kwStart: number = /^\s/.test(m[0]) ? m.index + 1 : m.index;
  const braceOpen: number = m.index + m[0].length - 1;
  const braceClose: number = matchBraceInText(head, braceOpen);
  if (braceClose < 0) return null;
  return {
    keyword: `class${m[1] ?? ''}`,
    braceOpen,
    braceClose,
    kwStart,
  };
}

interface ArrayElement {
  /** trim 済み範囲 (code offsets)。 */
  readonly start: number;
  readonly end: number;
}

/**
 * `[...]` の top-level 要素へ割る (quote・template・comment・bracket 対応)。
 * 空要素 (trailing comma 等) は除く。
 */
function splitArrayElements(code: string, open: number, close: number): ArrayElement[] {
  const out: ArrayElement[] = [];
  let depth = 0;
  let start: number = open + 1;
  let i: number = start;
  let quote: string | null = null;
  let backtick = false;
  let local = 0;
  const push = (end: number): void => {
    let s: number = start;
    let e: number = end;
    while (s < e && isWs(code[s] ?? '')) s += 1;
    while (e > s && isWs(code[e - 1] ?? '')) e -= 1;
    if (s < e) out.push({ start: s, end: e });
    start = end + 1;
  };
  while (i < close) {
    const ch: string = code[i] ?? '';
    const nx: string = code[i + 1] ?? '';
    if (quote !== null) {
      if (ch === '\\') i += 2;
      else if (ch === quote) {
        quote = null;
        i += 1;
      } else i += 1;
      continue;
    }
    if (backtick) {
      if (ch === '\\') i += 2;
      else if (ch === '`' && local === 0) {
        backtick = false;
        i += 1;
      } else if (ch === '$' && nx === '{') {
        local += 1;
        i += 2;
      } else if (ch === '}' && local > 0) {
        local -= 1;
        i += 1;
      } else i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      backtick = true;
      i += 1;
      continue;
    }
    if (ch === '/' && (nx === '/' || nx === '*')) {
      if (nx === '/') {
        const nl: number = code.indexOf('\n', i);
        i = nl < 0 ? close : Math.min(nl + 1, close);
      } else {
        const cl: number = code.indexOf('*/', i);
        i = cl < 0 ? close : Math.min(cl + 2, close);
      }
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      push(i);
      i += 1;
      continue;
    }
    i += 1;
  }
  push(close);
  return out;
}

/**
 * 要素全体が1つの文字列リテラルなら中身を返す。template・結合・
 * escape 混じりの quote は対象外 (alias path に譲る)。
 */
function staticStringContent(code: string, elem: ArrayElement): string | null {
  const text: string = code.slice(elem.start, elem.end);
  if (text.length < 2) return null;
  const first: string = text[0] ?? '';
  const last: string = text[text.length - 1] ?? '';
  if ((first !== '"' && first !== "'") || last !== first) return null;
  const inner: string = text.slice(1, -1);
  if (inner.includes(first) || inner.includes('\\')) return null;
  return inner;
}

/** `(` に対応する `)` の index (`limit` 内)。quote・template・comment 対応。 */
function findMatchingParenInText(code: string, open: number, limit: number): number {
  let depth = 0;
  let i: number = open;
  let quote: string | null = null;
  let backtick = false;
  let local = 0;
  while (i < limit) {
    const ch: string = code[i] ?? '';
    const nx: string = code[i + 1] ?? '';
    if (quote !== null) {
      if (ch === '\\') i += 2;
      else if (ch === quote) {
        quote = null;
        i += 1;
      } else i += 1;
      continue;
    }
    if (backtick) {
      if (ch === '\\') i += 2;
      else if (ch === '`' && local === 0) {
        backtick = false;
        i += 1;
      } else if (ch === '$' && nx === '{') {
        local += 1;
        i += 2;
      } else if (ch === '}' && local > 0) {
        local -= 1;
        i += 1;
      } else i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      backtick = true;
      i += 1;
      continue;
    }
    if (ch === '/' && (nx === '/' || nx === '*')) {
      if (nx === '/') {
        const nl: number = code.indexOf('\n', i);
        i = nl < 0 ? limit : Math.min(nl + 1, limit);
      } else {
        const cl: number = code.indexOf('*/', i);
        i = cl < 0 ? limit : Math.min(cl + 2, limit);
      }
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

interface TernarySplit {
  /** `?` の index。 */
  readonly qPos: number;
  /** 対応する `:` の index。 */
  readonly colonPos: number;
}

/**
 * 範囲内の top-level 三項 (`cond ? a : b`) を探す。`?.` / `??` は除外し、
 * nested 三項を数えて対応する `:` を取る。無ければ null。
 */
function splitTernary(code: string, start: number, end: number): TernarySplit | null {
  let qPos = -1;
  let i: number = start;
  let quote: string | null = null;
  let backtick = false;
  let local = 0;
  let depth = 0;
  const scanQ = (): number => {
    while (i < end) {
      const ch: string = code[i] ?? '';
      const nx: string = code[i + 1] ?? '';
      if (quote !== null) {
        if (ch === '\\') i += 2;
        else if (ch === quote) {
          quote = null;
          i += 1;
        } else i += 1;
        continue;
      }
      if (backtick) {
        if (ch === '\\') i += 2;
        else if (ch === '`' && local === 0) {
          backtick = false;
          i += 1;
        } else if (ch === '$' && nx === '{') {
          local += 1;
          i += 2;
        } else if (ch === '}' && local > 0) {
          local -= 1;
          i += 1;
        } else i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        i += 1;
        continue;
      }
      if (ch === '`') {
        backtick = true;
        i += 1;
        continue;
      }
      if (ch === '/' && (nx === '/' || nx === '*')) {
        if (nx === '/') {
          const nl: number = code.indexOf('\n', i);
          i = nl < 0 ? end : Math.min(nl + 1, end);
        } else {
          const cl: number = code.indexOf('*/', i);
          i = cl < 0 ? end : Math.min(cl + 2, end);
        }
        continue;
      }
      if (ch === '{' || ch === '(' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      else if (ch === '?' && depth === 0 && nx !== '.' && nx !== '?') return i;
      i += 1;
    }
    return -1;
  };
  qPos = scanQ();
  if (qPos < 0) return null;
  // 対応する `:` を探す (nested 三項を数える)。
  let nest = 0;
  i = qPos + 1;
  quote = null;
  backtick = false;
  local = 0;
  depth = 0;
  while (i < end) {
    const ch: string = code[i] ?? '';
    const nx: string = code[i + 1] ?? '';
    if (quote !== null) {
      if (ch === '\\') i += 2;
      else if (ch === quote) {
        quote = null;
        i += 1;
      } else i += 1;
      continue;
    }
    if (backtick) {
      if (ch === '\\') i += 2;
      else if (ch === '`' && local === 0) {
        backtick = false;
        i += 1;
      } else if (ch === '$' && nx === '{') {
        local += 1;
        i += 2;
      } else if (ch === '}' && local > 0) {
        local -= 1;
        i += 1;
      } else i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      backtick = true;
      i += 1;
      continue;
    }
    if (ch === '/' && (nx === '/' || nx === '*')) {
      if (nx === '/') {
        const nl: number = code.indexOf('\n', i);
        i = nl < 0 ? end : Math.min(nl + 1, end);
      } else {
        const cl: number = code.indexOf('*/', i);
        i = cl < 0 ? end : Math.min(cl + 2, end);
      }
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === '?') {
      // ponytail: `?.` / `??` は三項ではない。`??` の2文字目は飛ばす。
      if (nx === '.' || nx === '?') {
        i += 2;
        continue;
      }
      nest += 1;
    } else if (depth === 0 && ch === ':') {
      if (nest === 0) return { qPos, colonPos: i };
      nest -= 1;
    }
    i += 1;
  }
  return null;
}

/**
 * template literal の静的部分の範囲を集める (`${}` 内は除く)。
 * start は開き backtick、end は閉じ backtick の次 (exclusive)。
 */
function templateStaticRanges(code: string, start: number, end: number): CodeRange[] {
  const out: CodeRange[] = [];
  let i: number = start + 1;
  let segStart: number = i;
  let depth = 0;
  const push = (to: number): void => {
    if (to > segStart) out.push({ start: segStart, end: to });
  };
  while (i < end) {
    const ch: string = code[i] ?? '';
    const nx: string = code[i + 1] ?? '';
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (depth === 0 && ch === '`') break;
    if (ch === '$' && nx === '{') {
      push(i);
      depth += 1;
      i += 2;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) segStart = i + 1;
    }
    i += 1;
  }
  push(i);
  return out;
}

/** trims。範囲が空なら null。 */
function trimRange(code: string, start: number, end: number): CodeRange | null {
  let s: number = start;
  let e: number = end;
  while (s < e && isWs(code[s] ?? '')) s += 1;
  while (e > s && isWs(code[e - 1] ?? '')) e -= 1;
  return s < e ? { start: s, end: e } : null;
}

/**
 * class 式中の「class 値位置」(書き換えてよい文字列範囲) を集める。
 * 述語 (`===` の比較対象・call 引数・条件式全体等) は含めない。
 * - 文字列全体・配列要素 (再帰)・三項の枝 (再帰)・template 静的部分・
 *   paren 包み (再帰)・object の quoted key。
 */
function markValueRanges(code: string, range: CodeRange, out: CodeRange[]): void {
  const trimmed: CodeRange | null = trimRange(code, range.start, range.end);
  if (trimmed === null) return;
  const text: string = code.slice(trimmed.start, trimmed.end);
  const first: string = text[0] ?? '';
  const last: string = text[text.length - 1] ?? '';
  if ((first === '"' || first === "'") && last === first && text.length >= 2) {
    // 要素全体が1つの文字列か確認する (途中に同 quote が無いこと)。
    let closed = false;
    let k: number = trimmed.start + 1;
    while (k < trimmed.end) {
      const c: string = code[k] ?? '';
      if (c === '\\') k += 2;
      else if (c === first) {
        closed = k === trimmed.end - 1;
        break;
      } else k += 1;
    }
    if (closed) {
      out.push({ start: trimmed.start + 1, end: trimmed.end - 1 });
      return;
    }
  }
  if (first === '`' && last === '`' && text.length >= 2) {
    for (const chunk of templateStaticRanges(code, trimmed.start, trimmed.end)) {
      out.push(chunk);
    }
    return;
  }
  if (first === '[') {
    const close: number = findMatchingBracketInText(code, trimmed.start, trimmed.end);
    if (close === trimmed.end - 1) {
      for (const elem of splitArrayElements(code, trimmed.start, close)) {
        markValueRanges(code, elem, out);
      }
      return;
    }
  }
  if (first === '(') {
    const close: number = findMatchingParenInText(code, trimmed.start, trimmed.end);
    if (close === trimmed.end - 1) {
      markValueRanges(code, { start: trimmed.start + 1, end: close }, out);
      return;
    }
  }
  if (first === '{') {
    const close: number = matchBraceInText(code, trimmed.start);
    if (close >= 0 && close < trimmed.end) {
      // object 形 (`{"cls": cond}`): quoted key のみ class 名として mark する。
      // 値・shorthand・spread は触らない。
      let rest: number = close + 1;
      while (rest < trimmed.end && isWs(code[rest] ?? '')) rest += 1;
      if (rest === trimmed.end) {
        for (const entry of splitTopEntries(code, trimmed.start, close)) {
          let q: number = entry.start;
          while (q < entry.end && isWs(code[q] ?? '')) q += 1;
          const ch: string = code[q] ?? '';
          if (ch !== '"' && ch !== "'") continue;
          const stop: number = findQuoteEnd(code, q);
          if (stop < 0 || stop > entry.end) continue;
          let r: number = stop;
          while (r < entry.end && isWs(code[r] ?? '')) r += 1;
          if ((code[r] ?? '') !== ':') continue;
          out.push({ start: q + 1, end: stop - 1 });
        }
      }
      return;
    }
  }
  const tern: TernarySplit | null = splitTernary(code, trimmed.start, trimmed.end);
  if (tern !== null) {
    // 条件式は述語のため mark しない。枝だけ再帰する。
    markValueRanges(code, { start: tern.qPos + 1, end: tern.colonPos }, out);
    markValueRanges(code, { start: tern.colonPos + 1, end: trimmed.end }, out);
  }
}

/**
 * object 形 (`{key: cond}` / `{key}`) の identifier key を集める。
 * quoted key と違いリテラル走査に現れないため、CSS 供給用に別途収集する。
 * 値位置の quoted key と異なり書換えない (shorthand の binding を壊すため)。
 * 配列要素・三項の枝・paren 包みの中も再帰する。
 */
function collectObjectIdentKeys(code: string, ranges: readonly CodeRange[]): Set<string> {
  const keys = new Set<string>();
  const walk = (start: number, end: number): void => {
    const trimmed: CodeRange | null = trimRange(code, start, end);
    if (trimmed === null) return;
    const first: string = code[trimmed.start] ?? '';
    if (first === '[') {
      const close: number = findMatchingBracketInText(code, trimmed.start, trimmed.end);
      if (close !== trimmed.end - 1) return;
      for (const elem of splitArrayElements(code, trimmed.start, close)) {
        walk(elem.start, elem.end);
      }
      return;
    }
    if (first === '(') {
      const close: number = findMatchingParenInText(code, trimmed.start, trimmed.end);
      if (close !== trimmed.end - 1) return;
      walk(trimmed.start + 1, close);
      return;
    }
    if (first !== '{') {
      // 三項の枝の中の object も見る (条件式は class 値ではないため除く)。
      const tern: TernarySplit | null = splitTernary(code, trimmed.start, trimmed.end);
      if (tern !== null) {
        walk(tern.qPos + 1, tern.colonPos);
        walk(tern.colonPos + 1, trimmed.end);
      }
      return;
    }
    const close: number = matchBraceInText(code, trimmed.start);
    if (close < 0) return;
    let rest: number = close + 1;
    while (rest < trimmed.end && isWs(code[rest] ?? '')) rest += 1;
    if (rest !== trimmed.end) {
      // 三項等の混じり: 全体は触らず、枝だけ見る簡易対応はしない。
      return;
    }
    for (const entry of splitTopEntries(code, trimmed.start, close)) {
      let q: number = entry.start;
      while (q < entry.end && isWs(code[q] ?? '')) q += 1;
      const m: RegExpMatchArray | null = /^[A-Za-z_$][\w$]*/.exec(code.slice(q, entry.end));
      if (m === null) continue;
      // quoted/computed key・spread は対象外。shorthand と `ident:` を拾う。
      keys.add(m[0]);
    }
  };
  for (const range of ranges) walk(range.start, range.end);
  return keys;
}
/**
 * 各 offset の bracket depth。quote・template・comment 対応。
 * `const` 等の top-level 判定用。
 */
function bracketDepths(code: string): Int32Array {
  const depths = new Int32Array(code.length + 1);
  let depth = 0;
  let i = 0;
  let quote: string | null = null;
  let backtick = false;
  let local = 0;
  while (i < code.length) {
    depths[i] = depth;
    const ch: string = code[i] ?? '';
    const nx: string = code[i + 1] ?? '';
    if (quote !== null) {
      if (ch === '\\') i += 2;
      else if (ch === quote) {
        quote = null;
        i += 1;
      } else i += 1;
      continue;
    }
    if (backtick) {
      if (ch === '\\') i += 2;
      else if (ch === '`' && local === 0) {
        backtick = false;
        i += 1;
      } else if (ch === '$' && nx === '{') {
        local += 1;
        i += 2;
      } else if (ch === '}' && local > 0) {
        local -= 1;
        i += 1;
      } else i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      backtick = true;
      i += 1;
      continue;
    }
    if (ch === '/' && (nx === '/' || nx === '*')) {
      if (nx === '/') {
        const nl: number = code.indexOf('\n', i);
        i = nl < 0 ? code.length : nl + 1;
      } else {
        const cl: number = code.indexOf('*/', i);
        i = cl < 0 ? code.length : cl + 2;
      }
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    i += 1;
  }
  depths[code.length] = depth;
  return depths;
}

/** `[` に対応する `]` の index (`limit` 内)。quote・template・comment 対応。 */
function findMatchingBracketInText(code: string, open: number, limit: number): number {
  let depth = 0;
  let i: number = open;
  let quote: string | null = null;
  let backtick = false;
  let local = 0;
  while (i < limit) {
    const ch: string = code[i] ?? '';
    const nx: string = code[i + 1] ?? '';
    if (quote !== null) {
      if (ch === '\\') i += 2;
      else if (ch === quote) {
        quote = null;
        i += 1;
      } else i += 1;
      continue;
    }
    if (backtick) {
      if (ch === '\\') i += 2;
      else if (ch === '`' && local === 0) {
        backtick = false;
        i += 1;
      } else if (ch === '$' && nx === '{') {
        local += 1;
        i += 2;
      } else if (ch === '}' && local > 0) {
        local -= 1;
        i += 1;
      } else i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      backtick = true;
      i += 1;
      continue;
    }
    if (ch === '/' && (nx === '/' || nx === '*')) {
      if (nx === '/') {
        const nl: number = code.indexOf('\n', i);
        i = nl < 0 ? limit : Math.min(nl + 1, limit);
      } else {
        const cl: number = code.indexOf('*/', i);
        i = cl < 0 ? limit : Math.min(cl + 2, limit);
      }
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

interface ObjNode {
  decls: string[];
  kids: Map<string, ObjNode>;
}

/** atoms を `css={{...}}` object text へ (context 順・宣言順は atom 順)。 */
function atomsToObject(atoms: readonly StaticAtom[]): string {
  const root: ObjNode = { decls: [], kids: new Map<string, ObjNode>() };
  const pathOf = (atom: StaticAtom): string[] => {
    const path: string[] = [];
    const context: RuleContext = atom.context;
    // engine の wrapper 順 (外→内) をそのままネストにする。
    if (context.layer !== undefined) {
      path.push(context.layer === '' ? '@layer' : `@layer ${context.layer}`);
    }
    if (context.media !== undefined) path.push(`@media ${context.media}`);
    if (context.supports !== undefined) path.push(`@supports ${context.supports}`);
    if (context.container !== undefined) path.push(`@container ${context.container}`);
    const pseudo: readonly string[] | undefined = context.pseudo;
    if (pseudo !== undefined && pseudo.length > 0) path.push(`&${pseudo.join('')}`);
    return path;
  };
  for (const atom of atoms) {
    const value: string = atom.important ? `${atom.value} !important` : atom.value;
    // ponytail: 識別子として有効な key は bare で出す (手書き記法に寄せる)。
    const key: string = /^[A-Za-z_$][\w$]*$/.test(atom.property)
      ? atom.property
      : JSON.stringify(atom.property);
    const decl: string = `${key}: ${JSON.stringify(value)}`;
    let node: ObjNode = root;
    for (const key of pathOf(atom)) {
      let kid: ObjNode | undefined = node.kids.get(key);
      if (kid === undefined) {
        kid = { decls: [], kids: new Map<string, ObjNode>() };
        node.kids.set(key, kid);
      }
      node = kid;
    }
    node.decls.push(decl);
  }
  const emit = (node: ObjNode): string => {
    const parts: string[] = [...node.decls];
    for (const [key, kid] of node.kids) {
      parts.push(`${JSON.stringify(key)}: { ${emit(kid)} }`);
    }
    return parts.join(', ');
  };
  return `{ ${emit(root)} }`;
}

/**
 * `css\`...\`` tagged template を空白化する (keyframes 等の CSS 文は
 * class 候補ではないため)。`${}` の入れ子に対応する。
 */
function blankCssTemplates(flat: string): string {
  const out: string[] = flat.split('');
  const re = /(?:^|[^\w$])css\s*`/g;
  let m: RegExpExecArray | null;
  for (;;) {
    m = re.exec(flat);
    if (m === null || m.index === undefined) break;
    let i: number = m.index + m[0].length;
    let depth = 0;
    while (i < flat.length) {
      const ch: string = flat[i] ?? '';
      const nx: string = flat[i + 1] ?? '';
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (depth === 0 && ch === '`') break;
      if (ch === '$' && nx === '{') {
        depth += 1;
        i += 2;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    for (let j: number = m.index; j <= Math.min(i, flat.length - 1); j += 1) {
      out[j] = ' ';
    }
    re.lastIndex = i + 1;
  }
  return out.join('');
}

/**
 * module 全体の文字列リテラルから候補 token を集める (verbatim 用)。
 * class 属性・コメント・`from '...'` 指定子は除く。template は `${}` 内を除く。
 * Tailwind と同じく生テキスト走査のため、過剰検出は unmatched 切り捨てで吸収する。
 */
export function collectLiteralTokens(code: string, exclude: readonly [number, number][]): string[] {
  return collectLiteralSpans(code, exclude).map((entry) => entry.token);
}

/** collectLiteralTokens の位置付き版。動的 occurrence の有無判定に使う。 */
export function collectLiteralSpans(
  code: string,
  exclude: readonly [number, number][],
): { token: string; start: number; end: number }[] {
  // コメントと module 指定子を空白化する (offset 保持)。
  let flat: string = code;
  flat = flat.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  flat = flat.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  flat = flat.replace(/from\s*(["'])[^"']*\1/g, (m) => ' '.repeat(m.length));
  // `css` tagged template (keyframes 等の CSS 文) は対象外にする。
  flat = blankCssTemplates(flat);
  const excluded = (start: number, end: number): boolean =>
    exclude.some(([s, e]) => start < e && s < end);
  const tokens: { token: string; start: number; end: number }[] = [];
  const pushChunk = (chunk: string, offset: number): void => {
    if (excluded(offset, offset + chunk.length)) return;
    // escape は境界として扱う (2 文字→空白 2 文字で offset 保持)。
    // 過剰分割は unmatched 切り捨てで吸収する。
    const cleaned: string = chunk.replace(/\\(.)/g, '  ');
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    for (;;) {
      m = re.exec(cleaned);
      if (m === null || m.index === undefined) break;
      let token: string = m[0];
      // ponytail: utility ではあり得ない形は候補にしない。
      // keyframe (`0%`)・関数値 (`var(...)`)・path (`/...`) 等。
      token = token.replace(/^[;,]+|[;,]+$/g, '');
      if (token === '') continue;
      if (/^[\d.]+[a-z%]*$/i.test(token)) continue;
      if (/^[a-zA-Z]+\(/.test(token)) continue;
      if (token.startsWith('/') || token.startsWith('.') || token.startsWith('#')) continue;
      tokens.push({ token, start: offset + m.index, end: offset + m.index + m[0].length });
    }
  };
  let i = 0;
  while (i < flat.length) {
    const ch: string = flat[i] ?? '';
    if (ch === '"' || ch === "'") {
      const quote: string = ch;
      let j: number = i + 1;
      while (j < flat.length && (flat[j] ?? '') !== quote) j += 1;
      // ponytail: offset は内容先頭 (`i + 1`)。quote 位置 (`i`) ではない
      // (span 書換で原文照合するため正確な位置が必要)。
      pushChunk(code.slice(i + 1, j), i + 1);
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      // template: `${...}` を除いた静的部分だけ集める。
      let j: number = i + 1;
      let start: number = j;
      let depth = 0;
      while (j < flat.length) {
        const c: string = flat[j] ?? '';
        const nx: string = flat[j + 1] ?? '';
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (depth === 0 && c === '`') break;
        if (c === '$' && nx === '{') {
          pushChunk(code.slice(start, j), start);
          depth += 1;
          j += 2;
          continue;
        }
        if (c === '{') depth += 1;
        else if (c === '}') {
          depth -= 1;
          if (depth === 0) start = j + 1;
        }
        j += 1;
      }
      if (depth === 0) pushChunk(code.slice(start, j), start);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return tokens;
}

/**
 * `@unocss/vite` の差し替え用 default export。import 元だけ変えれば移行できる
 * (`import UnoCSS from '@unocss/vite'` → `import UnoCSS from '@qstyle/unocss'`)。
 * 引数は同じ物を受け付ける (inline config は `uno.config.ts` に merge され、
 * 文字列は config path)。vite 固有の出力制御 (`mode` 等) は qstyle 配管が
 * 担うため無視する。
 */
export function UnoCSS(options?: QstyleUnoOptions | string): QstyleUnoPlugin {
  let rootDir = '';
  const warned = new Set<string>();
  let resolverPromise: Promise<UnoResolver | null> | null = null;
  // ponytail: `preserveClass` は qstyle 固有の出力制御のため engine config には渡さない。
  const preserveClass: boolean =
    typeof options === 'object' && options !== null
      ? (options as QstyleUnoOptions).preserveClass === true
      : false;
  const unoOptions: QstyleUnoOptions | string | undefined =
    typeof options === 'string' || options === undefined
      ? options
      : (() => {
          const rest: Record<string, unknown> = { ...options };
          delete rest['preserveClass'];
          return rest as QstyleUnoOptions;
        })();

  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[qstyle:unocss] ${message}`);
  };

  const getResolver = (): Promise<UnoResolver | null> => {
    if (resolverPromise !== null) return resolverPromise;
    resolverPromise = (async (): Promise<UnoResolver | null> => {
      try {
        const config = await loadUnoConfig(
          rootDir === '' ? process.cwd() : rootDir,
          unoOptions,
        );
        // preset 無しの bare config では何も解決できないため無効化する。
        if (config.presets === undefined) {
          warnOnce('no-preset', 'uno config has no presets; class conversion is disabled.');
          return null;
        }
        return await createUnoResolver(config);
      } catch (error) {
        const detail: string = error instanceof Error ? error.message : String(error);
        warnOnce('no-config', `cannot load uno config (${detail}); class conversion is disabled.`);
        return null;
      }
    })();
    return resolverPromise;
  };

  /** 内容 hash → virtual id (共有 map に登録する)。id は素形で返す。 */
  const cssIdFor = (cssText: string): string => {
    // ponytail: hash 前に正規化する (whereToIs)。同一内容は同一 id に畳まれ、
    // dev の重複注入も無害になる。
    const normalized: string = whereToIs(cssText);
    const hash: string = fnv1aHex(normalized);
    if (!sharedCssByHash.has(hash)) sharedCssByHash.set(hash, normalized);
    return `${VIRTUAL_PREFIX}c/${hash}.css`;
  };

  /** virtual id → CSS。本文は内容 hash で一意に決まる。 */
  const loadVirtual = (id: string): string | null => {
    const resolved: string | null = resolveUnoId(id);
    if (resolved === null) return null;
    const m: RegExpMatchArray | null = /^c\/([0-9a-f]+)\.css$/.exec(
      resolved.slice(RESOLVED_PREFIX.length),
    );
    if (m === null) return null;
    return sharedCssByHash.get(m[1] as string) ?? null;
  };

  return {
    name: 'qstyle:unocss',
    enforce: 'pre',
    configResolved(config: { root?: string }): void {
      rootDir = (config.root ?? '').replace(/\\/g, '/').replace(/\/$/, '');
    },
    configureServer(server: {
      middlewares: { use(handler: (req: unknown, res: unknown, next: () => void) => void): void };
    }): void {
      // ponytail: SSR の `<link>` からの直接リクエストは Vite の JS ラッパーに
      // なるため、ここで CSS テキストとして返す (qstyle 本体の同等処理に倣う)。
      server.middlewares.use((req: unknown, res: unknown, next: () => void) => {
        const url: string = (
          (req as { url?: unknown }).url ?? ''
        ).toString().split('?')[0] as string;
        if (!url.startsWith('/virtual:qstyle-uno/') || !url.endsWith('.css')) {
          next();
          return;
        }
        const css: string | null = loadVirtual(url);
        const response = res as {
          statusCode: number;
          setHeader: (name: string, value: string) => void;
          end: (body: string) => void;
        };
        if (css === null) {
          response.statusCode = 404;
          response.end('');
          return;
        }
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/css; charset=utf-8');
        response.end(css);
      });
    },
    resolveId(id: string): string | null {
      return resolveUnoId(id);
    },
    load(id: string): string | null {
      return loadVirtual(id);
    },
    async transform(
      code: string,
      id: string,
    ): Promise<{ code: string; map: null } | null> {
      if (!id.endsWith('.tsx') && !id.endsWith('.jsx')) return null;
      if (!code.includes('class')) return null;
      const resolver: UnoResolver | null = await getResolver();
      if (resolver === null) return null;
      const edits: { start: number; end: number; newText: string }[] = [];
      const virtualIds = new Set<string>();
      // 翻訳で消費した class 領域。後段のリテラル走査から除外する。
      // 削減モードでは静的 attr を先に全件確保する (verbatim 分の二重 emit 防止)。
      const consumed: [number, number][] = [];
      // Phase 1/1.5 で css prop を発行した head (`lt`)。同一 head への
      // 二重 css 発行 (不正な JSX) を防ぐ (静的 class と動的 class の重複時)。
      const cssEditedHeads = new Set<number>();
      const ingestGlobals = (
        resolved: Awaited<ReturnType<UnoResolver['resolve']>>,
      ): void => {
        // ponytail: base (reset) は matched がある場合のみ出す。
        // unmatched のみの module に reset を撒くと利用宣言のない app が変わる。
        const hasMatched: boolean =
          resolved.atoms.length > 0 || resolved.verbatimCss.trim() !== '';
        for (const part of [
          resolved.globals.theme,
          resolved.globals.properties,
          ...(hasMatched ? [resolved.globals.base] : []),
          resolved.globals.keyframes,
        ]) {
          if (part.trim() !== '') virtualIds.add(cssIdFor(part));
        }
      };
      const noteUnmatched = (
        resolved: Awaited<ReturnType<UnoResolver['resolve']>>,
      ): void => {
        // ponytail: 静的 class の typo 検出のみ警告する。Record・配列・動的値の
        // リテラル走査分は識別子混じりのため警告しない (全件誤検知になるため)。
        // typo は differential / pixel テストで検出する。
        // matched が無い module の警告は騒音のため出さない。
        // さらに型 union 等の素朴な単語 (dash等を含まない) も出さない。
        const signal: string[] = resolved.unmatched.filter((t) => /[-:/[\]!%.]/.test(t));
        if (signal.length === 0) return;
        if (resolved.atoms.length === 0 && resolved.verbatimCss.trim() === '') return;
        warnOnce(`${id}::unmatched`, `${id}: unknown utilities (${signal.join(', ')}); left as-is`);
      };
      interface StaticWork {
        readonly lt: number;
        readonly head: string;
        readonly attr: ClassAttr;
        readonly preserved: readonly string[];
        readonly convertible: readonly string[];
      }
      // Phase 0: 静的 class attr の走査 (解決は Phase 1)。
      const staticWorks: StaticWork[] = [];
      {
        let from = 0;
        for (;;) {
          const lt: number = code.indexOf('<', from);
          if (lt < 0) break;
          const gt: number | null = findTagEnd(code, lt);
          if (gt === null) break;
          const head: string = code.slice(lt, gt);
          from = gt;
          const attr: ClassAttr | null = findClassAttr(head);
          if (attr === null) continue;
          const preserved: string[] = [];
          const convertible: string[] = [];
          const isPreserved = preserveClass ? isPreservedTokenCompat : isPreservedToken;
          for (const token of tokenizeClassAttr(attr.value)) {
            if (isPreserved(token)) preserved.push(token);
            else convertible.push(token);
          }
          if (convertible.length === 0) continue;
          staticWorks.push({ lt, head, attr, preserved, convertible });
          if (!preserveClass) consumed.push([lt + attr.start, lt + attr.end]);
        }
      }
      // Phase 0b (削減のみ): 動的 class 式 + class 参照 const の値位置を集め、
      // alias 表を作る。値位置以外 (述語・call 引数・aria-label 等) の token は
      // 書換えない (実行時意味を変えないため。原文 CSS でカバーする)。
      // token 分類: value-only (全出現が値位置) のみ alias 化する。
      const aliasMap = new Map<string, string>();
      // object 形の identifier key (リテラル走査に現れない class 名)。
      // 書換えず原文 CSS を供給する (shorthand の binding を壊さないため)。
      let objectKeys: Set<string> = new Set();
      // class 式内の ident key。hoist の property 重なり検査にも使う。
      let exprObjectKeys: Set<string> = new Set();
      if (!preserveClass) {
        const exprs: CodeRange[] = findDynamicClassExprs(code);
        const idents: Set<string> = collectExprIdents(code, exprs);
        // 値位置 marking。
        const marked: CodeRange[] = [];
        for (const expr of exprs) markValueRanges(code, expr, marked);
        const constRanges: CodeRange[] = [];
        for (const init of findConstInits(code, idents)) {
          const props: Set<string> = memberPropsOf(code, exprs, init.name);
          const initText: string = code.slice(init.start, init.end);
          if (/^\s*\{/.test(initText) && props.size > 0) {
            for (const span of propValueSpans(code, init.start, init.end, props)) {
              marked.push(span);
              constRanges.push(span);
            }
          } else {
            marked.push({ start: init.start, end: init.end });
            constRanges.push({ start: init.start, end: init.end });
          }
        }
        objectKeys = collectObjectIdentKeys(code, [...exprs, ...constRanges]);
        exprObjectKeys = collectObjectIdentKeys(code, exprs);
        const spans = collectLiteralSpans(code, consumed);
        // token ごとの出現分類。
        const inValue = new Set<string>();
        const inOther = new Set<string>();
        const outRange = new Set<string>();
        {
          const exprRanges: CodeRange[] = exprs.filter(
            (r) => !consumed.some(([s, e]) => r.start < e && s < r.end),
          );
          for (const span of spans) {
            if ((code.slice(span.start, span.end) ?? '') !== span.token) continue;
            if (isPreservedToken(span.token)) continue;
            if (!insideRanges(span, exprRanges)) {
              // class 式外 (const 初期化子を含む): mark 済みなら値位置。
              if (insideRanges(span, marked)) inValue.add(span.token);
              else outRange.add(span.token);
              continue;
            }
            if (insideRanges(span, marked)) inValue.add(span.token);
            else inOther.add(span.token);
          }
        }
        for (const work of staticWorks) {
          for (const token of work.convertible) {
            // 静的 attr 自体は値位置。ただし他所に非値出現があれば原文維持する。
            if (inOther.has(token) || outRange.has(token)) continue;
            aliasMap.set(token, aliasForUtilityToken(token));
          }
        }
        for (const token of inValue) {
          if (inOther.has(token) || outRange.has(token)) continue;
          aliasMap.set(token, aliasForUtilityToken(token));
        }
        // identifier key は書換えない (原文 CSS のみ)。
        for (const key of objectKeys) aliasMap.delete(key);
      }
      const aliases: ReadonlyMap<string, string> | undefined = preserveClass
        ? undefined
        : aliasMap;
      // Phase 1: 静的 class attr の解決。
      for (const work of staticWorks) {
        const { lt, head, attr, preserved, convertible } = work;
        const resolved =
          aliases === undefined
            ? await resolver.resolve(convertible)
            : await resolver.resolve(convertible, { aliases });
        ingestGlobals(resolved);
        noteUnmatched(resolved);
        if (resolved.verbatimCss.trim() !== '') {
          if (preserveClass) {
            // verbatim: 原文のまま virtual CSS に出し、class は触らない。
            virtualIds.add(cssIdFor(resolved.verbatimCss));
            continue;
          }
          // 削減: matched は alias に置換し、unmatched のみ残す。
          // selector 構造は維持されるため cascade は engine 出力と同一。
          const unmatchedSet = new Set<string>(resolved.unmatched);
          const kept: string[] = [];
          for (const token of tokenizeClassAttr(attr.value)) {
            if (isPreservedToken(token)) {
              kept.push(token);
              continue;
            }
            if (unmatchedSet.has(token)) {
              kept.push(token);
              continue;
            }
            kept.push(aliasMap.get(token) ?? token);
          }
          virtualIds.add(cssIdFor(resolved.verbatimCss));
          const keptText: string = kept.join(' ');
          if (keptText !== attr.value) {
            edits.push({
              start: lt + attr.start,
              end: lt + attr.end,
              newText: `${attr.keyword}=${attr.quote}${keptText}${attr.quote}`,
            });
          }
          continue;
        }
        if (resolved.atoms.length === 0) continue;
        if (preserveClass) consumed.push([lt + attr.start, lt + attr.end]);
        const translated: string = atomsToObject(resolved.atoms);
        const existing: CssProp | null = findCssProp(head);
        if (existing !== null) {
          // 既存 css の後に追記する (composition は後勝ちのため翻訳が勝つ)。
          // ponytail: paren で包まない (composition parser が object/ternary を
          // 直接受理するため。包むと parse 不能になる)。
          const inner: string = code.slice(
            lt + existing.braceOpen + 1,
            lt + existing.braceClose - 1,
          );
          edits.push({
            start: lt + existing.kwStart,
            end: lt + existing.braceClose,
            newText: `css={[${inner}, ${translated}]}`,
          });
          cssEditedHeads.add(lt);
        } else {
          const tagName: RegExpMatchArray | null = /^<[A-Za-z][\w.-]*/.exec(head);
          if (tagName === null) continue;
          edits.push({
            start: lt + tagName[0].length,
            end: lt + tagName[0].length,
            newText: ` css={${translated}}`,
          });
          cssEditedHeads.add(lt);
        }
        const kept: string = [...preserved, ...resolved.unmatched].join(' ');
        if (kept === '') {
          edits.push({ start: lt + attr.start, end: lt + attr.end, newText: '' });
        } else if (kept !== attr.value) {
          edits.push({
            start: lt + attr.start,
            end: lt + attr.end,
            newText: `${attr.keyword}=${attr.quote}${kept}${attr.quote}`,
          });
        }
      }
      // Phase 1.5 (削減のみ): 動的 class 配列の静的文字列要素を union 解決し、
      // atom 化できれば `css` へ hoist する (qstyle 本体の dedup・chunk 配管に載る)。
      // 動的要素の utilities と property が重なれば alias に落とす
      // (css/verbatim のファイル間順序を保証できないため)。
      // 解決済み class 領域・除去済み要素は collect 時に除外する。
      const literalSpansEarly = preserveClass ? [] : collectLiteralSpans(code, consumed);
      if (!preserveClass) {
        let fromHoist = 0;
        for (;;) {
          const lt: number = code.indexOf('<', fromHoist);
          if (lt < 0) break;
          const gt: number | null = findTagEnd(code, lt);
          if (gt === null) break;
          const head: string = code.slice(lt, gt);
          fromHoist = gt;
          if (cssEditedHeads.has(lt)) continue;
          const dyn: ClassAttrDynamic | null = findDynamicClassInHead(head);
          if (dyn === null) continue;
          const exprOpen: number = lt + dyn.braceOpen + 1;
          const exprClose: number = lt + dyn.braceClose;
          let pb: number = exprOpen;
          while (pb < exprClose && isWs(code[pb] ?? '')) pb += 1;
          if ((code[pb] ?? '') !== '[') continue;
          const arrClose: number = findMatchingBracketInText(code, pb, exprClose);
          if (arrClose < 0) continue;
          let pa: number = arrClose + 1;
          while (pa < exprClose && isWs(code[pa] ?? '')) pa += 1;
          if (pa !== exprClose) continue;
          const elems: ArrayElement[] = splitArrayElements(code, pb, arrClose);
          if (elems.length === 0) continue;
          const staticParts: { elem: ArrayElement; tokens: string[] }[] = [];
          const dynamicRanges: CodeRange[] = [];
          for (const elem of elems) {
            const content: string | null = staticStringContent(code, elem);
            if (content === null) {
              dynamicRanges.push({ start: elem.start, end: elem.end });
              continue;
            }
            const tokens: string[] = content.split(/\s+/).filter((t) => t !== '');
            if (tokens.length === 0) continue;
            staticParts.push({ elem, tokens });
          }
          if (staticParts.length === 0) continue;
          const staticTokens: string[] = [
            ...new Set(staticParts.flatMap((s) => s.tokens)),
          ].filter((t) => !isPreservedToken(t));
          if (staticTokens.length === 0) continue;
          const staticResolved =
            aliases === undefined
              ? await resolver.resolve(staticTokens)
              : await resolver.resolve(staticTokens, { aliases });
          ingestGlobals(staticResolved);
          noteUnmatched(staticResolved);
          if (staticResolved.verbatimCss.trim() !== '' || staticResolved.atoms.length === 0) {
            // verbatim: alias path に譲る (CSS は第2 pass で出すためここでは出さない)。
            continue;
          }
          // 動的要素の property 集合。verbatim 級が混じれば順序不明のため落とす。
          // object 形の ident key も class 名のため property 検査に含める。
          const dynProps = new Set<string>();
          {
            const seenDyn = new Set<string>();
            const dynTokens: string[] = [];
            for (const span of literalSpansEarly) {
              if (!insideRanges(span, dynamicRanges)) continue;
              if (seenDyn.has(span.token)) continue;
              seenDyn.add(span.token);
              dynTokens.push(span.token);
            }
            for (const key of exprObjectKeys) {
              if (seenDyn.has(key)) continue;
              seenDyn.add(key);
              dynTokens.push(key);
            }
            const dynConvertible: string[] = dynTokens.filter((t) => !isPreservedToken(t));
            if (dynConvertible.length > 0) {
              const dynResolved = await resolver.resolve(dynConvertible);
              ingestGlobals(dynResolved);
              if (dynResolved.verbatimCss.trim() !== '') continue;
              for (const atom of dynResolved.atoms) dynProps.add(atom.property);
            }
          }
          let risky = false;
          for (const atom of staticResolved.atoms) {
            for (const dynProp of dynProps) {
              if (atom.property === dynProp || orderRiskProperty(atom.property, dynProp)) {
                risky = true;
                break;
              }
            }
            if (risky) break;
          }
          if (risky) continue;
          const unmatchedSet = new Set<string>(staticResolved.unmatched);
          // 部分一致の要素 (matched + unmatched/preserved 混じり) があれば
          // hoist しない。css と alias の二重適用で cascade が変わるため。
          // 全要素除去可能か、混じりが無い場合のみ進む (alias path に譲る)。
          let blocked = false;
          const removable: { elem: ArrayElement }[] = [];
          for (const part of staticParts) {
            const convertible: string[] = part.tokens.filter((t) => !isPreservedToken(t));
            if (convertible.length === 0) continue;
            const matched: string[] = convertible.filter((t) => !unmatchedSet.has(t));
            if (matched.length === 0) continue;
            const hasPreserved: boolean = part.tokens.some((t) => isPreservedToken(t));
            if (matched.length === convertible.length && !hasPreserved) {
              removable.push({ elem: part.elem });
              continue;
            }
            blocked = true;
            break;
          }
          if (blocked) continue;
          if (removable.length === 0) continue;
          const translated: string = atomsToObject(staticResolved.atoms);
          const existing: CssProp | null = findCssProp(head);
          if (existing !== null) {
            const inner: string = code.slice(
              lt + existing.braceOpen + 1,
              lt + existing.braceClose - 1,
            );
            edits.push({
              start: lt + existing.kwStart,
              end: lt + existing.braceClose,
              newText: `css={[${inner}, ${translated}]}`,
            });
          } else {
            const tagName: RegExpMatchArray | null = /^<[A-Za-z][\w.-]*/.exec(head);
            if (tagName === null) continue;
            edits.push({
              start: lt + tagName[0].length,
              end: lt + tagName[0].length,
              newText: ` css={${translated}}`,
            });
          }
          cssEditedHeads.add(lt);
          const removableSet = new Set<ArrayElement>(removable.map((r) => r.elem));
          const kept: ArrayElement[] = elems.filter((e) => !removableSet.has(e));
          if (kept.length === 0) {
            // 全要素除去 → attr ごと削除。
            edits.push({
              start: lt + dyn.kwStart,
              end: lt + dyn.braceClose + 1,
              newText: '',
            });
            consumed.push([lt + dyn.kwStart, lt + dyn.braceClose + 1]);
          } else {
            // gap 単位で除去する (要素単位だと連続除去の範囲が重なる)。
            // 先頭 gap・要素間 gap・末尾 gap の最大3範囲。互いに重ならない。
            const firstKept: ArrayElement = kept[0] as ArrayElement;
            const firstElem: ArrayElement = elems[0] as ArrayElement;
            if (firstKept.start > firstElem.start) {
              edits.push({ start: firstElem.start, end: firstKept.start, newText: '' });
              consumed.push([firstElem.start, firstKept.start]);
            }
            for (let k = 0; k + 1 < kept.length; k += 1) {
              const a: ArrayElement = kept[k] as ArrayElement;
              const b: ArrayElement = kept[k + 1] as ArrayElement;
              // 隣接要素間 (除去対象のみ) を除去する。comma を1つ残す。
              let adjacent = true;
              for (let j = 0; j < elems.length; j += 1) {
                const e: ArrayElement = elems[j] as ArrayElement;
                if (e.start > a.end && e.end < b.start) {
                  adjacent = false;
                  break;
                }
              }
              if (!adjacent) {
                edits.push({ start: a.end, end: b.start, newText: ',' });
                consumed.push([a.end, b.start]);
              }
            }
            const lastKept: ArrayElement = kept[kept.length - 1] as ArrayElement;
            const lastElem: ArrayElement = elems[elems.length - 1] as ArrayElement;
            if (lastKept.end < lastElem.end) {
              edits.push({ start: lastKept.end, end: lastElem.end, newText: '' });
              consumed.push([lastKept.end, lastElem.end]);
            }
          }
        }
      }
      // 第2 pass: class 属性外のリテラル (Record 参照・class 配列等) は
      // verbatim 専用で拾う。削減モードでは class 用途の範囲のみ alias に
      // 書き換える (範囲外は動的合成の特定ができないため原文＋原文 CSS のまま)。
      // 翻訳済み class 領域は collect 時に除外済み。解決済み token でも
      // 翻訳範囲外に出現すれば拾う (条件付き要素と動的参照の両立のため。
      // 重複分は同一宣言のため無害)。
      const literalSpans = collectLiteralSpans(code, consumed);
      const extra: string[] = [];
      {
        const seen = new Set<string>();
        for (const span of literalSpans) {
          if (seen.has(span.token)) continue;
          seen.add(span.token);
          extra.push(span.token);
        }
        // object 形の identifier key (リテラル走査に現れない class 名)。
        // 原文 CSS の供給用。書換えはしない。
        for (const key of objectKeys) {
          if (seen.has(key)) continue;
          seen.add(key);
          extra.push(key);
        }
      }
      if (extra.length > 0) {
        const resolved =
          aliases === undefined
            ? await resolver.resolve(extra, { verbatimOnly: true })
            : await resolver.resolve(extra, { verbatimOnly: true, aliases });
        ingestGlobals(resolved);
        if (resolved.verbatimCss.trim() !== '') {
          virtualIds.add(cssIdFor(resolved.verbatimCss));
        }
        if (!preserveClass) {
          const unmatchedSet = new Set<string>(resolved.unmatched);
          // aliasMap の key は value-only token のみ (述語・範囲外混じりは除外済み)。
          for (const span of literalSpans) {
            if ((code.slice(span.start, span.end) ?? '') !== span.token) continue;
            if (unmatchedSet.has(span.token)) continue;
            const alias: string | undefined = aliasMap.get(span.token);
            if (alias === undefined) continue;
            edits.push({ start: span.start, end: span.end, newText: alias });
          }
        }
      }
      const imports: string[] = [];
      for (const virtualId of virtualIds) {
        if (!code.includes(virtualId)) imports.push(`import "${virtualId}";`);
      }
      if (imports.length > 0) {
        edits.push({ start: 0, end: 0, newText: `${imports.join('\n')}\n` });
      }
      if (edits.length === 0) return null;
      const sorted = [...edits].sort((a, b) => b.start - a.start);
      let out: string = code;
      for (const edit of sorted) {
        out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
      }
      return { code: out, map: null };
    },
  };
}
