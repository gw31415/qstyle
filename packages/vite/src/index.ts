import type { HmrContext, Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_CHUNK_OPTIONS,
  VERSION,
  assetFileName,
  buildRouteManifest,
  canonicalProperty,
  chunkHash,
  createParametricAtom,
  createUsageGraph,
  fnv1aHex,
  hashParametricAtom,
  hashStaticAtom,
  needsOrderingGroup,
  planChunks,
  recordComponentRoute,
  recordSource,
  recordUsage,
  serializeManifest,
  serializeParametricCss,
  serializeParametricDecl,
} from '@qstyle/core';
import type {
  ChunkInput,
  ChunkOptions,
  ChunkPlan,
  ParametricAtom,
  ResidualRuleNode,
  RuleContext,
  RuntimeSlotNode,
  StaticAtom,
  StyleManifest,
  TemplatePartInput,
  TemplateSlotInput,
  UsageGraph,
} from '@qstyle/core';
import { composeCssProp, lowerStyleObject, lowerTaggedTemplate } from '@qstyle/qwik';
import { groupDuplicateCss } from './dedup.js';
import type { StyleHandle, StyleObject } from '@qstyle/qwik';

export type OptimizationLevel = 'preserve' | 'safe' | 'strict';
export type BackendKind = 'qwik-native' | 'css-asset';

export interface QstyleOptions {
  readonly optimization?: OptimizationLevel | undefined;
  readonly backend?: BackendKind | undefined;
  readonly runtimeStyles?: {
    readonly strategy?: 'custom-property' | undefined;
    readonly fallback?: 'inline' | undefined;
    readonly promotion?: 'never' | 'cost-based' | 'always' | undefined;
  } | undefined;
  readonly composition?: {
    readonly falsy?: 'ignore' | undefined;
  } | undefined;
  readonly chunking?: {
    readonly strategy?: 'usage-cluster' | undefined;
    readonly minChunkBytes?: number | undefined;
    readonly maxChunkBytes?: number | undefined;
  } | undefined;
  /** route -> その route が描画する module path の list (§45 route manifest の逆引き元)。 */
  readonly routes?: Record<string, readonly string[]> | undefined;
  readonly diagnostics?: 'silent' | 'warning' | 'error' | undefined;
  readonly debug?: boolean | undefined;
}

export interface CollectedStyle {
  readonly id: string;
  readonly cssText: string;
  readonly sourceId: string;
  /** unit 構成 atom ids (delivery = unit、identity = atom。§3.3/§38)。 */
  readonly members?: readonly string[];
}

/**
 * css-asset backend の出力 chunk 1 件 (plan.md §3.4 R1.1/R1.2)。
 * `fileName` は最終 serialize (chunk 内 dedup 適用後) bytes の content hash から決まる。
 */
export interface CssAssetChunk {
  /** ChunkPlan と同じ pack id (member 集合のみから導出)。 */
  readonly id: string;
  /** sorted unit ids。 */
  readonly members: readonly string[];
  /** unit css の合計 bytes (plan 計算用。dedup 後の bytes ではない)。 */
  readonly bytes: number;
  /** `assets/qstyle.<hash>.css` — emit される asset 名。 */
  readonly fileName: string;
  /** 最終 CSS text (§39 v1 dedup 適用済み)。emit される内容そのもの。 */
  readonly cssText: string;
}

/** css-asset backend の build 計画。unit → fileName の逆引き index を持つ (§3.4 R1.3)。 */
export interface CssAssetPlan {
  readonly chunks: readonly CssAssetChunk[];
  /** 各 unit は恰好 1 chunk に属する。 */
  readonly unitToFile: ReadonlyMap<string, string>;
}

/**
 * legacy Qwik style hook の利用記録 (plan.md §24)。
 * scoped semantics は解除せず Qwik lifecycle に残すため、rewrite 対象にはしない。
 * provenance 追跡と将来の SSG route linkage の入力にする。
 */
export interface LegacyStyleUsage {
  readonly module: string;
  /** `useStyles$` (global) / `useStylesScoped$` (scoped)。 */
  readonly hook: 'global' | 'scoped';
  /** hook に渡された identifier。 */
  readonly local: string;
  /** `*.css?inline` import で解決できた CSS path。解決できなければ null。 */
  readonly cssPath: string | null;
}

/**
 * `import X from './y.css?inline'` の default import を集める。
 * side-effect import や名前付き import は対象外。
 */
function collectCssInlineImports(code: string): Map<string, string> {
  const table = new Map<string, string>();
  const re = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+\.css\?inline)["']/g;
  let m: RegExpExecArray | null;
  for (;;) {
    m = re.exec(code);
    if (m === null) break;
    const local: string = m[1] as string;
    const path: string = m[2] as string;
    if (!table.has(local)) table.set(local, path);
  }
  return table;
}

/**
 * `useStyles$(X)` / `useStylesScoped$(X)` (identifier 引数のみ) を集める。
 * member 式・call 式引数は解決できないため対象外。
 */
function collectLegacyHookUsages(code: string, module: string): LegacyStyleUsage[] {
  const cssImports: ReadonlyMap<string, string> = collectCssInlineImports(code);
  const out: LegacyStyleUsage[] = [];
  const re = /\b(useStylesScoped\$|useStyles\$)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
  let m: RegExpExecArray | null;
  for (;;) {
    m = re.exec(code);
    if (m === null) break;
    const hookName: string = m[1] as string;
    const local: string = m[2] as string;
    out.push({
      module,
      hook: hookName === 'useStylesScoped$' ? 'scoped' : 'global',
      local,
      cssPath: cssImports.get(local) ?? null,
    });
  }
  return out;
}

const VIRTUAL_PREFIX = 'virtual:qstyle/';
const RESOLVED_PREFIX = '\0virtual:qstyle/';

/** dev virtual css の key (`virtual:qstyle/dev/<key>`)。module id 全体を hash 化し衝突を避ける。 */
function devKeyFor(moduleId: string): string {
  return `${fnv1aHex(moduleId).slice(0, 8)}.css`;
}

/** dev virtual css の module id (resolveId/load/handleHotUpdate で共有する)。 */
function devModuleId(moduleId: string): string {
  return `${RESOLVED_PREFIX}dev/${devKeyFor(moduleId)}`;
}

/** residual log の上限 (inspector 表示・メモリ発散防止。ponytail: 十分大きい固定値)。 */
const MAX_RESIDUAL_LOG = 256;

/**
 * css-asset backend 用の route style loader (`virtual:qstyle/route-loader`)。
 * build 時に emit される `qstyle.routes.json` を読み、route に必要な hashed assets を
 * `<link rel="stylesheet">` で注入する。manifest 解決の純粋部は `@qstyle/core` の
 * resolveRouteAssets に委ねる。自動 head 差し込み (SSR/SSG 連携) は framework adapter の責務。
 */
const ROUTE_LOADER_SOURCE: string = `import { resolveRouteAssets } from '@qstyle/core';

const MANIFEST_FILE = 'qstyle.routes.json';

function loaderBaseUrl() {
  try {
    const base = import.meta.env?.BASE_URL ?? '/';
    return new URL(base, document.baseURI).toString();
  } catch {
    return '/';
  }
}

function ensureStylesheet(href) {
  if (document.querySelector('link[data-qstyle-href="' + href.replace(/"/g, '%22') + '"]')) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.qstyleHref = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error('[qstyle] failed to load ' + href));
    document.head.appendChild(link);
  });
}

/** route に必要な style assets を読み込む。既読 asset は再 fetch しない。 */
export async function loadRouteStyles(route) {
  const manifestUrl = new URL(MANIFEST_FILE, loaderBaseUrl()).toString();
  const res = await fetch(manifestUrl);
  if (!res.ok) {
    throw new Error('[qstyle] failed to fetch ' + MANIFEST_FILE + ': ' + res.status);
  }
  const manifest = await res.json();
  const assets = resolveRouteAssets(manifest, route);
  const base = loaderBaseUrl();
  const hrefs = assets.map((asset) => new URL(asset, base).toString());
  await Promise.all(hrefs.map(ensureStylesheet));
  return hrefs;
}
`;

function resolveQstyleId(id: string): string | null {
  // dev の `<link href="/virtual:qstyle/...">` は先頭 '/' 付き URL としてブラウザから
  // 直接リクエストされるため、leading slash を剥がして同一 module として解決する。
  if (id.startsWith('/')) id = id.slice(1);
  if (id.startsWith(VIRTUAL_PREFIX)) {
    return `${RESOLVED_PREFIX}${id.slice(VIRTUAL_PREFIX.length)}`;
  }
  if (id.startsWith(RESOLVED_PREFIX)) {
    return id;
  }
  return null;
}

/** 動的な値として抽出した 1 宣言分の情報 (M5c)。 */
export interface DynamicStyleValue {
  /** diagnostic 用の dotted path (top-level なら key そのもの)。 */
  readonly propPath: string;
  /** 抽出した式の source text (identifier / member chain のみ)。 */
  readonly exprSource: string;
}

/**
 * 有限静的 ternary 値 (DYN-016: `color: cond ? 'red' : 'gray'`)。
 * 両枝が static literal (string/number) または null の場合のみ成立し、
 * ParametricAtom ではなく複数 StaticAtom + runtime class choice にする。
 */
export interface ConditionalStyleValue {
  /** top-level property のみ (nested は呼び出し側で拒否する)。 */
  readonly propPath: string;
  /** 条件式の source text。 */
  readonly condSource: string;
  readonly whenTrue: string | number | null;
  readonly whenFalse: string | number | null;
}

/**
 * object 構文内の template literal 値 (DYN-006/007: `` transform: `translateX(${x}px)` ``)。
 * 静的部分と runtime 式の交互列を AST として保ち、複合 ParametricAtom へ落とす。
 */
export interface CompoundStyleValue {
  /** top-level property のみ (nested は呼び出し側で拒否する)。 */
  readonly propPath: string;
  readonly segments: readonly (
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'expr'; readonly expr: string }
  )[];
}

export interface ParsedStyleLiteral {
  /** 静的に解決できた宣言のみを含む record (動的な key は除外)。 */
  readonly record: Record<string, unknown>;
  readonly dynamics: readonly DynamicStyleValue[];
  readonly conditionals: readonly ConditionalStyleValue[];
  readonly compounds: readonly CompoundStyleValue[];
}

/**
 * 動的値として受理する安全な grammar: identifier / member chain のみ
 * (`a.b.c` / `a?.b` / `a[0].b`)。call・ternary・template・spread は不受理。
 * prefix 一致の後、直後が区切り文字であることも検証する。残余が消費されずに
 * 残れば object parser 全体が null になるため、ternary 等は自然に拒否される。
 */
const DYNAMIC_EXPR_RE = /^[A-Za-z_$][\w$]*(?:(?:\.|\?\.)[A-Za-z_$][\w$]*|\[\d+\])*/;
const DYNAMIC_EXPR_END_RE = /[\s,}]/;

/** CSS property key (`width` / `--x` / `-webkit-transform`) の最小検証。 */
const CSS_PROPERTY_RE = /^(?:--|-)?[A-Za-z][\w-]*$/;

type ParsedValueResult = {
  readonly hasDynamic: boolean;
  readonly value: unknown;
};

type ParsedObjectResult = {
  readonly obj: Record<string, unknown>;
  readonly hasDynamic: boolean;
};

/**
 * style object literal の最小安全パーサ本体 (plan.md §20, M2 + M5c 動的値)。
 * string (escape 対応) / number / true/false/null / nested plain object /
 * trailing comma を受理し、withDynamics 時は identifier / member chain を
 * 動的な値として抽出する。それ以外 (spread, call, ternary, function,
 * template, comment) に遭遇したら null を返す。eval は使わない。
 * 動的な値を含む nested object は静的 record から親 key ごと除外する。
 */
function parseStyleObjectImpl(src: string, withDynamics: boolean): ParsedStyleLiteral | null {
  const parser: { index: number } = { index: 0 };
  const dynamics: DynamicStyleValue[] = [];
  const conditionals: ConditionalStyleValue[] = [];
  const compounds: CompoundStyleValue[] = [];

  function skipWs(): void {
    while (parser.index < src.length && /\s/.test(src[parser.index] ?? '')) {
      parser.index += 1;
    }
  }

  function parseString(): string | null {
    const quote: string | undefined = src[parser.index];
    if (quote !== '"' && quote !== "'") return null;
    parser.index += 1;
    let out = '';
    while (parser.index < src.length) {
      const ch: string = src[parser.index] ?? '';
      if (ch === '\\') {
        const next: string = src[parser.index + 1] ?? '';
        if (next === '') return null;
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
        parser.index += 2;
        continue;
      }
      if (ch === quote) {
        parser.index += 1;
        return out;
      }
      if (ch === '\n') return null;
      out += ch;
      parser.index += 1;
    }
    return null;
  }

  function parseNumber(): number | null {
    const rest: string = src.slice(parser.index);
    const m: RegExpMatchArray | null = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (m === null) return null;
    parser.index += m[0].length;
    const n: number = Number(m[0]);
    return Number.isFinite(n) ? n : null;
  }

  /** identifier / member chain を動的な値として読む (withDynamics 時のみ)。 */
  function parseDynamicExpr(): string | null {
    const rest: string = src.slice(parser.index);
    const m: RegExpMatchArray | null = DYNAMIC_EXPR_RE.exec(rest);
    if (m === null) return null;
    const expr: string = m[0];
    const after: string | undefined = rest[expr.length];
    // 式の直後は区切り文字 (空白 / `,` / `}` / 終端) でなければならない。
    if (after !== undefined && !DYNAMIC_EXPR_END_RE.test(after)) return null;
    parser.index += expr.length;
    return expr;
  }

  /** static literal (string/number/`null`) を読む。読めなければ index を戻して null。 */
  function parseStaticLiteralBranch(): string | number | null | undefined {
    const start: number = parser.index;
    skipWs();
    const ch: string | undefined = src[parser.index];
    if (ch === '"' || ch === "'") {
      const s: string | null = parseString();
      return s === null ? (parser.index = start, undefined) : s;
    }
    if (ch === '-' || ch === '.' || (ch !== undefined && ch >= '0' && ch <= '9')) {
      const n: number | null = parseNumber();
      return n === null ? (parser.index = start, undefined) : n;
    }
    if (src.startsWith('null', parser.index)) {
      parser.index += 'null'.length;
      return null;
    }
    parser.index = start;
    return undefined;
  }

  /**
   * 有限静的 ternary 値 (`cond ? lit : lit`) を読む (DYN-016)。
   * 成立すれば conditionals へ積み、true を返す。失敗時は index を戻して false。
   */
  function tryParseConditionalValue(path: string): boolean {
    const start: number = parser.index;
    // 条件式の終端 (top-level `?`) を探す。文字列・括弧対応、危険な字句では不成立。
    let depth = 0;
    let quote: string | null = null;
    let q = -1;
    let i: number = start;
    for (; i < src.length; i += 1) {
      const ch: string = src[i] ?? '';
      if (quote !== null) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '`' || (ch === '/' && (src[i + 1] === '/' || src[i + 1] === '*'))) {
        return false;
      }
      if (ch === '[' || ch === '{' || ch === '(') depth += 1;
      else if (ch === ']' || ch === '}' || ch === ')') {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && ch === '?') {
        const next: string = src[i + 1] ?? '';
        if (next === '.' || next === '?') continue;
        q = i;
        break;
      } else if (depth === 0 && (ch === ',' || ch === '}')) {
        break;
      }
    }
    if (q < 0) return false;
    const condSource: string = src.slice(start, q).trim();
    if (!isSafeCondition(condSource)) return false;
    // 条件式内のネスト ternary は未対応。
    if (findTernaryQuestion(condSource) >= 0) return false;
    parser.index = q + 1;
    const whenTrue: string | number | null | undefined = parseStaticLiteralBranch();
    if (whenTrue === undefined) {
      parser.index = start;
      return false;
    }
    skipWs();
    if (src[parser.index] !== ':') {
      parser.index = start;
      return false;
    }
    parser.index += 1;
    const whenFalse: string | number | null | undefined = parseStaticLiteralBranch();
    if (whenFalse === undefined) {
      parser.index = start;
      return false;
    }
    conditionals.push({ propPath: path, condSource, whenTrue, whenFalse });
    return true;
  }

  /** template 静的部分の escape を解決する。\` / \$ / \\ のみ受理し、他は null。 */
  function unescapeTemplateText(text: string): string | null {
    let out = '';
    for (let i = 0; i < text.length; i += 1) {
      const ch: string = text[i] ?? '';
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const next: string = text[i + 1] ?? '';
      if (next === '`' || next === '$' || next === '\\') {
        out += next;
        i += 1;
        continue;
      }
      return null;
    }
    return out;
  }

  /**
   * backtick 値を読む。interpolation なしなら static text、あれば compound
   * entry へ積む。失敗時は index を戻して null。
   */
  function tryParseTemplateValue(path: string): ParsedValueResult | null {
    const start: number = parser.index;
    const fail = (): null => {
      parser.index = start;
      return null;
    };
    const spans: TemplateSpans | null = readTemplateSpans(src, parser.index);
    if (spans === null) return fail();
    const texts: string[] = [];
    for (const raw of spans.texts) {
      const text: string | null = unescapeTemplateText(raw);
      if (text === null) return fail();
      texts.push(text);
    }
    parser.index = spans.end;
    if (spans.exprs.length === 0) {
      const value: string = texts.join('');
      return value === '' ? fail() : { hasDynamic: false, value };
    }
    const segments: (
      | { readonly kind: 'text'; readonly text: string }
      | { readonly kind: 'expr'; readonly expr: string }
    )[] = [];
    for (let k = 0; k < spans.exprs.length; k += 1) {
      const text: string = texts[k] ?? '';
      if (text !== '') segments.push({ kind: 'text', text });
      segments.push({ kind: 'expr', expr: spans.exprs[k] as string });
    }
    const tail: string = texts[texts.length - 1] ?? '';
    if (tail !== '') segments.push({ kind: 'text', text: tail });
    compounds.push({ propPath: path, segments });
    return { hasDynamic: true, value: undefined };
  }

  function parseValue(path: string): ParsedValueResult | null {
    skipWs();
    const ch: string | undefined = src[parser.index];
    if (ch === '{') {
      const nested: ParsedObjectResult | null = parseObject(path);
      if (nested === null) return null;
      // 動的な値を含む nested object は静的 record から親 key ごと除外する。
      return nested.hasDynamic
        ? { hasDynamic: true, value: undefined }
        : { hasDynamic: false, value: nested.obj };
    }
    if (ch === '"' || ch === "'") {
      const s: string | null = parseString();
      return s === null ? null : { hasDynamic: false, value: s };
    }
    if (ch === '-' || ch === '.' || (ch !== undefined && ch >= '0' && ch <= '9')) {
      const n: number | null = parseNumber();
      return n === null ? null : { hasDynamic: false, value: n };
    }
    for (const [word, val] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (src.startsWith(word, parser.index)) {
        parser.index += word.length;
        return { hasDynamic: false, value: val };
      }
    }
    if (ch === '`') {
      // template literal 値は withDynamics 時のみ扱う (static parse は従来どおり null)。
      if (!withDynamics) return null;
      return tryParseTemplateValue(path);
    }
    if (withDynamics) {
      // 有限静的 ternary 値 (DYN-016) を parametric より先に試す。
      if (tryParseConditionalValue(path)) {
        return { hasDynamic: true, value: undefined };
      }
      const expr: string | null = parseDynamicExpr();
      if (expr !== null) {
        dynamics.push({ propPath: path, exprSource: expr });
        return { hasDynamic: true, value: undefined };
      }
    }
    return null;
  }

  function parseKey(): string | null {
    skipWs();
    const ch: string | undefined = src[parser.index];
    if (ch === '"' || ch === "'") return parseString();
    const rest: string = src.slice(parser.index);
    const m: RegExpMatchArray | null = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (m === null) return null;
    parser.index += m[0].length;
    return m[0];
  }

  function parseObject(pathPrefix: string): ParsedObjectResult | null {
    // parser.index は '{' を指す。
    parser.index += 1;
    const obj: Record<string, unknown> = {};
    let hasDynamic = false;
    skipWs();
    if (src[parser.index] === '}') {
      parser.index += 1;
      return { obj, hasDynamic };
    }
    for (;;) {
      const key: string | null = parseKey();
      if (key === null) return null;
      skipWs();
      if (src[parser.index] !== ':') return null;
      parser.index += 1;
      const childPath: string = pathPrefix.length === 0 ? key : `${pathPrefix}.${key}`;
      const value: ParsedValueResult | null = parseValue(childPath);
      if (value === null) return null;
      if (value.hasDynamic) {
        hasDynamic = true;
      } else {
        obj[key] = value.value;
      }
      skipWs();
      const sep: string | undefined = src[parser.index];
      if (sep === ',') {
        parser.index += 1;
        skipWs();
        if (src[parser.index] === '}') {
          parser.index += 1;
          return { obj, hasDynamic };
        }
        continue;
      }
      if (sep === '}') {
        parser.index += 1;
        return { obj, hasDynamic };
      }
      return null;
    }
  }

  const root: ParsedObjectResult | null = parseObject('');
  if (root === null) return null;
  skipWs();
  if (parser.index !== src.length) return null;
  return { record: root.obj, dynamics, conditionals, compounds };
}

