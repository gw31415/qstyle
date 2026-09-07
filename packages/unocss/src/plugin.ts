// `@qstyle/unocss` の Vite plugin (qstyle 本体より前に置く)。
// class ユーティリティを `css` prop へ翻訳し、qstyle 本体の配管に載せる。
// qstyle 本体はこの plugin の存在を知らない (境界面はコードのみ)。
// engine・config・変換意味論はすべてこの package 内に閉じる。
import { fnv1aHex } from '@qstyle/core';
import type { RuleContext, StaticAtom } from '@qstyle/core';
import type { UserConfig } from 'unocss';
import { createUnoResolver, loadUnoConfig, tokenizeClassAttr } from './index.js';
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
      pushChunk(code.slice(i + 1, j), i);
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
          options,
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
      const consumed: [number, number][] = [];
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
        for (const token of tokenizeClassAttr(attr.value)) {
          if (token.startsWith('q_') || token.startsWith('qd_')) preserved.push(token);
          else convertible.push(token);
        }
        if (convertible.length === 0) continue;
        const resolved = await resolver.resolve(convertible);
        ingestGlobals(resolved);
        noteUnmatched(resolved);
        if (resolved.verbatimCss.trim() !== '') {
          // verbatim: 原文のまま virtual CSS に出し、class は触らない。
          virtualIds.add(cssIdFor(resolved.verbatimCss));
          continue;
        }
        if (resolved.atoms.length === 0) continue;
        consumed.push([lt + attr.start, lt + attr.end]);
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
        } else {
          const tagName: RegExpMatchArray | null = /^<[A-Za-z][\w.-]*/.exec(head);
          if (tagName === null) continue;
          edits.push({
            start: lt + tagName[0].length,
            end: lt + tagName[0].length,
            newText: ` css={${translated}}`,
          });
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
      // 第2 pass: class 属性外のリテラル (Record 参照・class 配列等) は
      // verbatim 専用で拾う。書き換えはしない (動的合成のため)。
      // 翻訳済み class 領域は collect 時に除外済み。解決済み token でも
      // 翻訳範囲外に出現すれば拾う (条件付き要素と動的参照の両立のため。
      // 重複分は同一宣言のため無害)。
      const extra: string[] = [];
      {
        const seen = new Set<string>();
        for (const span of collectLiteralSpans(code, consumed)) {
          if (seen.has(span.token)) continue;
          seen.add(span.token);
          extra.push(span.token);
        }
      }
      if (extra.length > 0) {
        const resolved = await resolver.resolve(extra, { verbatimOnly: true });
        ingestGlobals(resolved);
        if (resolved.verbatimCss.trim() !== '') {
          virtualIds.add(cssIdFor(resolved.verbatimCss));
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
