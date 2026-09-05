import type { Plugin, ResolvedConfig } from 'vite';
import {
  DEFAULT_CHUNK_OPTIONS,
  VERSION,
  assetFileName,
  buildRouteManifest,
  chunkHash,
  createParametricAtom,
  createUsageGraph,
  hashParametricAtom,
  hashStaticAtom,
  planChunks,
  recordComponentRoute,
  recordUsage,
  serializeManifest,
  serializeParametricCss,
} from '@qstyle/core';
import type {
  ChunkInput,
  ChunkOptions,
  ChunkPlan,
  ParametricAtom,
  RuntimeSlotNode,
  StaticAtom,
  StyleManifest,
  UsageGraph,
} from '@qstyle/core';
import { lowerStyleObject } from '@qstyle/qwik';
import type { StyleObject } from '@qstyle/qwik';

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
}

const VIRTUAL_PREFIX = 'virtual:qstyle/';
const RESOLVED_PREFIX = '\0virtual:qstyle/';

function resolveQstyleId(id: string): string | null {
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

export interface ParsedStyleLiteral {
  /** 静的に解決できた宣言のみを含む record (動的な key は除外)。 */
  readonly record: Record<string, unknown>;
  readonly dynamics: readonly DynamicStyleValue[];
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
    if (withDynamics) {
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
  return { record: root.obj, dynamics };
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
  const decl: string = `${atom.property}:${atom.value}${atom.important ? '!important' : ''}`;
  const pseudos: readonly string[] = atom.context.pseudo ?? [];
  let rule: string = `.${className}${pseudos.join('')}{${decl}}`;
  if (atom.context.supports !== undefined) {
    rule = `@supports ${atom.context.supports}{${rule}}`;
  }
  if (atom.context.container !== undefined) {
    rule = `@container ${atom.context.container}{${rule}}`;
  }
  if (atom.context.media !== undefined) {
    rule = `@media ${atom.context.media}{${rule}}`;
  }
  return rule;
}

/**
 * `open` (=`{` の offset) に対応する閉じ `}` の offset を返す。
 * 文字列・escape を考慮し、backtick・comment を含むものは安全に数えられないため -1。
 */
function findMatchingBrace(code: string, open: number): number {
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
    if (ch === '`' || (ch === '/' && (code[i + 1] === '/' || code[i + 1] === '*'))) {
      return -1;
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
 * 文字列・escape を考慮し、backtick・comment を含む箇所は除外する。
 */
function findCssPropOccurrences(code: string): CssPropOccurrence[] {
  const out: CssPropOccurrence[] = [];
  const marker = 'css={{';
  let from = 0;
  for (;;) {
    const start: number = code.indexOf(marker, from);
    if (start < 0) break;
    const braceOpen: number = start + 'css={'.length;
    let depth = 0;
    let i: number = braceOpen;
    let quote: string | null = null;
    let bad = false;
    let braceClose = -1;
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
      if (ch === '`' || (ch === '/' && (code[i + 1] === '/' || code[i + 1] === '*'))) {
        bad = true;
        break;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          braceClose = i;
          break;
        }
      }
      i += 1;
    }
    if (!bad && braceClose > 0 && code[braceClose + 1] === '}') {
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

/**
 * qstyle Vite plugin — Milestone 2 object-syntax lowering (plan.md §89)。
 * - virtual modules: registry / pack/<id> / manifest
 * - transform: .tsx/.jsx 内の css={{ ... }} を balanced-brace scan で抽出し、
 *   安全に parse できる object literal のみ @qstyle/qwik の lowerStyleObject
 *   で atom 化→hash→ class へ rewrite し、モジュール先頭へ side-effect
 *   import "virtual:qstyle/pack/HASH" を注入する。既存 class 属性があれば追記。
 *   M5c: identifier / member chain の値は ParametricAtom (slot var) 化し、
 *   class へ追記した上で既存/新規 style prop へ代入を merge する。
 *   residual が残るもの・parse 不能なものは触らない (correctness first)。
 * - generateBundle: Route Style Manifest の雛形を emit
 */
export function qstyle(options: QstyleOptions = {}): Plugin {
  const optimization: OptimizationLevel = options.optimization ?? 'safe';
  const backend: BackendKind = options.backend ?? 'qwik-native';
  const debug = options.debug ?? false;

  const collected = new Map<string, CollectedStyle>();
  const moduleToAtoms = new Map<string, string[]>();
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

  return {
    name: 'qstyle',
    enforce: 'pre',

    configResolved(config: ResolvedConfig): void {
      // §45: route -> module の逆引きを usage graph へ張る (routes option がなければ何もしない)。
      wireRoutes(graph);
      log(`optimization=${optimization} backend=${backend} mode=${config.mode}`);
    },

    buildStart(): void {
      collected.clear();
      moduleToAtoms.clear();
      graph = createUsageGraph();
      wireRoutes(graph);
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
      if (path.startsWith('pack/')) {
        const packId = path.slice('pack/'.length);
        const style = collected.get(packId);
        if (!style) return `export default ${JSON.stringify('')};\n`;
        // side-effect import だけでも CSS 文字列が bundle に残るよう、
        // export に加えて globalThis への代入 (side effect) を emit する。
        const cssJson: string = JSON.stringify(style.cssText);
        const idJson: string = JSON.stringify(packId);
        return (
          `globalThis.__qstyle_packs ??= {};\n` +
          `globalThis.__qstyle_packs[${idJson}] = ${cssJson};\n` +
          `export default ${cssJson};\n`
        );
      }
      return null;
    },

    transform(code: string, id: string): { code: string; map: null } | null {
      if (!id.endsWith('.tsx') && !id.endsWith('.jsx')) return null;
      if (!code.includes('css')) return null;
      // css={{ ... }} を balanced-brace scan で抽出し、安全に parse できる
      // object literal のみ lowering する。residual が残るもの・parse 不能な
      // ものは触らない (correctness first, plan.md §15)。
      const occurrences: CssPropOccurrence[] = findCssPropOccurrences(code);
      if (occurrences.length === 0) return null;
      const provenanceSource: string = id;
      const newAtomIds: string[] = [];
      const seen = new Set<string>();
      let rewritten: string = code;
      // 後方から置換して offset ずれを避ける。
      for (let k: number = occurrences.length - 1; k >= 0; k -= 1) {
        const occ: CssPropOccurrence = occurrences[k] as CssPropOccurrence;
        const literal: string = code.slice(occ.braceOpen, occ.braceClose);
        const parsed: ParsedStyleLiteral | null = parseStyleObjectLiteralWithDynamics(literal);
        if (parsed === null) continue;
        const { record, dynamics } = parsed;
        // 動的な値は top-level property のみ対応する。nested (dotted propPath)
        // は context 付き slot を生成できないため untouched (correctness first)。
        if (dynamics.some((d) => d.propPath.includes('.'))) continue;
        if (dynamics.some((d) => !CSS_PROPERTY_RE.test(d.propPath))) continue;
        // 静的宣言のみ lowering する。parser 出力は string/number/boolean/null/
        // plain object のみであり StyleObject の実行時サブセットである。
        const lowered = lowerStyleObject(record as unknown as StyleObject, {
          source: provenanceSource,
        });
        if (lowered.residuals.length > 0) continue;
        if (lowered.diagnostics.some((d) => d.severity === 'error')) continue;
        if (lowered.atoms.length === 0 && dynamics.length === 0) continue;
        // 動的宣言 (1 property = 1 slot) を ParametricAtom 化する。
        // var 名は生成された slot id のみから取る (SEC-005: source 由来の
        // 識別子を style key に使わない)。expr は style value のみに保持。
        const parametrics: { id: string; slotId: string; cssText: string }[] = [];
        for (const dyn of dynamics) {
          const atom: ParametricAtom = createParametricAtom({
            property: dyn.propPath,
            parts: [{ kind: 'slot', slotIndex: 0 }],
            slots: [{ valueType: 'custom' }],
            provenance: [{ source: provenanceSource, line: 1, column: 1 }],
          });
          const slot: RuntimeSlotNode | undefined = atom.slots[0];
          if (slot === undefined) break;
          const paramId: string = hashParametricAtom(atom);
          parametrics.push({
            id: paramId,
            slotId: slot.id,
            cssText: serializeParametricCss(atom, paramId),
          });
        }
        if (parametrics.length !== dynamics.length) continue;
        // 書き換え対象タグの head (tag 先頭 〜 css prop 直前) を取り出す。
        const tagStart: number = Math.max(rewritten.lastIndexOf('<', occ.start), 0);
        const head: string = rewritten.slice(tagStart, occ.start);
        const tail: string = rewritten.slice(occ.exprClose);
        // 既存 style prop があれば slot var の代入をその閉じ `}` 直前に merge
        // し、なければ class 属性の直後に style prop を新規付与する。
        const styleMatch: RegExpMatchArray | null =
          parametrics.length > 0 ? /style\s*=\s*\{\{/.exec(head) : null;
        let styleObjOpen = -1;
        let styleObjClose = -1;
        if (styleMatch !== null) {
          styleObjOpen = (styleMatch.index ?? 0) + styleMatch[0].length - 1;
          styleObjClose = findMatchingBrace(head, styleObjOpen);
          // 閉じ `}` を安全に決められない style prop は触らない。
          if (styleObjClose < 0) continue;
        }
        const styleEntries: string = parametrics
          .map((p, i) => `'${p.slotId}': ${dynamics[i]?.exprSource ?? ''}`)
          .join(', ');
        let head2: string = head;
        if (styleObjClose >= 0) {
          // 閉じ `}` の直前 (既存宣言の後) へ slot var の代入を追加する。
          // 末尾の trailing comma / 空白は撒き直して `,,` を作らない。
          const inner: string = head.slice(styleObjOpen + 1, styleObjClose);
          const kept: string = inner.replace(/[\s,]+$/, '');
          const insertAt: number = styleObjOpen + 1 + kept.length;
          const sep: string = kept.length > 0 ? ', ' : '';
          head2 =
            head.slice(0, insertAt) + `${sep}${styleEntries}` + head.slice(insertAt);
        }
        // 同一タグ内の既存 class="..." に追記する (なければ新規付与)。
        const classMatch: RegExpMatchArray | null = /class\s*=\s*(["'])(.*?)\1/.exec(head2);
        const ids: string[] = [];
        for (const srcAtom of lowered.atoms) {
          const atomId: string = hashStaticAtom(srcAtom);
          ids.push(atomId);
          if (!collected.has(atomId)) {
            collected.set(atomId, {
              id: atomId,
              cssText: serializeAtomCss(srcAtom, atomId),
              sourceId: id,
            });
          }
          const list: string[] = moduleToAtoms.get(id) ?? [];
          if (!list.includes(atomId)) {
            moduleToAtoms.set(id, [...list, atomId]);
          }
          // §38: usage graph へ style -> component (module) の edge を記録する (冪等)。
          recordUsage(graph, atomId, moduleKey(id));
          if (!seen.has(atomId)) {
            seen.add(atomId);
            newAtomIds.push(atomId);
          }
          log(`collected ${atomId} from ${id}`);
        }
        for (const param of parametrics) {
          ids.push(param.id);
          if (!collected.has(param.id)) {
            collected.set(param.id, {
              id: param.id,
              cssText: param.cssText,
              sourceId: id,
            });
          }
          const list: string[] = moduleToAtoms.get(id) ?? [];
          if (!list.includes(param.id)) {
            moduleToAtoms.set(id, [...list, param.id]);
          }
          // §38: parametric も usage graph へ記録する (static と同様、冪等)。
          recordUsage(graph, param.id, moduleKey(id));
          if (!seen.has(param.id)) {
            seen.add(param.id);
            newAtomIds.push(param.id);
          }
          log(`collected ${param.id} (parametric) from ${id}`);
        }
        let newHead: string;
        if (classMatch !== null) {
          const quote: string = classMatch[1] as string;
          const classStart: number = classMatch.index ?? 0;
          const attr: string = `class=${quote}${`${classMatch[2]} ${ids.join(' ')}`.trim()}${quote}`;
          newHead =
            head2.slice(0, classStart) + attr + head2.slice(classStart + classMatch[0].length);
          if (styleMatch === null) {
            newHead =
              newHead.slice(0, classStart + attr.length) +
              ` style={{ ${styleEntries} }}` +
              newHead.slice(classStart + attr.length);
          }
        } else {
          newHead =
            `${head2}class="${ids.join(' ')}"` +
            (styleMatch === null ? ` style={{ ${styleEntries} }}` : '');
        }
        rewritten = rewritten.slice(0, tagStart) + newHead + tail;
      }
      if (newAtomIds.length === 0) return null;
      const header: string = newAtomIds
        .map((atomId: string): string => `import "virtual:qstyle/pack/${atomId}";`)
        .join('\n');
      return { code: `${header}\n${rewritten}`, map: null };
    },

    generateBundle(): void {
      const manifest: Record<string, string[]> = {};
      for (const [mod, atoms] of moduleToAtoms) {
        manifest[mod] = atoms;
      }
      const styles: ChunkInput[] = [...collected.values()].map((s) => ({
        id: s.id,
        bytes: s.cssText.length,
      }));
      const chunkPlans: ChunkPlan[] = planChunks(graph, styles, chunkOptions);
      for (const plan of chunkPlans) {
        const cssText: string = plan.members
          .map((member) => collected.get(member)?.cssText ?? '')
          .join('');
        const hash: string = chunkHash(cssText);
        this.emitFile({
          type: 'asset',
          fileName: assetFileName('style', hash),
          source: cssText,
        });
      }
      // route -> modules の逆引きを asset list へ解決する。
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
        routeToAssets.set(route, [...assets]);
      }
      const styleManifest: StyleManifest = buildRouteManifest(routeToAssets, {
        compilerVersion: VERSION,
      });
      this.emitFile({
        type: 'asset',
        fileName: 'qstyle.routes.json',
        source: serializeManifest(styleManifest),
      });
      this.emitFile({
        type: 'asset',
        fileName: 'qstyle-manifest.json',
        source: JSON.stringify(
          {
            version: 0,
            optimization,
            backend,
            manifest,
            packs: [...collected.values()],
            chunkPlans,
          },
          null,
          2,
        ),
      });
    },
  };
}

export default qstyle;