/**
 * 静的な style object literal のみを受理するパーサ (M2)。
 * identifier 値など動的な構文は null になる。
 */
export function parseStyleObjectLiteral(src: string): Record<string, unknown> | null {
  const parsed: ParsedStyleLiteral | null = parseStyleObjectImpl(src, false);
  return parsed === null ? null : parsed.record;
}

/**
 * 静的宣言と動的な値 (identifier / member chain) を分離して抽出する (M5c)。
 * 対応不能な構文は null を返し、呼び出し側は当該出現箇所を触らない。
 */
export function parseStyleObjectLiteralWithDynamics(src: string): ParsedStyleLiteral | null {
  return parseStyleObjectImpl(src, true);
}

/**
 * StaticAtom を CSS rule へ serialize する (M2 最小版: context 対応)。
 * 決定論的であり chunk membership を含めない。
 */
export function serializeAtomCss(atom: StaticAtom, className: string): string {
  return wrapRuleContext(
    className,
    atom.context,
    `${atom.property}:${atom.value}${atom.important ? '!important' : ''}`,
  );
}

/** static atom の declaration 部分のみ (unit merge 用)。 */
function serializeStaticDecl(atom: StaticAtom): string {
  return `${atom.property}:${atom.value}${atom.important ? '!important' : ''}`;
}

/**
 * delivery unit (適用単位) の member。identity は atom id のまま、
 * CSS 出力・class は unit にマージする (plan.md §38 grouping, StyleX と同じ適用単位)。
 */
interface UnitMember {
  readonly atomId: string;
  readonly context: RuleContext;
  readonly decl: string;
}

/** unit の class id。member atom ids の sort 済み hash から決定論的に導出する。 */
function unitIdOf(memberIds: readonly string[]): string {
  return `q_${fnv1aHex(JSON.stringify([...memberIds].sort()))}`;
}

/**
 * unit を CSS へ serialize する。同一 context の declaration を 1 rule に merge し、
 * context 順・宣言順は決定論的に sort する (同一 unit set ↔ 同一 cssText)。
 * ponytail: unit をまたぐ atom の重複出力は許容 (§39 clustering で解消する)。
 */
function serializeUnitCss(className: string, members: readonly UnitMember[]): string {
  const byContext = new Map<string, { context: RuleContext; decls: Set<string> }>();
  for (const member of members) {
    const key: string = JSON.stringify(member.context);
    const entry = byContext.get(key) ?? { context: member.context, decls: new Set<string>() };
    entry.decls.add(member.decl);
    byContext.set(key, entry);
  }
  return [...byContext.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, { context, decls }]) =>
      wrapRuleContext(className, context, [...decls].sort().join(';')),
    )
    .join('');
}

/** context wrapper (base rule + pseudo/descendant/media/supports/container)。preserve block と共有する。 */
function wrapRuleContext(className: string, context: RuleContext, body: string): string {
  const pseudos: readonly string[] = context.pseudo ?? [];
  const suffix: string = context.descendant !== undefined ? ` ${context.descendant}` : '';
  let rule: string = `.${className}${pseudos.join('')}${suffix}{${body}}`;
  if (context.supports !== undefined) {
    rule = `@supports ${context.supports}{${rule}}`;
  }
  if (context.container !== undefined) {
    rule = `@container ${context.container}{${rule}}`;
  }
  if (context.media !== undefined) {
    rule = `@media ${context.media}{${rule}}`;
  }
  return rule;
}

/** preserve block を構成する 1 宣言 (static 値または var 参照)。 */
interface BlockDecl {
  readonly property: string;
  readonly valueText: string;
  readonly important: boolean;
  readonly context: RuleContext;
}

/** ParametricAtom の値部分だけを描画する (block 内宣言・slot entry 用)。 */
function parametricValueText(atom: ParametricAtom): string {
  const byIndex = new Map<number, RuntimeSlotNode>();
  atom.slots.forEach((slot, i) => byIndex.set(i, slot));
  return atom.valueTemplate
    .map((part) => {
      if (part.kind === 'text') return part.text;
      const slot = byIndex.get(part.slotIndex);
      if (slot === undefined) return '';
      return slot.fallback === undefined
        ? `var(${slot.id})`
        : `var(${slot.id}, ${slot.fallback})`;
    })
    .join('');
}

/**
 * preserve block を context ごとにグルーピングして serialize する (Level 0: atomic化なし)。
 * 宣言順を維持するため、CSS 本来の cascade がそのまま働く。
 */
function serializePreserveBlock(className: string, decls: readonly BlockDecl[]): string {
  const groups: { context: RuleContext; decls: string[] }[] = [];
  const indexByKey = new Map<string, number>();
  for (const decl of decls) {
    const key: string = JSON.stringify(decl.context);
    let idx: number | undefined = indexByKey.get(key);
    if (idx === undefined) {
      idx = groups.length;
      groups.push({ context: decl.context, decls: [] });
      indexByKey.set(key, idx);
    }
    groups[idx]?.decls.push(
      `${decl.property}:${decl.valueText}${decl.important ? '!important' : ''}`,
    );
  }
  return groups.map((group) => wrapRuleContext(className, group.context, group.decls.join(';'))).join('');
}

/** preserve block の内容アドレス名。chunk membership は含めない。 */
function preserveBlockId(decls: readonly BlockDecl[]): string {
  return `p_${fnv1aHex(
    JSON.stringify(decls.map((d) => [d.property, d.valueText, d.important, d.context])),
  )}`;
}

/**
 * `open` (=開き括弧の offset) に対応する閉じ括弧の offset を返す。
 * 文字列・escape を考慮し、backtick・comment を含むものは安全に数えられないため -1。
 */
