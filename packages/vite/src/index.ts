import type { Plugin, ResolvedConfig } from 'vite';
import { hashStaticAtom } from '@qstyle/core';
import type { StaticAtom } from '@qstyle/core';
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

/**
 * style object literal の最小安全パーサ (plan.md §20, M2)。
 * string (escape 対応) / number / true/false/null / nested plain object /
 * trailing comma のみ受理し、それ以外 (spread, identifier 値, function,
 * template, comment) に遭遇したら null を返す。eval は使わない。
 */
export function parseStyleObjectLiteral(src: string): Record<string, unknown> | null {
  const parser: { index: number } = { index: 0 };

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

  function parseValue(): unknown {
    skipWs();
    const ch: string | undefined = src[parser.index];
    if (ch === '{') return parseObject();
    if (ch === '"' || ch === "'") return parseString();
    if (ch === '-' || ch === '.' || (ch !== undefined && ch >= '0' && ch <= '9')) {
      return parseNumber();
    }
    for (const [word, val] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (src.startsWith(word, parser.index)) {
        parser.index += word.length;
        return val;
      }
    }
    return undefined;
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

  function parseObject(): Record<string, unknown> | null {
    // parser.index は '{' を指す。
    parser.index += 1;
    const obj: Record<string, unknown> = {};
    skipWs();
    if (src[parser.index] === '}') {
      parser.index += 1;
      return obj;
    }
    for (;;) {
      const key: string | null = parseKey();
      if (key === null) return null;
      skipWs();
      if (src[parser.index] !== ':') return null;
      parser.index += 1;
      const value: unknown = parseValue();
      if (value === undefined) return null;
      obj[key] = value;
      skipWs();
      const sep: string | undefined = src[parser.index];
      if (sep === ',') {
        parser.index += 1;
        skipWs();
        if (src[parser.index] === '}') {
          parser.index += 1;
          return obj;
        }
        continue;
      }
      if (sep === '}') {
        parser.index += 1;
        return obj;
      }
      return null;
    }
  }

  const root: Record<string, unknown> | null = parseObject();
  if (root === null) return null;
  skipWs();
  if (parser.index !== src.length) return null;
  return root;
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
 *   residual が残るもの・parse 不能なものは触らない (correctness first)。
 * - generateBundle: Route Style Manifest の雛形を emit
 */
export function qstyle(options: QstyleOptions = {}): Plugin {
  const optimization: OptimizationLevel = options.optimization ?? 'safe';
  const backend: BackendKind = options.backend ?? 'qwik-native';
  const debug = options.debug ?? false;

  const collected = new Map<string, CollectedStyle>();
  const moduleToAtoms = new Map<string, string[]>();

  const log = (...args: readonly unknown[]): void => {
    if (debug) {
      console.log('[qstyle]', ...args);
    }
  };

  return {
    name: 'qstyle',
    enforce: 'pre',

    configResolved(config: ResolvedConfig): void {
      log(`optimization=${optimization} backend=${backend} mode=${config.mode}`);
    },

    buildStart(): void {
      collected.clear();
      moduleToAtoms.clear();
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
        const parsed: Record<string, unknown> | null = parseStyleObjectLiteral(literal);
        if (parsed === null) continue;
        // parser 出力は string/number/boolean/null/plain object のみであり
        // StyleObject の実行時サブセットである (関数は生成され得ない)。
        const lowered = lowerStyleObject(parsed as unknown as StyleObject, {
          source: provenanceSource,
        });
        if (lowered.residuals.length > 0) continue;
        if (lowered.diagnostics.some((d) => d.severity === 'error')) continue;
        if (lowered.atoms.length === 0) continue;
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
          if (!seen.has(atomId)) {
            seen.add(atomId);
            newAtomIds.push(atomId);
          }
          log(`collected ${atomId} from ${id}`);
        }
        // 同一タグ内の既存 class="..." に追記する (なければ新規付与)。
        const tagStart: number = rewritten.lastIndexOf('<', occ.start);
        const tagHead: string = rewritten.slice(tagStart < 0 ? 0 : tagStart, occ.start);
        const classMatch: RegExpMatchArray | null = /class\s*=\s*(["'])(.*?)\1/.exec(tagHead);
        if (classMatch !== null) {
          const quote: string = classMatch[1] as string;
          const merged: string = `${classMatch[2]} ${ids.join(' ')}`.trim();
          const classAbsStart: number =
            (tagStart < 0 ? 0 : tagStart) + (classMatch.index ?? 0);
          rewritten =
            rewritten.slice(0, classAbsStart) +
            `class=${quote}${merged}${quote}` +
            rewritten.slice(classAbsStart + classMatch[0].length, occ.start) +
            rewritten.slice(occ.exprClose);
        } else {
          rewritten =
            rewritten.slice(0, occ.start) +
            `class="${ids.join(' ')}"` +
            rewritten.slice(occ.exprClose);
        }
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
          },
          null,
          2,
        ),
      });
    },
  };
}

export default qstyle;