function findMatching(code: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let i: number = open;
  let quote: string | null = null;
  while (i < code.length) {
    const ch: string = code[i] ?? '';
    if (quote !== null) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(code, i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '/' && (code[i + 1] === '/' || code[i + 1] === '*')) {
      return -1;
    }
    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function findMatchingBrace(code: string, open: number): number {
  return findMatching(code, open, '{', '}');
}

/**
 * backtick template を飛ばし、次の offset を返す。`${}` 内は通常コードとして
 * 走査する (ネスト template も再帰)。閉じなし・comment 混じりは -1。
 */
function skipTemplate(code: string, open: number): number {
  let i: number = open + 1;
  while (i < code.length) {
    const ch: string = code[i] ?? '';
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i + 1;
    if (ch === '$' && code[i + 1] === '{') {
      let depth = 0;
      let quote: string | null = null;
      let j: number = i + 1;
      while (j < code.length) {
        const c: string = code[j] ?? '';
        if (quote !== null) {
          if (c === '\\') {
            j += 2;
          } else {
            if (c === quote) quote = null;
            j += 1;
          }
          continue;
        }
        if (c === '"' || c === "'") {
          quote = c;
          j += 1;
          continue;
        }
        if (c === '`') {
          j = skipTemplate(code, j);
          if (j < 0) return -1;
          continue;
        }
        if (c === '/' && (code[j + 1] === '/' || code[j + 1] === '*')) return -1;
        if (c === '{') depth += 1;
        else if (c === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
        j += 1;
      }
      if (j >= code.length) return -1;
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

function findMatchingParen(code: string, open: number): number {
  return findMatching(code, open, '(', ')');
}

function findMatchingBracket(code: string, open: number): number {
  return findMatching(code, open, '[', ']');
}

/** transform が返す source map (sourcesContent 付き)。Vite の TransformResult と互換。 */
export interface QstyleSourceMap {
  readonly version: 3;
  readonly sources: string[];
  readonly sourcesContent: string[];
  readonly names: string[];
  readonly mappings: string;
}

/** original 座標での置換。newText の各行は srcLine (0-based) を指す。 */
export interface CodeEdit {
  readonly start: number;
  readonly end: number;
  readonly newText: string;
  readonly srcLine: number;
}

const VLQ_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** source map 用の base64 VLQ エンコーダ (依存なしの最小実装)。 */
export function encodeVlq(value: number): string {
  let v: number = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit: number = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += VLQ_BASE64[digit] ?? '';
  } while (v > 0);
  return out;
}

function lineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi: number = starts.length - 1;
  while (lo < hi) {
    const mid: number = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** original 行番号 (0-based) を返す。範囲外は clamp する。 */
export function originalLineOf(code: string, offset: number): number {
  const clamped: number = Math.max(0, Math.min(offset, code.length));
  return lineAt(lineStarts(code), clamped);
}

/**
 * edits を適用して出力 + source map を作る。edits は original 座標。
 * 重なる edits は先勝ち (file order) で後者を落とす。
 * 未編集 gap は精密 mapping、編集部の行は srcLine を指す (css prop 箇所の追跡用)。
 */
export function applyEditsWithMap(
  original: string,
  sourceId: string,
  edits: readonly CodeEdit[],
): { code: string; map: QstyleSourceMap } {
  const sorted: CodeEdit[] = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: CodeEdit[] = [];
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > original.length) continue;
    const prev: CodeEdit | undefined = kept[kept.length - 1];
    if (prev !== undefined && edit.start < prev.end) continue;
    kept.push(edit);
  }
  const origStarts: number[] = lineStarts(original);
  const origLineAt = (offset: number): number => lineAt(origStarts, offset);

  const outTexts: string[] = [''];
  const outOrigins: number[] = [0];
  const pushChunk = (
    text: string,
    originOfLine: (chunkLineIndex: number) => number,
    overwriteCurrent: boolean,
  ): void => {
    const parts: string[] = text.split('\n');
    for (let i = 0; i < parts.length; i += 1) {
      if (i === 0) {
        outTexts[outTexts.length - 1] += parts[i] ?? '';
        if (overwriteCurrent) outOrigins[outOrigins.length - 1] = originOfLine(0);
        continue;
      }
      outTexts.push(parts[i] ?? '');
      outOrigins.push(originOfLine(i));
    }
  };

  let pos = 0;
  for (const edit of kept) {
    const gap: string = original.slice(pos, edit.start);
    const gapStartLine: number = origLineAt(pos);
    pushChunk(gap, (i) => gapStartLine + i, false);
    pushChunk(edit.newText, () => edit.srcLine, true);
    pos = edit.end;
  }
  const tail: string = original.slice(pos);
  const tailStartLine: number = origLineAt(pos);
  pushChunk(tail, (i) => tailStartLine + i, false);

  const code: string = outTexts.join('\n');
  let prevSrc = 0;
  const lines: string[] = outOrigins.map((origLine) => {
    const segment: string =
      encodeVlq(0) + encodeVlq(0) + encodeVlq(origLine - prevSrc) + encodeVlq(0);
    prevSrc = origLine;
    return segment;
  });
  return {
    code,
    map: {
      version: 3,
      sources: [sourceId],
      sourcesContent: [original],
      names: [],
      mappings: lines.join(';'),
    },
  };
}

interface CssPropOccurrence {
  /** `css={` の開始 offset。 */
  readonly start: number;
  /** object literal の `{` の offset。 */
  readonly braceOpen: number;
  /** 対応する `}` の末尾 (exclusive)。 */
  readonly braceClose: number;
  /** JSX expression の閉じ `}` の末尾 (exclusive)。 */
  readonly exprClose: number;
}

/**
 * `css={{ ... }}` 出現箇所を balanced-brace scan で列挙する。
 * template literal 値も正しく数える。comment を含む箇所は除外する。
 */
function findCssPropOccurrences(code: string): CssPropOccurrence[] {
  const out: CssPropOccurrence[] = [];
  const marker = 'css={{';
  let from = 0;
  for (;;) {
    const start: number = code.indexOf(marker, from);
    if (start < 0) break;
    const braceOpen: number = start + 'css={'.length;
    const braceClose: number = findMatchingBrace(code, braceOpen);
    if (braceClose > 0 && code[braceClose + 1] === '}') {
      out.push({
        start,
        braceOpen,
        braceClose: braceClose + 1,
        exprClose: braceClose + 2,
      });
      from = braceClose + 2;
    } else {
      from = start + marker.length;
    }
  }
  return out;
}

/** module-scope handle の解決済み内容。object 形は record、template 形は atoms。 */
interface CssHandleEntry {
  readonly record?: Record<string, unknown> | undefined;
  readonly atoms?: readonly StaticAtom[] | undefined;
  /** interpolation 付き template 由来。slot id -> 式 source の対応を持つ。 */
  readonly parametric?:
    | {
        readonly atoms: readonly ParametricAtom[];
        readonly slotExprs: ReadonlyMap<string, string>;
      }
    | undefined;
}

/**
 * module-scope の `const X = css({ ... })` / `const X = css`...`` を
 * static-only handle table へ集める (M3/M4)。
 * 他 lib の `css()` を誤って拾わないよう `@qstyle/qwik` import がある module のみ対象。
 * dynamic 値・residual・error を含むものは登録しない (correctness first)。
 */
function collectCssHandles(code: string): Map<string, CssHandleEntry> {
  const table = new Map<string, CssHandleEntry>();
  if (!/from\s*['"]@qstyle\/qwik['"]/.test(code)) return table;
  collectObjectHandles(code, table);
  collectTemplateHandles(code, table);
  return table;
}

/** `const X = css({ ... })` 形を集める。 */
function collectObjectHandles(code: string, table: Map<string, CssHandleEntry>): void {
  const re = /(?:export\s+)?\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*css\s*\(/g;
  let m: RegExpExecArray | null;
  for (;;) {
    m = re.exec(code);
    if (m === null) break;
    const name: string = m[1] as string;
    if (table.has(name)) continue;
    const parenOpen: number = m.index + m[0].length - 1;
    const parenClose: number = findMatchingParen(code, parenOpen);
    if (parenClose < 0) continue;
    const afterParen: string = code.slice(parenOpen + 1, parenClose);
    const openMatch: RegExpMatchArray | null = /^\s*\{/.exec(afterParen);
    if (openMatch === null) continue;
    const braceOpen: number = parenOpen + 1 + openMatch[0].length - 1;
    const braceClose: number = findMatchingBrace(code, braceOpen);
    if (braceClose < 0) continue;
    // object literal の後に第2引数等があれば未対応。
    if (code.slice(braceClose + 1, parenClose).trim() !== '') continue;
    const literal: string = code.slice(braceOpen, braceClose + 1);
    const parsed: ParsedStyleLiteral | null = parseStyleObjectLiteralWithDynamics(literal);
    // module-scope handle は完全 static のみ (dynamic/conditional は利用側 scope がない)。
    if (
      parsed === null ||
      parsed.dynamics.length > 0 ||
      parsed.conditionals.length > 0 ||
      parsed.compounds.length > 0
    ) {
      continue;
    }
    const lowered = lowerStyleObject(parsed.record as unknown as StyleObject);
    if (lowered.residuals.length > 0) continue;
    if (lowered.diagnostics.some((d) => d.severity === 'error')) continue;
    if (lowered.atoms.length === 0) continue;
    table.set(name, { record: parsed.record });
  }
}

/** tag直下の明示 class と最後の JSX spread の offset を返す。 */
function scanTagAttributes(head: string): { classStart: number; lastSpreadEnd: number } | null {
  let classStart = -1;
  let lastSpreadEnd = -1;
  let i = 0;
  while (i < head.length) {
    const ch: string = head[i] ?? '';
    if (ch === '"' || ch === "'") {
      const quote: string = ch;
      i += 1;
      while (i < head.length && head[i] !== quote) i += head[i] === '\\' ? 2 : 1;
      if (i >= head.length) return null;
      i += 1;
      continue;
    }
    if (ch === '{') {
      const close: number = findMatchingBrace(head, i);
      if (close < 0) return null;
      if (/^\s*\.\.\./.test(head.slice(i + 1, close))) lastSpreadEnd = close + 1;
      i = close + 1;
      continue;
    }
    if (
      classStart < 0 &&
      /\s/.test(head[i - 1] ?? '') &&
      head.startsWith('class', i) &&
      /^\s*=/.test(head.slice(i + 5))
    ) {
      classStart = i;
    }
    i += 1;
  }
  return { classStart, lastSpreadEnd };
}

/** tag head 内の `class={...}` 式を抽出する。なければ null。 */
function extractClassExpr(
  head: string,
  start: number,
): { start: number; end: number; expr: string } | null {
  if (start < 0) return null;
  const m: RegExpMatchArray | null = /^class\s*=\s*\{/.exec(head.slice(start));
  if (m === null) return null;
  const open: number = start + m[0].length - 1;
  const close: number = findMatchingBrace(head, open);
  if (close < 0) return null;
  return { start, end: close + 1, expr: head.slice(open + 1, close) };
}

/** from 以降で開始タグを閉じる '>' の位置を返す。文字列と brace の内側は無視する。 */
function findOpeningTagGt(code: string, from: number): number | null {
  let depth = 0;
  let i = from;
  while (i < code.length) {
    const ch: string = code[i] ?? '';
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote: string = ch;
      i += 1;
      while (i < code.length && code[i] !== quote) i += code[i] === '\\' ? 2 : 1;
      if (i >= code.length) return null;
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth <= 0) return i;
    i += 1;
  }
  return null;
}

/**
 * `const X = css`...`` を集める (M4/M5b)。static と interpolation 付きを統一的に扱う。
 * `${...}` は全て runtime slot 化できる場合のみ登録する (plan.md §29)。
 */
function collectTemplateHandles(code: string, table: Map<string, CssHandleEntry>): void {
  const re = /(?:export\s+)?\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*css\s*`/g;
  let m: RegExpExecArray | null;
  for (;;) {
    m = re.exec(code);
    if (m === null) break;
    const name: string = m[1] as string;
    if (table.has(name)) continue;
    const open: number = m.index + m[0].length - 1;
    const spans: TemplateSpans | null = readTemplateSpans(code, open);
    if (spans === null) continue;
    const lowered = lowerTemplateSpans(spans);
    if (lowered === null) continue;
    table.set(name, {
      ...(lowered.atoms.length > 0 ? { atoms: lowered.atoms } : {}),
      ...(lowered.parametric !== undefined ? { parametric: lowered.parametric } : {}),
    });
  }
}

/**
 * template spans を Style IR へ lowering する (static + interpolation 共通)。
 * placeholder (null → runtime marker) で lowering し、slot 順に式を対応付ける。
 */
function lowerTemplateSpans(spans: TemplateSpans): {
  readonly atoms: readonly StaticAtom[];
  readonly parametric?:
    | {
        readonly atoms: readonly ParametricAtom[];
        readonly slotExprs: ReadonlyMap<string, string>;
      }
    | undefined;
} | null {
  if (spans.texts.length !== spans.exprs.length + 1) return null;
  const lowered = lowerTaggedTemplate(
    spans.texts as unknown as TemplateStringsArray,
    spans.exprs.map(() => null),
  );
  if (lowered.residuals.length > 0) return null;
  if (lowered.diagnostics.some((d) => d.severity === 'error')) return null;
  if (lowered.atoms.length === 0 && lowered.parametrics.length === 0) return null;
  let parametric:
    | {
        readonly atoms: readonly ParametricAtom[];
        readonly slotExprs: ReadonlyMap<string, string>;
      }
    | undefined;
  if (lowered.parametrics.length > 0) {
    const slotExprs = new Map<string, string>();
    let cursor = 0;
    for (const atom of lowered.parametrics) {
      for (const slot of atom.slots) {
        const expr: string | undefined = spans.exprs[cursor];
        if (expr === undefined) return null;
        slotExprs.set(slot.id, expr);
        cursor += 1;
      }
    }
    if (cursor !== spans.exprs.length) return null;
    parametric = { atoms: lowered.parametrics, slotExprs };
  }
  return { atoms: lowered.atoms, ...(parametric !== undefined ? { parametric } : {}) };
}

/** interpolation 1 個分の式として受理する grammar (identifier / member chain 全体一致)。 */
const DYNAMIC_EXPR_FULL_RE = /^[A-Za-z_$][\w$]*(?:(?:\.|\?\.)[A-Za-z_$][\w$]*|\[\d+\])*$/;

interface TemplateSpans {
  /** `${...}` を除いた静的部分。補間数 + 1 個。 */
  readonly texts: readonly string[];
  /** 補間式 (trim 済み)。 */
  readonly exprs: readonly string[];
  /** 閉じ backtick の末尾 (exclusive)。 */
  readonly end: number;
}

/**
 * backtick literal を静的部分と `${expr}` 列に分割する。
 * ネスト backtick・comment・閉じなし・空式があれば null。
 */
function readTemplateSpans(code: string, open: number): TemplateSpans | null {
  const texts: string[] = [];
  const exprs: string[] = [];
  let text = '';
  let i: number = open + 1;
  while (i < code.length) {
    const ch: string = code[i] ?? '';
    if (ch === '\\') {
      const next: string = code[i + 1] ?? '';
      if (next === '') return null;
      text += ch + next;
      i += 2;
      continue;
    }
    if (ch === '`') {
      texts.push(text);
      return { texts, exprs, end: i + 1 };
    }
    if (ch === '$' && code[i + 1] === '{') {
      // 補間式を balanced-brace で切り出す。
      let depth = 0;
      let quote: string | null = null;
      let j: number = i + 1;
      let closed = -1;
      while (j < code.length) {
        const c: string = code[j] ?? '';
        if (quote !== null) {
          if (c === '\\') j += 1;
          else if (c === quote) quote = null;
          j += 1;
          continue;
        }
        if (c === '"' || c === "'") {
          quote = c;
          j += 1;
          continue;
        }
        if (c === '`' || (c === '/' && (code[j + 1] === '/' || code[j + 1] === '*'))) break;
        if (c === '{') depth += 1;
        else if (c === '}') {
          depth -= 1;
          if (depth === 0) {
            closed = j;
            break;
          }
        }
        j += 1;
      }
      if (closed < 0) return null;
      const expr: string = code.slice(i + 2, closed).trim();
      if (expr === '' || !DYNAMIC_EXPR_FULL_RE.test(expr) || /\/\/|\/\*/.test(expr)) {
        return null;
      }
      exprs.push(expr);
      texts.push(text);
      text = '';
      i = closed + 1;
      continue;
    }
    text += ch;
    i += 1;
  }
  return null;
}

interface CssExprOccurrence {
  /** `css={` の開始 offset。 */
  readonly start: number;
  /** JSX expression の `{` の offset。 */
  readonly exprOpen: number;
  /** JSX expression の閉じ `}` の末尾 (exclusive)。 */
  readonly exprClose: number;
}

/**
 * `css={...}` (単一 brace) 出現箇所を列挙する。`css={{...}}` は既存パス担当のため除外。
 * backtick・comment を含む箇所は安全に数えられないため除外する。
 */
function findCssExprOccurrences(code: string): CssExprOccurrence[] {
  const out: CssExprOccurrence[] = [];
  const marker = 'css={';
  let from = 0;
  for (;;) {
    const start: number = code.indexOf(marker, from);
    if (start < 0) break;
    const exprOpen: number = start + 'css='.length;
    if (code[exprOpen + 1] === '{') {
      from = start + marker.length;
      continue;
    }
    const close: number = findMatchingBrace(code, exprOpen);
    if (close < 0) {
      from = start + marker.length;
      continue;
    }
    out.push({ start, exprOpen, exprClose: close + 1 });
    from = close + 1;
  }
  return out;
}

/** 2 文字演算子 (例: `&&`) で top-level 分割する。文字列・括弧対応、危険な字句では null。 */
function splitTopLevelOp(text: string, op: string): string[] | null {
  const parts: string[] = [];
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
    if (ch === '`') {
      const next: number = skipTemplate(text, i);
      if (next < 0) return null;
      i = next - 1;
      continue;
    }
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) return null;
    if (ch === '[' || ch === '{' || ch === '(') depth += 1;
    else if (ch === ']' || ch === '}' || ch === ')') {
      depth -= 1;
      if (depth < 0) return null;
    } else if (depth === 0 && ch === op[0] && text.startsWith(op, i)) {
      // `&&=` 等の複合代入は条件式ではない。
      if (text[i + op.length] === '=') return null;
      parts.push(text.slice(start, i));
      start = i + op.length;
      i += op.length - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** ternary としての top-level `?` を探す (`?.` / `??` を除く)。なければ -1。 */
function findTernaryQuestion(text: string): number {
  let depth = 0;
  let quote: string | null = null;
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
    if (ch === '`') return -1;
    if (ch === '[' || ch === '{' || ch === '(') depth += 1;
    else if (ch === ']' || ch === '}' || ch === ')') depth -= 1;
    else if (depth === 0 && ch === '?') {
      const next: string = text[i + 1] ?? '';
      if (next === '.' || next === '?') continue;
      return i;
    }
  }
  return -1;
}

/**
 * top-level ternary `cond ? a : b` を分割する。ネスト ternary・`?.` 混在は null。
 * `:` 探索中に ternary 型 `?` が現れたら null (曖昧な結合を実装しない)。
 */
function splitTopLevelTernary(text: string): { cond: string; whenTrue: string; whenFalse: string } | null {
  const q: number = findTernaryQuestion(text);
  if (q < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = q + 1; i < text.length; i += 1) {
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
    if (ch === '`') return null;
    if (ch === '[' || ch === '{' || ch === '(') depth += 1;
    else if (ch === ']' || ch === '}' || ch === ')') depth -= 1;
    else if (depth === 0 && ch === '?') {
      const next: string = text[i + 1] ?? '';
      if (next !== '.' && next !== '?') return null;
    } else if (depth === 0 && ch === ':') {
      const cond: string = text.slice(0, q).trim();
      const whenTrue: string = text.slice(q + 1, i).trim();
      const whenFalse: string = text.slice(i + 1).trim();
      if (cond === '' || whenTrue === '' || whenFalse === '') return null;
      return { cond, whenTrue, whenFalse };
    }
  }
  return null;
}
/** カンマ区切りを top-level でのみ分割する。template・文字列・括弧を考慮し、危険な字句では null。 */
function splitTopLevel(text: string): string[] | null {
  const parts: string[] = [];
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
    if (ch === '`') {
      const next: number = skipTemplate(text, i);
      if (next < 0) return null;
      i = next - 1;
      continue;
    }
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) return null;
    if (ch === '[' || ch === '{' || ch === '(') depth += 1;
    else if (ch === ']' || ch === '}' || ch === ')') {
      depth -= 1;
      if (depth < 0) return null;
    } else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

interface ResolvedPart {
  readonly record?: Record<string, unknown> | undefined;
  /** template literal handle 由来の解決済み atoms (record の代わりに持つ)。 */
  readonly handleAtoms?: readonly StaticAtom[] | undefined;
  /** interpolation 付き template handle 由来 (無条件合成のみ、条件付き不可)。 */
  readonly handleParametrics?:
    | {
        readonly atoms: readonly ParametricAtom[];
        readonly slotExprs: ReadonlyMap<string, string>;
      }
    | undefined;
  readonly dynamics: readonly DynamicStyleValue[];
  /** 有限静的 ternary 値 (DYN-016)。条件付き handle とは別に static 展開する。 */
  readonly conditionals: readonly ConditionalStyleValue[];
  /** object 構文内 template literal 値 (複合 slot 展開する)。 */
  readonly compounds: readonly CompoundStyleValue[];
  /** 条件付き適用 (`cond && X` / `cond ? A : B` 由来)。ある場合は無条件 style と分離する。 */
  readonly cond?: string | undefined;
}

/** 単一 contribution (bare handle / inline object) を解決する。dynamic 同伴可、条件は呼び出し側で付与する。 */
function resolveSingleStatic(
  expr: string,
  handles: ReadonlyMap<string, CssHandleEntry>,
): ResolvedPart | null {
  const text: string = expr.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    const entry: CssHandleEntry | undefined = handles.get(text);
    if (entry === undefined) return null;
    // parametric を含む handle の条件付き適用は style var の条件分岐が必要なため未対応。
    if (entry.parametric !== undefined) return null;
    if (entry.record !== undefined) {
      // 空 object は寄与なし (条件式の評価だけ残すため全体を untouched にする)。
      return Object.keys(entry.record).length === 0 ? null : { record: entry.record, dynamics: [], conditionals: [], compounds: [] };
    }
    if (entry.atoms !== undefined) return { handleAtoms: entry.atoms, dynamics: [], conditionals: [], compounds: [] };
    return null;
  }
  if (text.startsWith('{')) {
    if (findMatchingBrace(text, 0) !== text.length - 1) return null;
    const parsed: ParsedStyleLiteral | null = parseStyleObjectLiteralWithDynamics(text);
    // nested conditional は外側条件との組合せが複雑なため未対応。
    if (parsed === null || parsed.conditionals.length > 0) return null;
    if (Object.keys(parsed.record).length === 0 && parsed.dynamics.length === 0 && parsed.compounds.length === 0) return null;
    return { record: parsed.record, dynamics: parsed.dynamics, conditionals: [], compounds: parsed.compounds };
  }
  return null;
}

/** 条件式テキストの検証。コメント混じりは出力式を壊すため拒否する。 */
function isSafeCondition(cond: string): boolean {
  if (cond === '') return false;
  return !/\/\/|\/\*/.test(cond);
}

/** `cond && X` を解決する。X は単一 static のみ。条件付きでない場合は null (fallthrough 用)。 */
function tryResolveConditionalAnd(
  text: string,
  handles: ReadonlyMap<string, CssHandleEntry>,
): ResolvedPart[] | null {
  const segments: string[] | null = splitTopLevelOp(text, '&&');
  if (segments === null || segments.length < 2) return null;
  const last: string = (segments[segments.length - 1] ?? '').trim();
  const cond: string = segments.slice(0, -1).join('&&').trim();
  if (!isSafeCondition(cond) || last === '') return null;
  if (findTernaryQuestion(cond) >= 0) return null;
  const target: ResolvedPart | null = resolveSingleStatic(last, handles);
  if (target === null) return null;
  return [{ ...target, cond }];
}

/** 枝テキストを static/dynamic parts へ解決する (条件・conditional・parametric 混じりは拒否)。 */
function resolveBranchStatic(
  branch: string,
  handles: ReadonlyMap<string, CssHandleEntry>,
): ResolvedPart[] | null {
  if (/^(?:false|null|undefined)$/.test(branch.trim())) return [];
  const single: ResolvedPart | null = resolveSingleStatic(branch, handles);
  if (single !== null) return [single];
  const parts: ResolvedPart[] | null = resolveCssExprParts(branch, handles);
  if (parts === null) return null;
  if (
    parts.some(
      (p) =>
        p.cond !== undefined ||
        p.conditionals.length > 0 ||
        p.handleParametrics !== undefined,
    )
  ) {
    return null;
  }
  return parts;
}

/** `cond ? A : B` を 2 つの条件付き contribution へ解決する。条件付きでない場合は null。 */
function tryResolveConditionalTernary(
  text: string,
  handles: ReadonlyMap<string, CssHandleEntry>,
): ResolvedPart[] | null {
  const split = splitTopLevelTernary(text);
  if (split === null) return null;
  if (!isSafeCondition(split.cond)) return null;
  // 両枝が同一テキストなら条件は意味を持たないため無条件として解決する。
  if (split.whenTrue === split.whenFalse) return resolveBranchStatic(split.whenTrue, handles);
  const whenTrue: ResolvedPart[] | null = resolveBranchStatic(split.whenTrue, handles);
  const whenFalse: ResolvedPart[] | null = resolveBranchStatic(split.whenFalse, handles);
  if (whenTrue === null || whenFalse === null) return null;
  // 両枝とも空なら条件評価だけが残るため untouched (評価を落とさない)。
  if (whenTrue.length === 0 && whenFalse.length === 0) return null;
  return [
    ...whenTrue.map((p) => ({ ...p, cond: split.cond })),
    ...whenFalse.map((p) => ({ ...p, cond: `!(${split.cond})` })),
  ];
}

/** identifier が相対 module から import されている場合、その source を返す。 */
function findRelativeImportSource(code: string, localName: string): string | null {
  const re =
    /import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,\s*)?(?:\{([^}]*)\}|\*\s*as\s+([A-Za-z_$][\w$]*))\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  for (;;) {
    m = re.exec(code);
    if (m === null) return null;
    const source: string = m[4] ?? '';
    if (!source.startsWith('.')) continue;
    if ((m[3] ?? '') === localName) return source;
    for (const entry of (m[2] ?? '').split(',')) {
      const parts: string[] = entry.trim().split(/\s+as\s+/);
      const orig: string = (parts[0] ?? '').trim();
      const local: string = (parts[1] ?? orig).trim();
      if (local === localName && orig !== '') return source;
    }
  }
}

/**
 * 未解決 css 参照が cross-module handle の場合、actionable な理由を返す。
 * 解決自体は行わない (module 間解決は async transform が必要で、同期 transform の範囲外)。
 */
function crossModuleHint(code: string, inner: string): string | null {
  const text: string = inner.trim();
  const single: RegExpMatchArray | null =
    /^([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?$/.exec(text);
  if (single === null) return null;
  const base: string = single[1] ?? '';
  const source: string | null = findRelativeImportSource(code, base);
  if (source === null) return null;
  return `css handle '${text}' imported from '${source}' is not resolved across modules yet; left untouched`;
}

/**
 * `css={...}` の内側式を順序付き contribution へ解決する (M3/M4 composition)。
 * 解決できるのは handle 参照・static inline object・inline css タグ・falsy・nested array のみ。
 * `&&` / `?:` / call / spread 等は null (untouched を維持し、誤って無条件適用しない)。
 */
function resolveCssExprParts(
  inner: string,
  handles: ReadonlyMap<string, CssHandleEntry>,
): ResolvedPart[] | null {
  const text: string = inner.trim();
  if (text === '') return null;
  if (/^(?:false|null|undefined)$/.test(text)) return [];
  // インライン css タグ (`css={css`...`}`)。template 全体を消費する場合のみ受理する。
  const tagOpen: RegExpMatchArray | null = /^css\s*`/.exec(text);
  if (tagOpen !== null) {
    const spans: TemplateSpans | null = readTemplateSpans(text, tagOpen[0].length - 1);
    if (spans === null || spans.end !== text.length) return null;
    const lowered = lowerTemplateSpans(spans);
    if (lowered === null) return null;
    const part: ResolvedPart = { dynamics: [], conditionals: [], compounds: [] };
    if (lowered.parametric !== undefined) {
      return [
        {
          ...(lowered.atoms.length > 0 ? { handleAtoms: lowered.atoms } : {}),
          handleParametrics: lowered.parametric,
          ...part,
        },
      ];
    }
    return [{ handleAtoms: lowered.atoms, ...part }];
  }
  // 条件付き (CMP-007): `cond && X` / `cond ? A : B`。解決できなければ
  // fallthrough し、通常の単一・配列・inline 解決を試みる (文字列内の && 等)。
  if (text.includes('&&')) {
    const cond: ResolvedPart[] | null = tryResolveConditionalAnd(text, handles);
    if (cond !== null) return cond;
  }
  if (findTernaryQuestion(text) >= 0) {
    const cond: ResolvedPart[] | null = tryResolveConditionalTernary(text, handles);
    if (cond !== null) return cond;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    const entry: CssHandleEntry | undefined = handles.get(text);
    if (entry === undefined) return null;
    if (entry.record !== undefined) {
      return [{ record: entry.record, dynamics: [], conditionals: [], compounds: [] }];
    }
    if (entry.atoms !== undefined && entry.parametric !== undefined) {
      return [
        {
          handleAtoms: entry.atoms,
          handleParametrics: entry.parametric,
          dynamics: [],
          conditionals: [],
          compounds: [],
        },
      ];
    }
    if (entry.atoms !== undefined) return [{ handleAtoms: entry.atoms, dynamics: [], conditionals: [], compounds: [] }];
    if (entry.parametric !== undefined) {
      return [{ handleParametrics: entry.parametric, dynamics: [], conditionals: [], compounds: [] }];
    }
    return null;
  }
  if (text.startsWith('[')) {
    if (findMatchingBracket(text, 0) !== text.length - 1) return null;
    const elements: string[] | null = splitTopLevel(text.slice(1, -1));
    if (elements === null) return null;
    const out: ResolvedPart[] = [];
    for (const element of elements) {
      // trailing comma 由来の空要素は無視する。
      if (element.trim() === '') continue;
      const part: ResolvedPart[] | null = resolveCssExprParts(element, handles);
      if (part === null) return null;
      out.push(...part);
    }
    return out;
  }
  if (text.startsWith('{')) {
    if (findMatchingBrace(text, 0) !== text.length - 1) return null;
    const parsed: ParsedStyleLiteral | null = parseStyleObjectLiteralWithDynamics(text);
    if (parsed === null) return null;
    if (parsed.dynamics.some((d) => d.propPath.includes('.'))) return null;
    if (parsed.dynamics.some((d) => !CSS_PROPERTY_RE.test(d.propPath))) return null;
    return [{ record: parsed.record, dynamics: parsed.dynamics, conditionals: parsed.conditionals, compounds: parsed.compounds }];
  }
  return null;
}

/** 解決済み parts を composeCssProp の入力形へ変換する (template handle は合成 handle 化)。 */
function toCssPropParts(parts: readonly ResolvedPart[]): Array<StyleObject | StyleHandle> {
  return parts.map((p) => {
    if (p.handleAtoms !== undefined) {
      const handle: StyleHandle = {
        __qstyleBrand: 'StyleHandle',
        atoms: p.handleAtoms,
        parametrics: [],
        residuals: [],
      };
      return handle;
    }
    return p.record as unknown as StyleObject;
  });
}

/** context (pseudo/media/...) を持つ atom は inline style にできない。 */
function atomHasContext(atom: ParametricAtom): boolean {
  const context = atom.context;
  return (
    (context.pseudo?.length ?? 0) > 0 ||
    context.media !== undefined ||
    context.supports !== undefined ||
    context.container !== undefined ||
    context.layer !== undefined
  );
}

/** promotion 判定用の構造キー。値は含めない (§29)。 */
function inlineStructKey(propPath: string, skeleton: string | null): string {
  const prop: string = canonicalProperty(propPath);
  return skeleton === null ? `s:${prop}` : `c:${prop}:${skeleton}`;
}

function compoundSkeleton(
  segments: readonly (
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'expr'; readonly expr: string }
  )[],
): string {
  return segments.map((s) => (s.kind === 'text' ? `t${s.text}` : 's')).join('|');
}

/**
 * module 内の inline dynamic/compound 構造の出現回数を数える (cost-based 用)。
 * 失敗箇所は数えない (多い方向=promote 方向への誤差は安全側)。
 */
function countModuleStructures(
  code: string,
  handles: ReadonlyMap<string, CssHandleEntry>,
): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const occ of findCssPropOccurrences(code)) {
    const parsed = parseStyleObjectLiteralWithDynamics(code.slice(occ.braceOpen, occ.braceClose));
    if (parsed === null) continue;
    for (const d of parsed.dynamics) {
      if (d.propPath.includes('.') || !CSS_PROPERTY_RE.test(d.propPath)) continue;
      bump(inlineStructKey(d.propPath, null));
    }
    for (const c of parsed.compounds) {
      if (c.propPath.includes('.') || !CSS_PROPERTY_RE.test(c.propPath)) continue;
      bump(inlineStructKey(c.propPath, compoundSkeleton(c.segments)));
    }
  }
  for (const occ of findCssExprOccurrences(code)) {
    const parts = resolveCssExprParts(code.slice(occ.exprOpen + 1, occ.exprClose - 1), handles);
    if (parts === null) continue;
    for (const part of parts) {
      if (part.cond !== undefined || part.handleParametrics !== undefined) continue;
      for (const d of part.dynamics) {
        if (d.propPath.includes('.') || !CSS_PROPERTY_RE.test(d.propPath)) continue;
        bump(inlineStructKey(d.propPath, null));
      }
      for (const c of part.compounds) {
        if (c.propPath.includes('.') || !CSS_PROPERTY_RE.test(c.propPath)) continue;
        bump(inlineStructKey(c.propPath, compoundSkeleton(c.segments)));
      }
    }
  }
  return counts;
}

/** static text を template literal 値として再埋め込みできる形に escape する。 */
function escapeTemplateText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/** compound segments を inline style 用の template literal へ再構成する。 */
function inlineCompoundValue(
  segments: readonly (
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'expr'; readonly expr: string }
  )[],
): string {
  const body: string = segments
    .map((s) => (s.kind === 'text' ? escapeTemplateText(s.text) : `\${${s.expr}}`))
    .join('');
  return `\`${body}\``;
}

/**
 * template-handle atom を slot 式で埋めた inline 値にする。
 * 単一 slot は生の式、複合は template literal。欠落があれば null。
 */
function inlineParametricValue(
  atom: ParametricAtom,
  slotExprs: ReadonlyMap<string, string>,
): string | null {
  const first = atom.valueTemplate[0];
  if (atom.valueTemplate.length === 1 && first?.kind === 'slot') {
    const slot = atom.slots[first.slotIndex];
    const expr: string | undefined = slot === undefined ? undefined : slotExprs.get(slot.id);
    return expr ?? null;
  }
  let body = '';
  for (const part of atom.valueTemplate) {
    if (part.kind === 'text') {
      body += escapeTemplateText(part.text);
      continue;
    }
    const slot = atom.slots[part.slotIndex];
    const expr: string | undefined = slot === undefined ? undefined : slotExprs.get(slot.id);
    if (expr === undefined) return null;
    body += `\${${expr}}`;
  }
  return `\`${body}\``;
}

/**
 * option の fail-fast 検証 (FLB-006: actionable message で build 失敗させる)。
 */
function validateQstyleOptions(options: QstyleOptions): void {
  const optimization: string = options.optimization ?? 'safe';
  if (optimization !== 'preserve' && optimization !== 'safe' && optimization !== 'strict') {
    throw new Error(
      `[qstyle] unknown optimization ${JSON.stringify(optimization)}; expected 'preserve', 'safe' or 'strict'.`,
    );
  }
  const backend: string = options.backend ?? 'qwik-native';
  if (backend !== 'qwik-native' && backend !== 'css-asset') {
    throw new Error(
      `[qstyle] unknown backend ${JSON.stringify(backend)}; expected 'qwik-native' or 'css-asset'.`,
    );
  }
  const diagnostics: string = options.diagnostics ?? 'warning';
  if (diagnostics !== 'silent' && diagnostics !== 'warning' && diagnostics !== 'error') {
    throw new Error(
      `[qstyle] unknown diagnostics ${JSON.stringify(diagnostics)}; expected 'silent', 'warning' or 'error'.`,
    );
  }
  const strategy: string = options.runtimeStyles?.strategy ?? 'custom-property';
  if (strategy !== 'custom-property') {
    throw new Error(
      `[qstyle] unknown runtimeStyles.strategy ${JSON.stringify(strategy)}; expected 'custom-property'.`,
    );
  }
  const fallback: string = options.runtimeStyles?.fallback ?? 'inline';
  if (fallback !== 'inline') {
    throw new Error(
      `[qstyle] unknown runtimeStyles.fallback ${JSON.stringify(fallback)}; expected 'inline'.`,
    );
  }
  const promotion: string = options.runtimeStyles?.promotion ?? 'cost-based';
  if (promotion !== 'never' && promotion !== 'cost-based' && promotion !== 'always') {
    throw new Error(
      `[qstyle] unknown runtimeStyles.promotion ${JSON.stringify(promotion)}; expected 'never', 'cost-based' or 'always'.`,
    );
  }
  const falsy: string = options.composition?.falsy ?? 'ignore';
  if (falsy !== 'ignore') {
    throw new Error(
      `[qstyle] unknown composition.falsy ${JSON.stringify(falsy)}; expected 'ignore'.`,
    );
  }
  const chunkStrategy: string = options.chunking?.strategy ?? 'usage-cluster';
  if (chunkStrategy !== 'usage-cluster') {
    throw new Error(
      `[qstyle] unknown chunking.strategy ${JSON.stringify(chunkStrategy)}; expected 'usage-cluster'.`,
    );
  }
}

/**
 * qstyle Vite plugin — Milestone 2 object-syntax lowering (plan.md §89)
 * + Milestone 3 css() handle / composition lowering (plan.md §90)。
 * - virtual modules: registry / pack/<id> / manifest / residuals / route-loader,
 *   dev/<hash>.css (serve 時のみ)
 * - serve (dev): 同一 lowering を per-module CSS としてそのまま適用する
 *   (global dedup・chunking・manifest なし)。virtual css 経由で Vite の CSS HMR が効く。
 *   ファイル変更時は handleHotUpdate で該当 virtual css を無効化する。
 * - transform: .tsx/.jsx 内の css={{ ... }} を balanced-brace scan で抽出し、
 *   安全に parse できる object literal のみ @qstyle/qwik の lowerStyleObject
 *   で atom 化→hash→ class へ rewrite し、モジュール先頭へ side-effect
 *   import "virtual:qstyle/pack/HASH" を注入する (backend 'qwik-native' の場合)。
 *   backend 'css-asset' の場合は pack import の代わりに client helper
 *   `ensureModuleStyles([...unitIds])` を注入する (§3.4 R1.6 案 B)。
 *   既存 class 属性があれば追記する。
 *   M5c: identifier / member chain の値は ParametricAtom (slot var) 化し、
 *   class へ追記した上で既存/新規 style prop へ代入を merge する。
 *   module-scope の static `css({...})` handle と `css={...}` composition
 *   (handle 参照・static inline・falsy・nested array) も解決する (M3)。
 *   条件付き・未知参照・衝突 dynamic は untouched にする。
 *   residual が残るもの・parse 不能なものは触らない (correctness first)。
 *   strict mode では untouched 箇所を compile error にする (plan.md §61)。
 * - generateBundle: Route Style Manifest の雛形を emit。
 *   backend 'css-asset' では asset 名解決済み manifest に切り替え (§3.4 R1.3)。
 */
export function qstyle(
  options: QstyleOptions = {},
): [
  Plugin & {
    readonly __usageGraph: UsageGraph;
    readonly __residuals: readonly ResidualRuleNode[];
    readonly __legacyStyles: readonly LegacyStyleUsage[];
  },
  Plugin,
  Plugin & {
    /** css-asset backend の chunk plan (id/members/bytes/fileName)。inspector 用。 */
    readonly __chunkPlans: readonly CssAssetChunk[];
  },
] {
  validateQstyleOptions(options);
  const optimization: OptimizationLevel = options.optimization ?? 'safe';
  const backend: BackendKind = options.backend ?? 'qwik-native';
  const diagnosticsMode: 'silent' | 'warning' | 'error' = options.diagnostics ?? 'warning';
  const strict: boolean = optimization === 'strict';
  // Level 0: parse・minify・exact rule dedup のみで atomic 化しない (§16)。
  const preserve: boolean = optimization === 'preserve';
  // §32 promotion: never=常に inline、always=常に class 化、
  // cost-based=module 内共有構造のみ class 化し単発は inline のままにする。
  const promotion: 'never' | 'cost-based' | 'always' =
    options.runtimeStyles?.promotion ?? 'cost-based';
  const debug = options.debug ?? false;

  const collected = new Map<string, CollectedStyle>();
  const moduleToAtoms = new Map<string, string[]>();
  /** prod: module id -> pack id (pack css は unit set の hash で決定論的に同一視)。 */
  const modulePacks = new Map<string, string>();
  /** prod: pack id -> css text。load(`virtual:qstyle/pack/<id>.css`) が返す。 */
  const packCss = new Map<string, string>();
  /** legacy Qwik style hook の利用記録 (§24)。rewrite せず provenance のみ追跡する。 */
  let legacyStyles: LegacyStyleUsage[] = [];
  /** untouched 箇所の residual nodes (DIA-003: inspector で理由を表示する)。 */
  let residualLog: ResidualRuleNode[] = [];
  /** dev mode の per-module CSS (再評価・再配列なし。serve 時のみ利用)。 */
  const devCss = new Map<string, string>();
  /** dev virtual css の key -> module id。 */
  const devKeys = new Map<string, string>();
  /** dev で transform した module (HMR 無効化の対象判定用)。 */
  const devTransformed = new Set<string>();
  /** serve mode では dev パイプライン (per-module CSS + HMR) を使う。 */
  let isDev = false;
  // plan.md §51: buildStart で 1 instance に reset する。plugin 生成直後の
  // instance は単体テスト (buildStart を呼ばない) 用。
  let graph: UsageGraph = createUsageGraph();
  const chunkOptions: ChunkOptions = {
    minChunkBytes: options.chunking?.minChunkBytes ?? DEFAULT_CHUNK_OPTIONS.minChunkBytes,
    maxChunkBytes: options.chunking?.maxChunkBytes ?? DEFAULT_CHUNK_OPTIONS.maxChunkBytes,
  };

  /** module id / route option の path を usage graph の component id (basename) へ正規化する。 */
  function moduleKey(id: string): string {
    const slash: number = id.lastIndexOf('/');
    return slash < 0 ? id : id.slice(slash + 1);
  }

  /**
   * css-asset backend の chunk plan を asset 化する (§3.4 R1.2)。
   * join → chunk 内 §39 v1 dedup → chunkHash(最終 bytes) → assetFileName。
   * 純関数 (collected/graph の snapshot から決定論的に導出) で、同一 build pass 内の
   * 呼び出し間で cache する (main の manifest 生成と css-asset plugin の emit が同一結果を
   * 参照する。buildStart で reset)。
   */
  let cssAssetPlanCache: CssAssetPlan | null = null;
  const buildCssAssetPlan = (): CssAssetPlan => {
    if (cssAssetPlanCache !== null) return cssAssetPlanCache;
    const styles: ChunkInput[] = [...collected.values()].map((s) => ({
      id: s.id,
      bytes: s.cssText.length,
    }));
    const plans: ChunkPlan[] = planChunks(graph, styles, chunkOptions);
    const meta = {
      unitTags: unitTagNames as ReadonlyMap<string, ReadonlySet<string>>,
      condUnitIds: condUnitIds as ReadonlySet<string>,
    };
    const chunks: CssAssetChunk[] = [];
    const unitToFile = new Map<string, string>();
    for (const plan of plans) {
      const joined: string = plan.members
        .map((unitId) => collected.get(unitId)?.cssText ?? '')
        .join('');
      // §39 v1 を chunk 内 (hash 計算前) に適用する — 出力 bytes と hash を一致させる。
      const finalText: string = groupDuplicateCss(joined, meta);
      const fileName: string = `assets/${assetFileName('qstyle', chunkHash(finalText))}`;
      chunks.push({
        id: plan.id,
        members: plan.members,
        bytes: plan.bytes,
        fileName,
        cssText: finalText,
      });
      for (const unitId of plan.members) unitToFile.set(unitId, fileName);
    }
    cssAssetPlanCache = { chunks, unitToFile };
    return cssAssetPlanCache;
  };

  /** options.routes (route -> module paths) を component -> route の逆引きへ張る (冪等)。 */
  function wireRoutes(target: UsageGraph): void {
    for (const route of Object.keys(options.routes ?? {})) {
      const modules: readonly string[] = options.routes?.[route] ?? [];
      for (const modulePath of modules) {
        recordComponentRoute(target, moduleKey(modulePath), route);
      }
    }
  }

  const log = (...args: readonly unknown[]): void => {
    if (debug) {
      console.log('[qstyle]', ...args);
    }
  };

  // §39 dedup 用の記録。unit class -> 適用タグ、条件付き (同時適用が自明でない) unit。
  const unitTagNames = new Map<string, Set<string>>();
  const condUnitIds = new Set<string>();

  /** 開始タグの tag 名を unit class に記録する (dedup の共存証明に使う)。 */
  const recordUnitTags = (head: string, ids: readonly string[]): void => {
    const m: RegExpExecArray | null = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(head);
    if (m === null) return;
    const tag = m[1] as string;
    for (const id of ids) {
      if (!id.startsWith('q_')) continue;
      const set = unitTagNames.get(id) ?? new Set<string>();
      set.add(tag);
      unitTagNames.set(id, set);
    }
  };

  const mainPlugin: Plugin & {
    readonly __usageGraph: UsageGraph;
    readonly __residuals: readonly ResidualRuleNode[];
    readonly __legacyStyles: readonly LegacyStyleUsage[];
  } = {
    name: 'qstyle',
    enforce: 'pre',
    // ponytail: diagnostics/inspector 用の live graph 参照。buildStart で差し替わる。
    get __usageGraph(): UsageGraph {
      return graph;
    },
    /** 収集済み residual nodes (inspector 表示用)。buildStart で reset される。 */
    get __residuals(): readonly ResidualRuleNode[] {
      return residualLog;
    },
    /** legacy hook 利用記録 (§24)。buildStart で reset される。 */
    get __legacyStyles(): readonly LegacyStyleUsage[] {
      return legacyStyles;
    },

    configResolved(config: ResolvedConfig): void {
      // serve mode では dev パイプラインを使う (per-module CSS + CSS HMR)。
      isDev = config.command === 'serve';
      // §45: route -> module の逆引きを usage graph へ張る (routes option がなければ何もしない)。
      wireRoutes(graph);
      log(`optimization=${optimization} backend=${backend} mode=${config.mode} dev=${isDev}`);
    },

    configureServer(server: ViteDevServer): void {
      // <link rel="stylesheet"> からの直接リクエスト (`/virtual:qstyle/*.css`) は
      // vite の raw css 経路に乗らない (virtual module は fs 解決できず 404 になる)。
      // middleware で plugin の load と同じ内容を text/css として返す。
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url: string = (req.url ?? '').split('?')[0] ?? '';
        if (!url.startsWith('/virtual:qstyle/') || !url.endsWith('.css')) {
          next();
          return;
        }
        const resolved = resolveQstyleId(url);
        if (resolved === null) {
          next();
          return;
        }
        void server.pluginContainer
          .load(resolved)
          .then((css: unknown) => {
            if (typeof css !== 'string') {
              res.statusCode = 404;
              res.end();
              return;
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            res.end(css);
          })
          .catch(() => {
            res.statusCode = 500;
            res.end();
          });
      });
    },

    buildStart(): void {
      collected.clear();
      moduleToAtoms.clear();
      modulePacks.clear();
      packCss.clear();
      residualLog = [];
      legacyStyles = [];
      devCss.clear();
      devKeys.clear();
      devTransformed.clear();
      unitTagNames.clear();
      condUnitIds.clear();
      cssAssetPlanCache = null;
      graph = createUsageGraph();
      wireRoutes(graph);
    },

    handleHotUpdate({ file, server }: HmrContext): void {
      // dev で transform した module の変更だけ virtual CSS を無効化する。
      // 無関係ファイルには干渉しない (HMR-008)。tsx 側の通常 HMR は継続させる。
      if (!devTransformed.has(file)) return;
      const mod = server.moduleGraph.getModuleById(devModuleId(file));
      if (mod !== undefined) {
        void server.moduleGraph.invalidateModule(mod);
      }
    },

    resolveId(id: string): string | null {
      return resolveQstyleId(id);
    },

    load(id: string): string | null {
      const resolved = resolveQstyleId(id);
      if (resolved === null) return null;
      const path = resolved.slice(RESOLVED_PREFIX.length);
      if (path === 'registry') {
        const entries = [...collected.values()]
          .map((s) => `  ${JSON.stringify(s.id)}: ${JSON.stringify(s.cssText)},`)
          .join('\n');
        return `export const registry = {\n${entries}\n};\n`;
      }
      if (path === 'manifest') {
        const manifest: Record<string, string[]> = {};
        for (const [mod, atoms] of moduleToAtoms) {
          manifest[mod] = atoms;
        }
        return `export const manifest = ${JSON.stringify(manifest, null, 2)};\n`;
      }
      if (path === 'residuals') {
        return `export const residuals = ${JSON.stringify(residualLog, null, 2)};\n`;
      }
      if (path === 'route-loader') {
        return ROUTE_LOADER_SOURCE;
      }
      if (path.startsWith('dev/') && path.endsWith('.css')) {
        const key: string = path.slice('dev/'.length);
        const moduleId: string | undefined = devKeys.get(key);
        if (moduleId === undefined) return '';
        return devCss.get(moduleId) ?? '';
      }
      if (path.startsWith('pack/')) {
        // pack は実 CSS module (`...css` suffix) として vite/qwik の css 配信に乗る。
        // 中身は module の全 unit rule (§38 merge 済み)。
        const packId: string = path.slice('pack/'.length).replace(/\.css$/, '');
        return packCss.get(packId) ?? '';
      }
      return null;
    },

    transform(code: string, id: string): { code: string; map: QstyleSourceMap } | null {
      if (!id.endsWith('.tsx') && !id.endsWith('.jsx')) return null;
      // module 単位で作り直す (再 transform 時の stale 混入を防ぐ。dev HMR で必須)。
      moduleToAtoms.delete(id);
      devCss.delete(id);
      legacyStyles = legacyStyles.filter((entry) => entry.module !== id);
      // §24: legacy hooks は rewrite せず provenance のみ追跡する (scoped 解除しない)。
      if (code.includes('useStyles$') || code.includes('useStylesScoped$')) {
        for (const usage of collectLegacyHookUsages(code, id)) {
          const known: boolean = legacyStyles.some(
            (entry) =>
              entry.module === usage.module && entry.hook === usage.hook && entry.local === usage.local,
          );
          if (!known) {
            legacyStyles.push(usage);
            log(`legacy ${usage.hook} ${usage.local} from ${id}`);
          }
        }
      }
      if (!code.includes('css')) return null;
      const handles: ReadonlyMap<string, CssHandleEntry> = collectCssHandles(code);
      // cost-based 用の構造カウント。always では不要。
      // 同一 module 内容からは常に同一判定になり、traversal 順に依存しない (HASH-002)。
      const structCounts: Map<string, number> | null =
        promotion === 'always' ? null : countModuleStructures(code, handles);
      /** inline dynamic を parametric class へ promote すべきか。compound/handle は別途判定する。 */
      const shouldPromoteSingle = (propPath: string): boolean => {
        if (promotion === 'always') return true;
        if (promotion === 'never') return false;
        return (structCounts?.get(inlineStructKey(propPath, null)) ?? 0) >= 2;
      };
      /** compound 値を parametric class へ promote すべきか。 */
      const shouldPromoteCompound = (
        propPath: string,
        segments: readonly (
          | { readonly kind: 'text'; readonly text: string }
          | { readonly kind: 'expr'; readonly expr: string }
        )[],
      ): boolean => {
        if (promotion === 'always') return true;
        if (promotion === 'never') return false;
        // `!important` を含む static text は inline で落とすため promote する。
        if (
          segments.some((s) => s.kind === 'text' && /!important/i.test(s.text))
        ) {
          return true;
        }
        return (structCounts?.get(inlineStructKey(propPath, compoundSkeleton(segments))) ?? 0) >= 2;
      };
      const provenanceSource: string = id;
      const newUnitIds: string[] = [];
      const seen = new Set<string>();
      // 置換は original 座標の edits として集め、最後に一括適用する (source map 用)。
      // (a)/(b) の occurrence 検出はどちらも original code 基準 (互いの span は重ならない)。
      const edits: CodeEdit[] = [];
      // untouched にした箇所の理由。strict / error では即 throw し、
      // warning では transform 終了時に 1 行にまとめて出す (DIA-008/009)。
      const skippedReasons: string[] = [];
      const noteSkipped = (reason: string): void => {
        if (strict || diagnosticsMode === 'error') {
          throw new Error(`[qstyle] ${id}: ${reason}`);
        }
        if (diagnosticsMode === 'warning') skippedReasons.push(reason);
      };

      /**
       * delivery unit を収集する (plan.md §38: 適用単位で 1 class / 1 rule に merge)。
       * identity (dedup/provenance/usage graph) は atom 単位のまま記録する。
       */
      const ingestUnit = (unitId: string, members: readonly UnitMember[]): void => {
        if (!collected.has(unitId)) {
          collected.set(unitId, {
            id: unitId,
            cssText: serializeUnitCss(unitId, members),
            sourceId: id,
            members: [...new Set(members.map((m) => m.atomId))].sort(),
          });
        }
        const list: string[] = moduleToAtoms.get(id) ?? [];
        if (!list.includes(unitId)) {
          moduleToAtoms.set(id, [...list, unitId]);
        }
        for (const member of members) {
          // §38: usage graph へ style -> component (module) の edge を記録する (冪等)。
          recordUsage(graph, member.atomId, moduleKey(id));
          // §58: 同一 atom の全 origins を provenance として保持する。
          recordSource(graph, member.atomId, id);
        }
        if (!seen.has(unitId)) {
          seen.add(unitId);
          newUnitIds.push(unitId);
        }
        log(`collected unit ${unitId} (${members.length} decls) from ${id}`);
      };

      /** 独立 ternary 分岐の atoms を単一 member unit として収集する。 */
      const ingestAtomUnits = (atoms: readonly StaticAtom[]): void => {
        for (const atom of atoms) {
          const atomId: string = hashStaticAtom(atom);
          ingestUnit(unitIdOf([atomId]), [
            { atomId, context: atom.context, decl: serializeStaticDecl(atom) },
          ]);
        }
      };

      /**
       * 動的宣言を ParametricAtom 化する。単一 slot (`width: w`) と複合
       * template 値 (`` transform: `translateX(${x}px)` ``) の双方を扱う。
       * inline 残し/promote の判定は呼び出し側 (promotion mode) が行う。
       * var 名は生成された slot id のみから取る (SEC-005: source 由来の
       * 識別子を style key に使わない)。失敗時は null。
       */
      const buildParametrics = (
        decls: readonly {
          readonly propPath: string;
          readonly segments: readonly (
            | { readonly kind: 'text'; readonly text: string }
            | { readonly kind: 'expr'; readonly expr: string }
          )[];
        }[],
      ): {
        id: string;
        prop: string;
        slotIds: string[];
        cssText: string;
        decl: string;
        context: RuleContext;
        slotExprs: string[];
        important: boolean;
        valueText: string;
      }[] | null => {
        const parametrics: {
          id: string;
          prop: string;
          slotIds: string[];
          cssText: string;
          decl: string;
          context: RuleContext;
          slotExprs: string[];
          important: boolean;
          valueText: string;
        }[] = [];
        for (const decl of decls) {
          const parts: TemplatePartInput[] = [];
          const slots: TemplateSlotInput[] = [];
          const exprs: string[] = [];
          for (const segment of decl.segments) {
            if (segment.kind === 'text') {
              if (segment.text !== '') parts.push({ kind: 'text', text: segment.text });
            } else {
              parts.push({ kind: 'slot', slotIndex: slots.length });
              // ponytail: 型は一律 custom。同一 static text は同一推論になるため
              // grouping は型推論時と等価 (promotion は将来の cost model で扱う)。
              slots.push({ valueType: 'custom' });
              exprs.push(segment.expr);
            }
          }
          if (slots.length === 0) return null;
          const atom: ParametricAtom = createParametricAtom({
            property: decl.propPath,
            parts,
            slots,
            provenance: [{ source: provenanceSource, line: 1, column: 1 }],
          });
          const paramId: string = hashParametricAtom(atom);
          const slotIds: string[] = atom.slots.map((slot) => slot.id);
          if (slotIds.length !== exprs.length) return null;
          parametrics.push({
            id: paramId,
            prop: canonicalProperty(decl.propPath),
            slotIds,
            cssText: serializeParametricCss(atom, paramId),
            decl: serializeParametricDecl(atom),
            context: atom.context,
            slotExprs: exprs,
            important: atom.important,
            valueText: parametricValueText(atom),
          });
        }
        return parametrics;
      };

      /**
       * 有限静的 ternary 値を StaticAtom + runtime class choice へ展開する (DYN-016)。
       * takenProps (無条件 static/dynamic が占有) との競合・重複があれば null。
       * rewrite 確定まで収集の副作用は起こさず、segments と atoms を返す。
       */
      const buildConditional = (
        conditionals: readonly ConditionalStyleValue[],
        takenProps: ReadonlySet<string>,
      ): { segments: string[]; atoms: StaticAtom[] } | null => {
        const seen = new Set<string>();
        const segments: string[] = [];
        const atoms: StaticAtom[] = [];
        for (const c of conditionals) {
          if (c.propPath.includes('.') || !CSS_PROPERTY_RE.test(c.propPath)) return null;
          const prop: string = canonicalProperty(c.propPath);
          if (takenProps.has(prop) || seen.has(prop)) return null;
          seen.add(prop);
          const branchId = (value: string | number | null): string | null => {
            if (value === null) return '';
            const loweredBranch = lowerStyleObject(
              { [c.propPath]: value } as unknown as StyleObject,
              { source: provenanceSource },
            );
            if (loweredBranch.residuals.length > 0 || loweredBranch.atoms.length !== 1) {
              return null;
            }
            if (loweredBranch.diagnostics.some((d) => d.severity === 'error')) return null;
            const atom: StaticAtom | undefined = loweredBranch.atoms[0];
            if (atom === undefined) return null;
            atoms.push(atom);
            // 単一 atom の unit (独立 ternary 分岐は他と同時適用されないため merge しない)。
            return unitIdOf([hashStaticAtom(atom)]);
          };
          const trueId: string | null = branchId(c.whenTrue);
          const falseId: string | null = branchId(c.whenFalse);
          if (trueId === null || falseId === null) return null;
          if (trueId === '' && falseId === '') continue;
          segments.push(
            `(${c.condSource} ? ${JSON.stringify(trueId)} : ${JSON.stringify(falseId)})`,
          );
        }
        return { segments, atoms };
      };

            const ingestParametrics = (
        parametrics: readonly { id: string; decl: string; context: RuleContext }[],
      ): UnitMember[] => {
        return parametrics.map((param) => ({
          atomId: param.id,
          context: param.context,
          decl: param.decl,
        }));
      };

      /** preserve block 1 件を収集する (exact rule dedup は id で自然に成立する)。 */
      const ingestBlock = (blockId: string, cssText: string): void => {
        if (!collected.has(blockId)) {
          collected.set(blockId, { id: blockId, cssText, sourceId: id });
        }
        const list: string[] = moduleToAtoms.get(id) ?? [];
        if (!list.includes(blockId)) {
          moduleToAtoms.set(id, [...list, blockId]);
        }
        recordUsage(graph, blockId, moduleKey(id));
        recordSource(graph, blockId, id);
        if (!seen.has(blockId)) {
          seen.add(blockId);
          newUnitIds.push(blockId);
        }
        log(`collected ${blockId} (preserve) from ${id}`);
      };

      /**
       * タグ head へ class (+ 必要なら style prop) を merge した newHead を返す。
       * styleEntries が null なら class のみ。閉じ `}` を安全に決められない
       * style prop がある場合は null (untouched を維持)。
       * pure 関数: 呼び出し側が edit として記録し、最後に一括適用する (source map 用)。
       */
      const spliceTag = (
        head: string,
        ids: string[],
        styleEntries: string | null,
        condSegments: readonly string[] = [],
      ): string | null => {
        // 既存 style prop があれば slot var の代入をその閉じ `}` 直前に merge
        // し、なければ class 属性の直後に style prop を新規付与する。
        const hasStyleProp: boolean = /style\s*=\s*\{\{/.test(head);
        let head2: string = head;
        if (styleEntries !== null && hasStyleProp) {
          const styleMatch: RegExpMatchArray | null = /style\s*=\s*\{\{/.exec(head) as RegExpMatchArray;
          const styleObjOpen: number = (styleMatch.index ?? 0) + styleMatch[0].length - 1;
          const styleObjClose: number = findMatchingBrace(head, styleObjOpen);
          // 閉じ `}` を安全に決められない style prop は触らない。
          if (styleObjClose < 0) return null;
          // 閉じ `}` の直前 (既存宣言の後) へ slot var の代入を追加する。
          // 末尾の trailing comma / 空白は撒き直して `,,` を作らない。
          const inner: string = head.slice(styleObjOpen + 1, styleObjClose);
          const kept: string = inner.replace(/[\s,]+$/, '');
          const insertAt: number = styleObjOpen + 1 + kept.length;
          const sep: string = kept.length > 0 ? ', ' : '';
          head2 = head.slice(0, insertAt) + `${sep}${styleEntries}` + head.slice(insertAt);
        }
        // 同一タグ内の既存 class に追記する (なければ新規付与)。
        // class="..." リテラルは文字列追記、class={...} 式は Qwik ClassList の
        // 配列ラップで合成する (falsy/nested を正しく扱えるのは Qwik のみ)。
        // `{...spread}` がある場合は、明示 class が全 spread より後にあれば安全
        // (JSX は後の prop が勝つため spread 内 class は既に死んでいる)。
        // それ以外は class 解決不能のため untouched。
        const attrs = scanTagAttributes(head);
        const attrs2 = scanTagAttributes(head2);
        if (attrs === null || attrs2 === null) return null;
        if (attrs.lastSpreadEnd >= 0) {
          if (attrs.classStart < 0 || attrs.classStart < attrs.lastSpreadEnd) {
            noteSkipped('spread props with css are not supported; left untouched');
            return null;
          }
        }
        const classExpr = extractClassExpr(head2, attrs2.classStart);
        const classMatch: RegExpMatchArray | null =
          classExpr === null && attrs2.classStart >= 0
            ? /^class\s*=\s*(["'])(.*?)\1/.exec(head2.slice(attrs2.classStart))
            : null;
        let newHead: string;
        if (condSegments.length > 0) {
          const staticChunk: string = [
            ...(classMatch?.[2] ? [classMatch[2] as string] : []),
            ...ids,
          ].join(' ');
          const expr: string = [
            ...(staticChunk === '' ? [] : [`${JSON.stringify(`${staticChunk} `)}`]),
            ...condSegments,
          ].join(' + ');
          const condAttr: string = `class={${expr === '' ? '""' : expr}}`;
          if (classExpr !== null) {
            // 既存 class={...} 式と合成する: class={[EXISTING, ...generated]}。
            newHead =
              head2.slice(0, classExpr.start) +
              `class={[${classExpr.expr}, ${expr === '' ? '""' : expr}]}` +
              head2.slice(classExpr.end);
          } else if (classMatch !== null) {
            const classStart: number = attrs2.classStart;
            newHead =
              head2.slice(0, classStart) + condAttr + head2.slice(classStart + classMatch[0].length);
          } else {
            newHead = `${head2}${condAttr}`;
          }
          if (styleEntries !== null && !hasStyleProp) {
            newHead = `${newHead} style={{ ${styleEntries} }}`;
          }
        } else if (classMatch !== null) {
          const quote: string = classMatch[1] as string;
          const classStart: number = attrs2.classStart;
          const attr: string = `class=${quote}${`${classMatch[2]} ${ids.join(' ')}`.trim()}${quote}`;
          newHead =
            head2.slice(0, classStart) + attr + head2.slice(classStart + classMatch[0].length);
          if (styleEntries !== null && !hasStyleProp) {
            newHead =
              newHead.slice(0, classStart + attr.length) +
              ` style={{ ${styleEntries} }}` +
              newHead.slice(classStart + attr.length);
          }
        } else if (classExpr !== null) {
          // 既存 class={...} 式と合成する: class={[EXISTING, "ids"]}。
          // ids が空の場合は既存のまま (style のみ追加)。
          const attr: string =
            ids.length > 0 ? `class={[${classExpr.expr}, ${JSON.stringify(ids.join(' '))}]}` : '';
          newHead =
            head2.slice(0, classExpr.start) +
            (attr !== '' ? attr : head2.slice(classExpr.start, classExpr.end)) +
            head2.slice(classExpr.end);
          if (styleEntries !== null && !hasStyleProp) {
            newHead = `${newHead} style={{ ${styleEntries} }}`;
          }
        } else {
          // ids が空 (全て inline 化) の場合は class 属性を出さない。
          // head2 の末尾が attr 直後 (非空白) の場合は区切りを入れる。
          const sep: string = /\s$/.test(head2) ? '' : ' ';
          const classPart: string = ids.length > 0 ? `class="${ids.join(' ')}"` : '';
          const stylePart: string =
            styleEntries !== null && !hasStyleProp
              ? `${classPart !== '' ? ' ' : ''}style={{ ${styleEntries} }}`
              : '';
          newHead = `${head2}${sep}${classPart}${stylePart}`;
        }
        return newHead;
      };

      /** tag head を取り出し、splice 成功時は edit として記録する。失敗時は false。 */
      const recordTagEdit = (
        edits: CodeEdit[],
        occStart: number,
        exprClose: number,
        ids: string[],
        styleEntries: string | null,
        condSegments: readonly string[],
      ): boolean => {
        const tagStart: number = Math.max(code.lastIndexOf('<', occStart), 0);
        // head は開始タグ全体 ('>' 直前まで)。css prop より後ろの class / style
        // 属性もマージ対象にするため (クラス重複の出力を防ぐ)。
        const gt: number | null = findOpeningTagGt(code, occStart);
        if (gt === null) {
          noteSkipped('cannot find tag end; left untouched');
          return false;
        }
        const headAll: string = code.slice(tagStart, gt);
        recordUnitTags(headAll, ids);
        let head: string =
          code.slice(tagStart, occStart) + code.slice(exprClose, gt);
        // 自己閉じ '/' は attr 追記の邪魔になるため外し、最後に付け直す。
        let selfClose = false;
        const headTrimmed: string = head.trimEnd();
        if (headTrimmed.endsWith('/')) {
          selfClose = true;
          head = headTrimmed.slice(0, -1);
        }
        const newHeadBody: string | null = spliceTag(head, ids, styleEntries, condSegments);
        if (newHeadBody === null) {
          noteSkipped('cannot safely merge into existing style prop; left untouched');
          return false;
        }
        const newHead: string = selfClose ? `${newHeadBody.trimEnd()} /` : newHeadBody;
        edits.push({
          start: tagStart,
          end: gt,
          newText: newHead,
          srcLine: originalLineOf(code, occStart),
        });
        return true;
      };

      const occurrences: CssPropOccurrence[] = findCssPropOccurrences(code);
      // 後方から置換して offset ずれを避ける。
      for (let k: number = occurrences.length - 1; k >= 0; k -= 1) {
        const occ: CssPropOccurrence = occurrences[k] as CssPropOccurrence;
        const literal: string = code.slice(occ.braceOpen, occ.braceClose);
        const parsed: ParsedStyleLiteral | null = parseStyleObjectLiteralWithDynamics(literal);
        if (parsed === null) {
          noteSkipped('cannot parse css object literal; left untouched');
          continue;
        }
        const { record, dynamics, conditionals, compounds } = parsed;
        // 動的な値は top-level property のみ対応する。nested (dotted propPath)
        // は context 付き slot を生成できないため untouched (correctness first)。
        if (
          [...dynamics, ...compounds].some((d) => d.propPath.includes('.')) ||
          conditionals.some((d) => d.propPath.includes('.'))
        ) {
          noteSkipped('nested dynamic value is not supported; left untouched');
          continue;
        }
        if (
          [...dynamics, ...compounds].some((d) => !CSS_PROPERTY_RE.test(d.propPath)) ||
          conditionals.some((d) => !CSS_PROPERTY_RE.test(d.propPath))
        ) {
          noteSkipped('unsupported dynamic property; left untouched');
          continue;
        }
        // 静的宣言のみ lowering する。parser 出力は string/number/boolean/null/
        // plain object のみであり StyleObject の実行時サブセットである。
        const lowered = lowerStyleObject(record as unknown as StyleObject, {
          source: provenanceSource,
        });
        if (lowered.residuals.length > 0) {
          for (const residual of lowered.residuals) {
            if (residualLog.length >= MAX_RESIDUAL_LOG) break;
            residualLog.push(residual);
          }
          noteSkipped(
            `unsafe to atomicize (${lowered.residuals[0]?.reason ?? 'unknown'}); left untouched`,
          );
          continue;
        }
        if (lowered.diagnostics.some((d) => d.severity === 'error')) {
          noteSkipped('style diagnostic error; left untouched');
          continue;
        }
        if (
          lowered.atoms.length === 0 &&
          dynamics.length === 0 &&
          conditionals.length === 0 &&
          compounds.length === 0
        ) {
          continue;
        }
        // static と dynamic/compound の同一 property は cascade 順を保証できない。
        // dynamic と compound の同一 property も構造が違えば同様 (plan.md §112)。
        const dynamicPropSet = new Set<string>([
          ...dynamics.map((d) => canonicalProperty(d.propPath)),
          ...compounds.map((c) => canonicalProperty(c.propPath)),
        ]);
        if (lowered.atoms.some((a) => dynamicPropSet.has(a.property))) {
          noteSkipped('static/dynamic property conflict; left untouched');
          continue;
        }
        if (
          new Set<string>(dynamics.map((d) => canonicalProperty(d.propPath))).size +
            new Set<string>(compounds.map((c) => canonicalProperty(c.propPath))).size !==
          dynamicPropSet.size
        ) {
          noteSkipped('conflicting dynamic value kinds; left untouched');
          continue;
        }
        // promotion (§32): 共有されない単発 dynamic は inline のままにし、
        // promote するものだけ ParametricAtom 化する。inline も property を占有する。
        const promotedDynamics: DynamicStyleValue[] = [];
        const inlineDynamicEntries: string[] = [];
        for (const d of dynamics) {
          // inline fallback は author 記述の key を保つ (runtime の style 解決に委ねる)。
          if (shouldPromoteSingle(d.propPath)) promotedDynamics.push(d);
          else inlineDynamicEntries.push(`'${d.propPath}': ${d.exprSource}`);
        }
        const promotedCompounds: CompoundStyleValue[] = [];
        for (const c of compounds) {
          if (shouldPromoteCompound(c.propPath, c.segments)) promotedCompounds.push(c);
          else inlineDynamicEntries.push(`'${c.propPath}': ${inlineCompoundValue(c.segments)}`);
        }
        // 動的宣言を ParametricAtom 化する (単一 slot + 複合 template 値)。
        const paramDecls = [
          ...promotedDynamics.map((d) => ({
            propPath: d.propPath,
            segments: [{ kind: 'expr', expr: d.exprSource }] as const,
          })),
          ...promotedCompounds.map((c) => ({ propPath: c.propPath, segments: c.segments })),
        ];
        const parametrics = buildParametrics(paramDecls);
        if (parametrics === null) {
          noteSkipped('cannot lower dynamic value; left untouched');
          continue;
        }
        // 同一 property に構造の異なる parametric があれば順序保証できない。
        // 同一 atom の重複は許す (値だけが上書きされる)。
        const inlinePropAtom = new Map<string, string>();
        let paramConflict = false;
        for (const p of parametrics) {
          const prev: string | undefined = inlinePropAtom.get(p.prop);
          if (prev !== undefined && prev !== p.id) {
            noteSkipped('conflicting parametric structures; left untouched');
            paramConflict = true;
            break;
          }
          inlinePropAtom.set(p.prop, p.id);
        }
        if (paramConflict) continue;
        // preserve: 宣言を分割せず 1 block にする。static-then-dynamic の固定順に
        // なるため、順序依存ペアがあれば untouched (needsOrderingGroup)。
        // dynamic 同士の構造衝突は上流の inlinePropAtom 検査で既に除外済み。
        if (preserve) {
          const dynPropList: string[] = parametrics.map((p) => p.prop);
          let unsafeOrder = false;
          for (const a of lowered.atoms) {
            for (const dp of dynPropList) {
              if (needsOrderingGroup(a.property, dp)) {
                unsafeOrder = true;
                break;
              }
            }
            if (unsafeOrder) break;
          }
          if (unsafeOrder) {
            noteSkipped('unsafe ordering in preserve mode; left untouched');
            continue;
          }
          const blockDecls: BlockDecl[] = [
            ...lowered.atoms.map((a) => ({
              property: a.property,
              valueText: a.value,
              important: a.important,
              context: a.context,
            })),
            ...parametrics.map((p) => ({
              property: p.prop,
              valueText: p.valueText,
              important: p.important,
              context: {} as RuleContext,
            })),
          ];
          const blockId: string = preserveBlockId(blockDecls);
          const blockCss: string = serializePreserveBlock(blockId, blockDecls);
          // 有限静的 ternary 値は block とは別 class のまま展開する (単一 class 化不能のため)。
          const takenProps = new Set<string>([
            ...lowered.atoms.map((a) => a.property),
            ...dynamics.map((d) => canonicalProperty(d.propPath)),
            ...compounds.map((c) => canonicalProperty(c.propPath)),
          ]);
          const conditional = buildConditional(conditionals, takenProps);
          if (conditional === null) {
            noteSkipped('conflicting conditional value; left untouched');
            continue;
          }
          // 宣言が全て inline 化された場合は class を出さない。
          const hasBlock: boolean = blockDecls.length > 0;
          const preserveIds: string[] = hasBlock ? [blockId] : [];
          const preserveSlotEntries: string[] = parametrics.flatMap((p) =>
            p.slotIds.map((slotId, k) => `'${slotId}': ${p.slotExprs[k] ?? ''}`),
          );
          const preserveAllEntries: string[] = [...inlineDynamicEntries, ...preserveSlotEntries];
          const preserveStyleEntries: string | null =
            preserveAllEntries.length > 0 ? preserveAllEntries.join(', ') : null;
          const preserveNext: boolean = recordTagEdit(
            edits,
            occ.start,
            occ.exprClose,
            preserveIds,
            preserveStyleEntries,
            conditional.segments,
          );
          if (!preserveNext) {
            continue;
          }
          if (hasBlock) ingestBlock(blockId, blockCss);
          ingestAtomUnits(conditional.atoms);
          continue;
        }
        // 有限静的 ternary 値は CSS variable 化せず static branch にする (DYN-016)。
        const takenProps = new Set<string>([
          ...lowered.atoms.map((a) => a.property),
          ...dynamics.map((d) => canonicalProperty(d.propPath)),
          ...compounds.map((c) => canonicalProperty(c.propPath)),
        ]);
        const conditional = buildConditional(conditionals, takenProps);
        if (conditional === null) {
          noteSkipped('conflicting conditional value; left untouched');
          continue;
        }
        // (a) も無条件分は 1 unit 1 class に merge する (§38)。
        const membersA: UnitMember[] = [
          ...lowered.atoms.map((a) => ({
            atomId: hashStaticAtom(a),
            context: a.context,
            decl: serializeStaticDecl(a),
          })),
          ...ingestParametrics(parametrics),
        ];
        const ids: string[] = membersA.length > 0 ? [unitIdOf(membersA.map((m) => m.atomId))] : [];
        const slotEntries: string[] = parametrics.flatMap((p) =>
          p.slotIds.map((slotId, k) => `'${slotId}': ${p.slotExprs[k] ?? ''}`),
        );
        const allEntries: string[] = [...inlineDynamicEntries, ...slotEntries];
        const styleEntries: string | null = allEntries.length > 0 ? allEntries.join(', ') : null;
        const next: boolean = recordTagEdit(
          edits,
          occ.start,
          occ.exprClose,
          ids,
          styleEntries,
          conditional.segments,
        );
        if (!next) {
          continue;
        }
        if (ids.length > 0) ingestUnit(ids[0] as string, membersA);
        ingestAtomUnits(conditional.atoms);
      }
      // (b) M3: module-scope css() handle + css={...} composition (plan.md §21)。
      // static に解決できるもののみ rewrite し、条件付き (&&/?:)・未知参照・
      // 衝突する dynamic は untouched にする (correctness first)。
      // handles は transform 先頭で収集済み。
      // handle 参照がなくてもインライン css タグ・inline object の合成は解決できるため、
      // `css={` があれば走査する (解決不能は untouched + diagnostic)。
      // (a) と span が重ならないため original code 基準でよい。
      const exprOccurrences: CssExprOccurrence[] = findCssExprOccurrences(code);
      if (exprOccurrences.length > 0) {
        for (let k: number = exprOccurrences.length - 1; k >= 0; k -= 1) {
          const occ: CssExprOccurrence = exprOccurrences[k] as CssExprOccurrence;
          const inner: string = code.slice(occ.exprOpen + 1, occ.exprClose - 1);
          const parts: ResolvedPart[] | null = resolveCssExprParts(inner, handles);
          if (parts === null) {
            noteSkipped(
              crossModuleHint(code, inner) ??
                'cannot statically resolve css composition; left untouched',
            );
            continue;
          }
          if (parts.length === 0) continue;
          // 無条件 parts は composition し、条件付きは個別 class として残す (CMP-007)。
          // interpolation 付き template handle は parametric として分離する (M5b 末端)。
          // static 側 (record/handleAtoms) を持つ part は parametric 併持でも composition する。
          const plain: ResolvedPart[] = parts.filter(
            (p) =>
              p.cond === undefined && (p.record !== undefined || p.handleAtoms !== undefined),
          );
          const conds: ResolvedPart[] = parts.filter((p) => p.cond !== undefined);
          const paramParts: ResolvedPart[] = parts.filter(
            (p) => p.cond === undefined && p.handleParametrics !== undefined,
          );
          // preserve: parts 順に連結する (compose の reorder/dedup をしない)。
          // 無条件 static/dynamic は 1 block、条件付きは branch ごとの mini-block にする。
          if (preserve) {
            if (conds.some((p) => p.handleParametrics !== undefined)) {
              noteSkipped('conditional parametric value is not supported; left untouched');
              continue;
            }
            const blockDecls: BlockDecl[] = [];
            const preserveSlotEntries: string[] = [];
            const preserveConditionals: ConditionalStyleValue[] = [];
            let preserveFailed = false;
            for (const part of parts) {
              if (part.cond !== undefined) continue;
              const partDeclStart: number = blockDecls.length;
              if (part.record !== undefined) {
                const loweredPart = lowerStyleObject(part.record as unknown as StyleObject, {
                  source: provenanceSource,
                });
                if (loweredPart.residuals.length > 0) {
                  for (const residual of loweredPart.residuals) {
                    if (residualLog.length >= MAX_RESIDUAL_LOG) break;
                    residualLog.push(residual);
                  }
                  noteSkipped('unsafe to atomicize; left untouched');
                  preserveFailed = true;
                  break;
                }
                if (loweredPart.diagnostics.some((d) => d.severity === 'error')) {
                  noteSkipped('style diagnostic error; left untouched');
                  preserveFailed = true;
                  break;
                }
                for (const a of loweredPart.atoms) {
                  blockDecls.push({
                    property: a.property,
                    valueText: a.value,
                    important: a.important,
                    context: a.context,
                  });
                }
              } else if (part.handleAtoms !== undefined) {
                for (const a of part.handleAtoms) {
                  blockDecls.push({
                    property: a.property,
                    valueText: a.value,
                    important: a.important,
                    context: a.context,
                  });
                }
              }
              // inline dynamic/compound はその場で parametric 化する (part 順維持)。
              // intra-part の static × dynamic のみ順序検査する (part 間は宣言順に完全再現)。
              const partDynDecls = [
                ...part.dynamics.map((d) => ({
                  propPath: d.propPath,
                  segments: [{ kind: 'expr', expr: d.exprSource }] as const,
                })),
                ...part.compounds.map((c) => ({ propPath: c.propPath, segments: c.segments })),
              ];
              const partBuilt = buildParametrics(partDynDecls);
              if (partBuilt === null) {
                noteSkipped('cannot lower dynamic value; left untouched');
                preserveFailed = true;
                break;
              }
              const partStaticProps: string[] = blockDecls
                .slice(partDeclStart)
                .map((d) => d.property);
              for (const b of partBuilt) {
                if (partStaticProps.some((sp) => needsOrderingGroup(sp, b.prop))) {
                  noteSkipped('unsafe ordering in preserve mode; left untouched');
                  preserveFailed = true;
                  break;
                }
              }
              if (preserveFailed) break;
              for (const b of partBuilt) {
                blockDecls.push({
                  property: b.prop,
                  valueText: b.valueText,
                  important: b.important,
                  context: {},
                });
                for (let k = 0; k < b.slotIds.length; k += 1) {
                  preserveSlotEntries.push(`'${b.slotIds[k] ?? ''}': ${b.slotExprs[k] ?? ''}`);
                }
              }
              const pe = part.handleParametrics;
              if (pe !== undefined) {
                for (const atom of pe.atoms) {
                  blockDecls.push({
                    property: atom.property,
                    valueText: parametricValueText(atom),
                    important: atom.important,
                    context: atom.context,
                  });
                  for (const slot of atom.slots) {
                    const expr: string | undefined = pe.slotExprs.get(slot.id);
                    if (expr === undefined) {
                      noteSkipped('missing slot expression; left untouched');
                      preserveFailed = true;
                      break;
                    }
                    preserveSlotEntries.push(`'${slot.id}': ${expr}`);
                  }
                  if (preserveFailed) break;
                }
              }
              if (preserveFailed) break;
              preserveConditionals.push(...part.conditionals);
            }
            if (preserveFailed) continue;
            if (blockDecls.length === 0 && conds.length === 0 && preserveConditionals.length === 0) {
              continue;
            }
            // conds (preserve): static branch → mini-block、dynamic → parametric + spread。
            // 無条件 block より後に置くことで、有効時の override を保証する。
            interface PreserveCondGroup {
              readonly cond: string;
              readonly miniBlock: { id: string; css: string } | null;
              readonly params: NonNullable<ReturnType<typeof buildParametrics>>;
              readonly spreads: string[];
              readonly props: string[];
            }
            const preserveCondGroups: PreserveCondGroup[] = [];
            let preserveCondFailed = false;
            for (const part of conds) {
              const cond: string = part.cond ?? '';
              if (part.handleParametrics !== undefined) {
                noteSkipped('conditional parametric value is not supported; left untouched');
                preserveCondFailed = true;
                break;
              }
              const miniDecls: BlockDecl[] = [];
              if (part.handleAtoms !== undefined) {
                for (const a of part.handleAtoms) {
                  miniDecls.push({
                    property: a.property,
                    valueText: a.value,
                    important: a.important,
                    context: a.context,
                  });
                }
              } else if (part.record !== undefined) {
                const loweredCond = lowerStyleObject(part.record as unknown as StyleObject, {
                  source: provenanceSource,
                });
                if (loweredCond.residuals.length > 0) {
                  noteSkipped('unsafe conditional branch; left untouched');
                  preserveCondFailed = true;
                  break;
                }
                if (loweredCond.diagnostics.some((d) => d.severity === 'error')) {
                  noteSkipped('style diagnostic error; left untouched');
                  preserveCondFailed = true;
                  break;
                }
                for (const a of loweredCond.atoms) {
                  miniDecls.push({
                    property: a.property,
                    valueText: a.value,
                    important: a.important,
                    context: a.context,
                  });
                }
              } else if (part.dynamics.length === 0 && part.compounds.length === 0) {
                noteSkipped('cannot resolve conditional branch; left untouched');
                preserveCondFailed = true;
                break;
              }
              const condDynDecls = [
                ...part.dynamics.map((d) => ({
                  propPath: d.propPath,
                  segments: [{ kind: 'expr', expr: d.exprSource }] as const,
                })),
                ...part.compounds.map((c) => ({ propPath: c.propPath, segments: c.segments })),
              ];
              if (
                condDynDecls.some(
                  (d) => d.propPath.includes('.') || !CSS_PROPERTY_RE.test(d.propPath),
                )
              ) {
                noteSkipped('unsupported conditional dynamic value; left untouched');
                preserveCondFailed = true;
                break;
              }
              const condBuilt = buildParametrics(condDynDecls);
              if (condBuilt === null) {
                noteSkipped('cannot lower conditional dynamic value; left untouched');
                preserveCondFailed = true;
                break;
              }
              // mini-block 内 static × dynamic の intra-branch gate。
              const branchStaticProps: string[] = miniDecls.map((d) => d.property);
              if (
                condBuilt.some((b) =>
                  branchStaticProps.some((sp) => needsOrderingGroup(sp, b.prop)),
                )
              ) {
                noteSkipped('conflicting conditional declarations; left untouched');
                preserveCondFailed = true;
                break;
              }
              const condSpreads: string[] = condBuilt.flatMap((b) =>
                b.slotIds.map((slotId, k) => `'${slotId}': ${b.slotExprs[k] ?? ''}`),
              );
              const condProps: string[] = [
                ...branchStaticProps,
                ...condBuilt.map((b) => b.prop),
              ];
              let miniBlock: { id: string; css: string } | null = null;
              if (miniDecls.length > 0) {
                const miniId: string = preserveBlockId(miniDecls);
                miniBlock = { id: miniId, css: serializePreserveBlock(miniId, miniDecls) };
              }
              preserveCondGroups.push({
                cond,
                miniBlock,
                params: condBuilt,
                spreads: condSpreads,
                props: condProps,
              });
            }
            if (preserveCondFailed) continue;
            const preserveCondSegments: string[] = [];
            const preserveCondSpreads: string[] = [];
            for (const group of preserveCondGroups) {
              const groupIds: string = [
                ...(group.miniBlock === null ? [] : [group.miniBlock.id]),
                ...group.params.map((p) => unitIdOf([p.id])),
              ].join(' ');
              preserveCondSegments.push(`(${group.cond} ? ${JSON.stringify(groupIds)} : "")`);
              if (group.spreads.length > 0) {
                preserveCondSpreads.push(`...(${group.cond} && {${group.spreads.join(', ')}})`);
              }
            }
            // 有限静的 ternary 値。block + 全 cond の占有 property と競合すれば拒否する。
            const preserveTaken = new Set<string>([
              ...blockDecls.map((d) => d.property),
              ...preserveCondGroups.flatMap((g) => g.props),
            ]);
            const preserveConditional = buildConditional(preserveConditionals, preserveTaken);
            if (preserveConditional === null) {
              noteSkipped('conflicting conditional value; left untouched');
              continue;
            }
            const hasBlock: boolean = blockDecls.length > 0;
            const preserveBlockIdValue: string = hasBlock ? preserveBlockId(blockDecls) : '';
            const preserveIds: string[] = hasBlock ? [preserveBlockIdValue] : [];
            const preserveEntries: string = [
              preserveSlotEntries.join(', '),
              preserveCondSpreads.join(', '),
            ]
              .filter((e) => e !== '')
              .join(', ');
            const preserveStyleEntries: string | null =
              preserveEntries === '' ? null : preserveEntries;
            const preserveNext: boolean = recordTagEdit(
              edits,
              occ.start,
              occ.exprClose,
              preserveIds,
              preserveStyleEntries,
              [...preserveCondSegments, ...preserveConditional.segments],
            );
            if (!preserveNext) {
              continue;
            }
            if (hasBlock) {
              ingestBlock(
                preserveBlockIdValue,
                serializePreserveBlock(preserveBlockIdValue, blockDecls),
              );
            }
            for (const group of preserveCondGroups) {
              if (group.miniBlock !== null) ingestBlock(group.miniBlock.id, group.miniBlock.css);
              for (const p of group.params) {
                ingestUnit(unitIdOf([p.id]), [
                  { atomId: p.id, context: p.context, decl: p.decl },
                ]);
              }
            }
            ingestAtomUnits(preserveConditional.atoms);
            continue;
          }
          if (conds.some((p) => p.handleParametrics !== undefined)) {
            noteSkipped('conditional parametric value is not supported; left untouched');
            continue;
          }
          const composed = composeCssProp(toCssPropParts(plain), {
            source: provenanceSource,
          });
          if (composed.residuals.length > 0) {
            for (const residual of composed.residuals) {
              if (residualLog.length >= MAX_RESIDUAL_LOG) break;
              residualLog.push(residual);
            }
            noteSkipped(
              `unsafe to atomicize (${composed.residuals[0]?.reason ?? 'unknown'}); left untouched`,
            );
            continue;
          }
          if (composed.diagnostics.some((d) => d.severity === 'error')) {
            noteSkipped('style diagnostic error; left untouched');
            continue;
          }
          const dynamics: DynamicStyleValue[] = plain.flatMap((p) => p.dynamics);
          const conditionals: ConditionalStyleValue[] = plain.flatMap((p) => p.conditionals);
          const compounds: CompoundStyleValue[] = plain.flatMap((p) => p.compounds);
          if (
            composed.atoms.length === 0 &&
            dynamics.length === 0 &&
            conds.length === 0 &&
            conditionals.length === 0 &&
            compounds.length === 0 &&
            paramParts.length === 0
          ) {
            continue;
          }
          // static atom と dynamic/compound が同一 property で競合したら cascade 順を
          // 保証できないため untouched (plan.md §112)。
          const staticProps = new Set<string>(
            composed.atoms.map((a) => (a as StaticAtom).property),
          );
          const inlineDynamicProps = new Set<string>([
            ...dynamics.map((d) => canonicalProperty(d.propPath)),
            ...compounds.map((c) => canonicalProperty(c.propPath)),
          ]);
          if (
            [...dynamics, ...compounds].some((d) => staticProps.has(canonicalProperty(d.propPath)))
          ) {
            noteSkipped('static/dynamic property conflict; left untouched');
            continue;
          }
          const dynamicsProps = new Set<string>(dynamics.map((d) => canonicalProperty(d.propPath)));
          const compoundsProps = new Set<string>(compounds.map((c) => canonicalProperty(c.propPath)));
          if ([...dynamicsProps].some((p) => compoundsProps.has(p))) {
            noteSkipped('conflicting dynamic value kinds; left untouched');
            continue;
          }
          // promotion (§32): 単発 inline dynamic/compound は style のままにする。
          const promotedDynamics: DynamicStyleValue[] = [];
          const inlineEntries: string[] = [];
          for (const d of dynamics) {
            if (shouldPromoteSingle(d.propPath)) promotedDynamics.push(d);
            else inlineEntries.push(`'${d.propPath}': ${d.exprSource}`);
          }
          const promotedCompounds: CompoundStyleValue[] = [];
          for (const c of compounds) {
            if (shouldPromoteCompound(c.propPath, c.segments)) promotedCompounds.push(c);
            else inlineEntries.push(`'${c.propPath}': ${inlineCompoundValue(c.segments)}`);
          }
          const paramDecls = [
            ...promotedDynamics.map((d) => ({
              propPath: d.propPath,
              segments: [{ kind: 'expr', expr: d.exprSource }] as const,
            })),
            ...promotedCompounds.map((c) => ({ propPath: c.propPath, segments: c.segments })),
          ];
          const parametrics = buildParametrics(paramDecls);
          if (parametrics === null) {
            noteSkipped('cannot lower dynamic value; left untouched');
            continue;
          }
          const inlinePropAtom = new Map<string, string>();
          let inlineParamConflict = false;
          for (const p of parametrics) {
            const prev: string | undefined = inlinePropAtom.get(p.prop);
            if (prev !== undefined && prev !== p.id) {
              noteSkipped('conflicting parametric structures; left untouched');
              inlineParamConflict = true;
              break;
            }
            inlinePropAtom.set(p.prop, p.id);
          }
          if (inlineParamConflict) continue;
          // interpolation 付き template handle (M5b 末端)。
          // promote 時は slot 式を style var へ入れ、never 時は context-free のみ inline 展開する。
          // 無条件 static/dynamic との同一 property 競合・構造の異なる parametric
          // 重複は cascade 順を保証できないため untouched。
          // inlineDynamicProps は上方の定義 (dynamics + compounds) を使う。
          const entryParamIds: string[] = [];
          const entrySlotEntries: string[] = [];
          const entryPropAtom = new Map<string, string>();
          const entryMembers: UnitMember[] = [];
          let entryFailed = false;
          for (const part of paramParts) {
            const pe = part.handleParametrics;
            if (pe === undefined) {
              noteSkipped('cannot resolve parametric handle; left untouched');
              entryFailed = true;
              break;
            }
            if (promotion === 'never') {
              for (const atom of pe.atoms) {
                if (atomHasContext(atom)) {
                  noteSkipped('context-bound dynamic cannot stay inline; left untouched');
                  entryFailed = true;
                  break;
                }
                const inlineValue: string | null = inlineParametricValue(atom, pe.slotExprs);
                if (inlineValue === null) {
                  noteSkipped('missing slot expression; left untouched');
                  entryFailed = true;
                  break;
                }
                entrySlotEntries.push(`'${atom.property}': ${inlineValue}`);
              }
              if (entryFailed) break;
              continue;
            }
            for (const atom of pe.atoms) {
              const atomId: string = hashParametricAtom(atom);
              if (staticProps.has(atom.property) || inlineDynamicProps.has(atom.property)) {
                noteSkipped('static/parametric property conflict; left untouched');
                entryFailed = true;
                break;
              }
              const prev: string | undefined = entryPropAtom.get(atom.property);
              if (prev !== undefined && prev !== atomId) {
                noteSkipped('conflicting parametric structures; left untouched');
                entryFailed = true;
                break;
              }
              entryPropAtom.set(atom.property, atomId);
              entryParamIds.push(atomId);
              entryMembers.push({
                atomId,
                context: atom.context,
                decl: serializeParametricDecl(atom),
              });
            }
            if (entryFailed) break;
            for (const atom of pe.atoms) {
              for (const slot of atom.slots) {
                const expr: string | undefined = pe.slotExprs.get(slot.id);
                if (expr === undefined) {
                  noteSkipped('missing slot expression; left untouched');
                  entryFailed = true;
                  break;
                }
                entrySlotEntries.push(`'${slot.id}': ${expr}`);
              }
              if (entryFailed) break;
            }
          }
          if (entryFailed) continue;
          // 条件付き parts は宣言順に lowering する。static は class segment、
          // dynamic/compound は parametric class + 条件スプレッドにする。
          // 無条件 style より後に置くことで、有効時の override を保証する (CMP-007)。
          // rewrite 成否が決まるまで収集の副作用は起こさない。
          interface CondGroup {
            readonly cond: string;
            readonly staticAtoms: StaticAtom[];
            readonly members: UnitMember[];
            readonly spreads: string[];
            readonly dynProps: string[];
          }
          const condGroups: CondGroup[] = [];
          let condFailed = false;
          for (const part of conds) {
            const cond: string = part.cond ?? '';
            let staticAtoms: StaticAtom[] = [];
            if (part.handleAtoms !== undefined) {
              staticAtoms = [...part.handleAtoms];
            } else if (part.record !== undefined) {
              const loweredCond = lowerStyleObject(part.record as unknown as StyleObject, {
                source: provenanceSource,
              });
              if (loweredCond.residuals.length > 0) {
                noteSkipped('unsafe conditional branch; left untouched');
                condFailed = true;
                break;
              }
              if (loweredCond.diagnostics.some((d) => d.severity === 'error')) {
                noteSkipped('style diagnostic error; left untouched');
                condFailed = true;
                break;
              }
              staticAtoms = [...loweredCond.atoms];
            } else if (part.dynamics.length === 0 && part.compounds.length === 0) {
              noteSkipped('cannot resolve conditional branch; left untouched');
              condFailed = true;
              break;
            }
            const dynDecls = [
              ...part.dynamics.map((d) => ({
                propPath: d.propPath,
                segments: [{ kind: 'expr', expr: d.exprSource }] as const,
              })),
              ...part.compounds.map((c) => ({ propPath: c.propPath, segments: c.segments })),
            ];
            if (
              dynDecls.some((d) => d.propPath.includes('.') || !CSS_PROPERTY_RE.test(d.propPath))
            ) {
              noteSkipped('unsupported conditional dynamic value; left untouched');
              condFailed = true;
              break;
            }
            // promotion: 単発は inline スプレッドのままにする (inline は specificity で勝つため無条件側と競合しない)。
            const condPromoted: typeof dynDecls = [];
            const condInlineSpreads: string[] = [];
            for (const d of part.dynamics) {
              if (shouldPromoteSingle(d.propPath)) {
                condPromoted.push({
                  propPath: d.propPath,
                  segments: [{ kind: 'expr', expr: d.exprSource }] as const,
                });
              } else {
                condInlineSpreads.push(`'${d.propPath}': ${d.exprSource}`);
              }
            }
            for (const c of part.compounds) {
              if (shouldPromoteCompound(c.propPath, c.segments)) {
                condPromoted.push({ propPath: c.propPath, segments: c.segments });
              } else {
                condInlineSpreads.push(`'${c.propPath}': ${inlineCompoundValue(c.segments)}`);
              }
            }
            // 同一 part 内の static/promoted 同一 property は順序保証できない。
            const staticPropSet = new Set<string>(staticAtoms.map((a) => a.property));
            if (
              condPromoted.some((d) => staticPropSet.has(canonicalProperty(d.propPath)))
            ) {
              noteSkipped('conflicting conditional declarations; left untouched');
              condFailed = true;
              break;
            }
            const built = buildParametrics(condPromoted);
            if (built === null) {
              noteSkipped('cannot lower conditional dynamic value; left untouched');
              condFailed = true;
              break;
            }
            const seenParam = new Map<string, string>();
            let dupStructure = false;
            for (const b of built) {
              const prev: string | undefined = seenParam.get(b.prop);
              if (prev !== undefined && prev !== b.id) {
                noteSkipped('conflicting parametric structures; left untouched');
                dupStructure = true;
                break;
              }
              seenParam.set(b.prop, b.id);
            }
            if (dupStructure) {
              condFailed = true;
              break;
            }
            const spreads: string[] = [
              ...condInlineSpreads,
              ...built.flatMap((b) =>
                b.slotIds.map((slotId, k) => `'${slotId}': ${b.slotExprs[k] ?? ''}`),
              ),
            ];
            condGroups.push({
              cond,
              staticAtoms,
              members: [
                ...staticAtoms.map((a) => ({
                  atomId: hashStaticAtom(a),
                  context: a.context,
                  decl: serializeStaticDecl(a),
                })),
                ...built.map((b) => ({
                  atomId: b.id,
                  context: b.context,
                  decl: b.decl,
                })),
              ],
              spreads,
              dynProps: [...seenParam.keys()],
            });
          }
          if (condFailed) continue;
          const condSegments: string[] = [];
          const condSpreadEntries: string[] = [];
          for (const group of condGroups) {
            // 条件付き group も 1 unit 1 class に merge する (§38)。
            const groupId: string = unitIdOf(group.members.map((m) => m.atomId));
            condUnitIds.add(groupId);
            condSegments.push(`(${group.cond} ? ${JSON.stringify(groupId)} : "")`);
            if (group.spreads.length > 0) {
              condSpreadEntries.push(`...(${group.cond} && {${group.spreads.join(', ')}})`);
            }
          }
          // 有限静的 ternary 値 (DYN-016)。条件付き handle・entry parametric・
          // 条件付き dynamic との競合も拒否する。
          const takenProps = new Set<string>([
            ...composed.atoms.map((a) => (a as StaticAtom).property),
            ...dynamics.map((d) => canonicalProperty(d.propPath)),
            ...compounds.map((c) => canonicalProperty(c.propPath)),
            ...condGroups.flatMap((group) => [
              ...group.staticAtoms.map((a) => a.property),
              ...group.dynProps,
            ]),
            ...entryPropAtom.keys(),
          ]);
          const conditional = buildConditional(conditionals, takenProps);
          if (conditional === null) {
            noteSkipped('conflicting conditional value; left untouched');
            continue;
          }
          // 無条件適用分 (static + promoted parametric + entry parametric) は
          // 1 unit 1 class に merge する (§38)。
          const staticMembers: UnitMember[] = [
            ...(composed.atoms as StaticAtom[]).map((a) => ({
              atomId: hashStaticAtom(a),
              context: a.context,
              decl: serializeStaticDecl(a),
            })),
            ...ingestParametrics(parametrics),
            ...entryMembers,
          ];
          const staticUnitIds: string[] =
            staticMembers.length > 0 ? [unitIdOf(staticMembers.map((m) => m.atomId))] : [];
          const ids: string[] = staticUnitIds;
          const slotEntries: string = parametrics
            .flatMap((p) => p.slotIds.map((slotId, k) => `'${slotId}': ${p.slotExprs[k] ?? ''}`))
            .join(', ');
          const combinedEntries: string = [
            inlineEntries.join(', '),
            slotEntries,
            entrySlotEntries.join(', '),
            condSpreadEntries.join(', '),
          ]
            .filter((e) => e !== '')
            .join(', ');
          const styleEntries: string | null = combinedEntries === '' ? null : combinedEntries;
          const next: boolean = recordTagEdit(
            edits,
            occ.start,
            occ.exprClose,
            ids,
            styleEntries,
            [...condSegments, ...conditional.segments],
          );
          if (!next) {
            continue;
          }
          if (staticUnitIds.length > 0) {
            ingestUnit(staticUnitIds[0] as string, staticMembers);
          }
          for (const group of condGroups) {
            ingestUnit(unitIdOf(group.members.map((m) => m.atomId)), group.members);
          }
          // 独立 ternary 分岐は単一 atom unit のまま (同時適用されないため merge しない)。
          for (const atom of conditional.atoms) {
            const atomId: string = hashStaticAtom(atom);
            const condAtomUnitId: string = unitIdOf([atomId]);
            condUnitIds.add(condAtomUnitId);
            ingestUnit(condAtomUnitId, [
              { atomId, context: atom.context, decl: serializeStaticDecl(atom) },
            ]);
          }
        }
      }
      if (skippedReasons.length > 0) {
        console.warn(
          `[qstyle] ${id}: left ${skippedReasons.length} css occurrence(s) untouched (${skippedReasons[0]}${skippedReasons.length > 1 ? ', ...' : ''})`,
        );
      }
      if (edits.length === 0) return null;
      // dev: per-module CSS を virtual css に出す (評価・再配列なし。そのまま適用)。
      // pack import は付けず、graph 収集は prod と共通のままにする。
      if (isDev) {
        const atoms: string[] = moduleToAtoms.get(id) ?? [];
        // moduleToAtoms は後方から積むため reverse で source order に戻す。
        const css: string = [...atoms]
          .reverse()
          .map((atomId) => collected.get(atomId)?.cssText ?? '')
          .join('');
        devCss.set(id, css);
        const key: string = devKeyFor(id);
        devKeys.set(key, id);
        devTransformed.add(id);
        edits.push({
          start: 0,
          end: 0,
          newText: `import "virtual:qstyle/dev/${key}";\n`,
          srcLine: 0,
        });
        const devApplied = applyEditsWithMap(code, id, edits);
        return { code: devApplied.code, map: devApplied.map };
      }
      // prod: module の全 unit を配信へ繋ぐ。backend で経路が分かれる (§3.4 R1.1)。
      const packUnitIds: string[] = moduleToAtoms.get(id) ?? [];
      if (packUnitIds.length > 0) {
        if (backend === 'css-asset') {
          // §3.4 R1.6 案 B: vite/qwik の CSS 配管に乗せず、module 先頭に client helper 呼び出し
          // を注入する。transform 時点では chunk fileName (content hash) が確定しないため JS 側に
          // 埋め込むのは unit id のみで、unit id → fileName は qstyle.units.json を client が
          // fetch して解決する。JS bundle の hash 完全性を守るため chunk.code の後付け編集はしない。
          edits.push({
            start: 0,
            end: 0,
            newText:
              `import { ensureModuleStyles } from '@qstyle/qwik/client';\n` +
              `ensureModuleStyles(${JSON.stringify(packUnitIds)});\n`,
            srcLine: 0,
          });
        } else {
          // qwik-native: module の全 unit を 1 pack (実 CSS module) にする。import graph 経由で
          // vite/qwik が bundle 単位の css asset を出すため、lazy bundle は直前読み込みに
          // なる (plan.md §48)。pack id は unit set の hash で決定論的に。
          const packId: string = chunkHash([...packUnitIds].sort().join(','));
          modulePacks.set(id, packId);
          if (!packCss.has(packId)) {
            packCss.set(
              packId,
              [...packUnitIds].sort().map((unitId) => collected.get(unitId)?.cssText ?? '').join(''),
            );
          }
          edits.push({
            start: 0,
            end: 0,
            newText: `import "virtual:qstyle/pack/${packId}.css";\n`,
            srcLine: 0,
          });
        }
      }
      const applied = applyEditsWithMap(code, id, edits);
      return { code: applied.code, map: applied.map };
    },

    generateBundle(): void {
      const manifest: Record<string, string[]> = {};
      for (const [mod, atoms] of moduleToAtoms) {
        manifest[mod] = atoms;
      }
      // backend 'css-asset': chunk plan を asset 化し (§3.4 R1.2)、CSS asset 自体は
      // `qstyle:css-asset` plugin が直接 emit する (vite/qwik の CSS 配管に乗せない。
      // build.cssCodeSplit 強制と無関係になる)。ここでは manifest 生成のための
      // unit → fileName 逆引きのみ使う。
      // backend 'qwik-native': CSS asset は pack css module の import graph 経由で
      // vite/qwik が出す (§48。lazy bundle は css も直前読み込み)。ここでは metadata
      // (chunk plan) のみ記録し、直接 emit しない。
      const assetPlan: CssAssetPlan | null = backend === 'css-asset' ? buildCssAssetPlan() : null;
      const chunkPlans: readonly (ChunkPlan | CssAssetChunk)[] =
        assetPlan !== null
          ? assetPlan.chunks.map(({ cssText: _cssText, ...meta }) => meta)
          : planChunks(
              graph,
              [...collected.values()].map((s) => ({ id: s.id, bytes: s.cssText.length })),
              chunkOptions,
            );
      // route -> modules の逆引きを unit list へ解決する。
      // css-asset 時はさらに unit → 所属 chunk の fileName へ解決する (§3.4 R1.3)。
      const routeToAssets = new Map<string, readonly string[]>();
      for (const route of Object.keys(options.routes ?? {})) {
        const assets = new Set<string>();
        for (const modulePath of options.routes?.[route] ?? []) {
          const key: string = moduleKey(modulePath);
          for (const [mod, atoms] of moduleToAtoms) {
            if (moduleKey(mod) === key) {
              for (const atom of atoms) assets.add(atom);
            }
          }
        }
        if (assetPlan !== null) {
          const files = new Set<string>();
          for (const unitId of assets) {
            const fileName: string | undefined = assetPlan.unitToFile.get(unitId);
            if (fileName !== undefined) files.add(fileName);
          }
          routeToAssets.set(route, [...files]);
        } else {
          routeToAssets.set(route, [...assets]);
        }
      }
      const styleManifest: StyleManifest = buildRouteManifest(routeToAssets, {
        compilerVersion: VERSION,
      });
      const ctx = this as unknown as { emitFile: (f: { type: 'asset'; fileName: string; source: string }) => void };
      ctx.emitFile({
        type: 'asset',
        fileName: 'qstyle.routes.json',
        source: serializeManifest(styleManifest),
      });
      ctx.emitFile({
        type: 'asset',
        fileName: 'qstyle-manifest.json',
        source: JSON.stringify(
          {
            version: 0,
            optimization,
            backend,
            manifest,
            packs: [...collected.values()],
            modulePacks: [...modulePacks.entries()],
            chunkPlans,
            legacy: legacyStyles,
          },
          null,
          2,
        ),
      });
    },
  };

  /**
   * §39 dedup (decl 単位の統合)。vite:css / qwik の css asset 出力後に走る
   * post plugin で、最終 css asset の `.q_*` unit rule を安全にグループ化する。
   * 解析に失敗した場合は元のテキストをそのまま保持する (correctness first)。
   *
   * plugin 間の実行順依存 (§3.4 R1.1): 本 plugin は vite 配管由来の CSS にのみ適用する。
   * css-asset backend の出力 (assets/qstyle.<hash>.css) は emit 前 (hash 計算前) に
   * chunk 内 dedup 済みのため、出力後に再適用すると bytes が hash と乖離する。
   * この配列では dedup が css-asset emit の前に走るが、順序に依存しないよう
   * fileName で明示的に除外する。
   */
  const dedupPlugin: Plugin = {
    name: 'qstyle:dedup',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const meta = {
        unitTags: unitTagNames as ReadonlyMap<string, ReadonlySet<string>>,
        condUnitIds: condUnitIds as ReadonlySet<string>,
      };
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.css')) continue;
        if (file.fileName.startsWith('assets/qstyle.')) continue;
        const source: unknown = file.source;
        if (typeof source !== 'string') continue;
        try {
          file.source = groupDuplicateCss(source, meta);
        } catch {
          // 解析エラー時は元の CSS を保持する
        }
      }
    },
  };

  /**
   * Backend B (css-asset) の asset emitter (plan.md §3.2/§3.4 R1.1-R1.3)。
   * vite/qwik の CSS バンドル配管に一切乗せず、chunk planner が決定した chunk 単位で
   * `this.emitFile({type:'asset'})` により CSS asset を直接出す:
   * - `cssCodeSplit` 強制 (qwik optimizer) と無関係 (JS 側に CSS import が存在しない)
   * - 粒度・内容・fileName を planner が完全制御。hash は §39 v1 dedup 適用後の
   *   最終 bytes から計算する
   * - unit id → fileName の逆引き index を `qstyle.units.json` として出し、
   * `@qstyle/qwik/client` の ensureModuleStyles が実行時解決に使う (R1.6 案 B)
   * build のみ (apply: 'build')。route manifest の asset 名解決は main plugin の
   * generateBundle (enforce 'pre' なので先に走る) が同一の buildCssAssetPlan で行う。
   */
  const cssAssetPlugin: Plugin & {
    readonly __chunkPlans: readonly CssAssetChunk[];
  } = {
    name: 'qstyle:css-asset',
    enforce: 'post',
    apply: 'build',
    /** 直近の build で emit した chunk plan (inspector 表示用。§3.4 R1.8)。 */
    get __chunkPlans(): readonly CssAssetChunk[] {
      return cssAssetPlanCache?.chunks ?? [];
    },
    generateBundle(): void {
      if (backend !== 'css-asset') return;
      const plan: CssAssetPlan = buildCssAssetPlan();
      const ctx = this as unknown as { emitFile: (f: { type: 'asset'; fileName: string; source: string }) => void };
      for (const chunk of plan.chunks) {
        ctx.emitFile({
          type: 'asset',
          fileName: chunk.fileName,
          source: chunk.cssText,
        });
        log(`css-asset chunk ${chunk.id} -> ${chunk.fileName} (${chunk.members.length} units)`);
      }
      // unit id → fileName index (R1.6 案 B)。key は sort して決定性を保つ。
      const units: Record<string, readonly string[]> = {};
      for (const unitId of [...plan.unitToFile.keys()].sort()) {
        units[unitId] = [plan.unitToFile.get(unitId) ?? ''];
      }
      ctx.emitFile({
        type: 'asset',
        fileName: 'qstyle.units.json',
        source: JSON.stringify({ version: 1, units }, null, 2),
      });
    },
  };

  return [mainPlugin, dedupPlugin, cssAssetPlugin];
}

export default qstyle;
