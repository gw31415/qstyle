// UnoCSS generate() → StaticAtom 変換 + verbatim fallback (docs/unocss.md §2)。
// engine (user config 駆動) を内蔵し、完全置換する: atom 化できた rule は atoms へ、
// できない rule は原文のまま verbatim へ。どちらも qstyle asset として emit するため
// `@unocss/vite` の build 時出力は不要になる。値の焼き込みは一切しない
// (var 参照・media 長は engine 出力のまま。theme 定義は globals に同梱する)。
import { createGenerator } from 'unocss';
import type { UnoGenerator, UserConfig } from 'unocss';
import { loadConfig } from '@unocss/config';
import {
  canonicalProperty,
  canonicalValue,
  classifyDeclaration,
  createStaticAtom,
  longhandsOf,
} from '@qstyle/core';
import type { RuleContext, StaticAtom } from '@qstyle/core';
import { parseCssRules } from './parse.js';
import type { CssWrapper, RawRule } from './parse.js';

export interface UnoGlobals {
  readonly theme: string;
  readonly properties: string;
  readonly base: string;
  readonly keyframes: string;
}

export interface UnoResolveResult {
  /** 1 要素分・競合解決済み・unocss 出力順の atoms。verbatim 時は空。 */
  readonly atoms: readonly StaticAtom[];
  /**
   * atom 化不能だった matched token の原文 rules (出力順)。空でなければ
   * 要素全体が verbatim (class は書き換えない)。unocss 出力と同一 cascade。
   */
  readonly verbatimCss: string;
  /** engine に未知の token (入力順)。CSS はどこにも無いため残してよい。 */
  readonly unmatched: readonly string[];
  /** theme / properties / base / keyframes 層 (global asset 用)。 */
  readonly globals: UnoGlobals;
}

export interface UnoResolver {
  resolve(tokens: readonly string[], opts?: ResolveOptions): Promise<UnoResolveResult>;
}

export interface ResolveOptions {
  /**
   * true の場合 atom 化せず、matched token の原文 rules をすべて verbatim で
   * 返す (関連付け先の要素が無いリテラル走査用)。
   */
  readonly verbatimOnly?: boolean | undefined;
  /**
   * verbatim CSS の selector 書き換え表 (token → 短縮 alias)。
   * 削減モードで JS 側の token を alias に置換した場合に渡す。
   * matched token の参照のみ書き換え、unmatched (engine 未知・user CSS) は
   * 原文のまま残す。atom 化 path には影響しない。
   */
  readonly aliases?: ReadonlyMap<string, string> | undefined;
}

/** `uno.config.ts` を UnoCSS 自身の loader で読む (`@unocss/vite` と同一意味論)。
 * 文字列は config path、object は inline config (file に merge される) として渡す。 */
export async function loadUnoConfig(
  cwd: string,
  configOrPath?: string | UserConfig,
): Promise<UserConfig> {
  const loaded = await loadConfig(cwd, configOrPath ?? cwd);
  return loaded.config;
}

/** user config から resolver を作る。同一 token 集合は memo 化する。 */
export async function createUnoResolver(config: UserConfig): Promise<UnoResolver> {
  const uno = await createGenerator(config);
  // ponytail: build-lifetime cache。key 空間は source 内の class 文字列に束縛される。
  const memo = new Map<string, Promise<UnoResolveResult>>();
  return {
    resolve(tokens: readonly string[], opts?: ResolveOptions): Promise<UnoResolveResult> {
      const unique: string[] = [...new Set(tokens)].sort();
      // ponytail: aliases は token の純関数 (aliasForUtilityToken) から作るため、
      // 同一 token 集合への適用結果は map 実体によらず同一。key には解決集合に
      // 属する分だけ畳み込む (module 毎の候補集合の違いを吸収する)。
      const aliasDigest: string =
        opts?.aliases === undefined
          ? ''
          : unique.map((t) => opts.aliases?.get(t) ?? '').join('\0');
      const key: string = `${opts?.verbatimOnly === true ? 'v\0' : ''}${aliasDigest}\0${unique.join('\0')}`;
      const hit: Promise<UnoResolveResult> | undefined = memo.get(key);
      if (hit !== undefined) return hit;
      const pending: Promise<UnoResolveResult> = resolveTokens(uno, unique, opts);
      memo.set(key, pending);
      return pending;
    },
  };
}

/** CSS escape (`\:` 等) を外す。hex escape 残りは失敗扱いのため残す。 */
function unescapeClass(raw: string): string {
  return raw.replace(/\\(.)/gs, '$1');
}

/** class 部分の終端を探す。unescaped の `:`・空白・結合子・`[`・`(` で終わる。 */
function splitClassRemainder(selector: string): { cls: string; rest: string } | null {
  if (!selector.startsWith('.')) return null;
  let i = 1;
  let out = '';
  while (i < selector.length) {
    const ch: string = selector[i] ?? '';
    if (ch === '\\') {
      const next: string = selector[i + 1] ?? '';
      if (next === '') return null;
      out += ch + next;
      i += 2;
      continue;
    }
    if (ch === ':' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '>' || ch === '+' || ch === '~' || ch === '[' || ch === '(' || ch === ',') {
      break;
    }
    // 素の `.` / `#` は別 class/id 参照のため不可。
    if (ch === '.' || ch === '#') return null;
    out += ch;
    i += 1;
  }
  return { cls: out, rest: selector.slice(i) };
}

/** pseudo chain (`:hover` / `::before` / `:not(...)` 等) のみか。IR 表現可否は別途。 */
const PSEUDO_CHAIN_RE = /^(?:::?[a-zA-Z][\w-]*(?:\([^().#[\]]*\))?)*$/;

/**
 * selector → { token, pseudos }。祖先結合・属性・別 class 参照は null
 * (RuleContext で表現できないため token を unknown に戻す)。
 */
function selectorToToken(
  selector: string,
  tokenSet: ReadonlySet<string>,
): { token: string; pseudos: readonly string[] } | null {
  const split: { cls: string; rest: string } | null = splitClassRemainder(selector);
  if (split === null || split.cls === '') return null;
  const token: string = unescapeClass(split.cls);
  if (token.includes('\\') || !tokenSet.has(token)) return null;
  if (!PSEUDO_CHAIN_RE.test(split.rest)) return null;
  const pseudos: string[] = [];
  const re = /::?[a-zA-Z][\w-]*(?:\([^().#[\]]*\))?/g;
  let m: RegExpExecArray | null;
  for (;;) {
    m = re.exec(split.rest);
    if (m === null) break;
    pseudos.push(m[0]);
  }
  // 消費残りがあれば複雑 selector (token を verbatim に戻す)。
  if (pseudos.join('') !== split.rest) return null;
  return { token, pseudos };
}

/** v4 `!` important (prefix `!flex` / suffix `flex!`) を除いた比較キー。 */
function normalizeBang(token: string): string {
  if (token.startsWith('!')) return token.slice(1);
  if (token.endsWith('!')) return token.slice(0, -1);
  return token;
}

/**
 * selector 内の全 class 部分を unescape して列挙する。結合子・属性・
 * 疑似をまたいで走査する。読めない箇所があれば null。
 */
function classesInSelector(selector: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < selector.length) {
    const ch: string = selector[i] ?? '';
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // quote 内は class ではない (属性値等)。閉じまで飛ばす。
      const quote: string = ch;
      i += 1;
      let closed = false;
      while (i < selector.length) {
        const c: string = selector[i] ?? '';
        if (c === '\\') i += 2;
        else if (c === quote) {
          closed = true;
          i += 1;
          break;
        } else i += 1;
      }
      if (!closed) return null;
      continue;
    }
    if (ch !== '.') {
      i += 1;
      continue;
    }
    const split: { cls: string; rest: string } | null = splitClassRemainder(
      selector.slice(i),
    );
    if (split === null || split.cls === '') return null;
    const token: string = unescapeClass(split.cls);
    if (token.includes('\\')) return null;
    out.push(token);
    i += 1 + split.cls.length;
  }
  return out;
}

interface VarUse {
  readonly name: string;
  /** `var(--x, ...)` の fallback 有無 (空 fallback を含む)。 */
  readonly hasFallback: boolean;
}

/** 値内の `var()` 参照を列挙する。 */
function varUses(value: string): VarUse[] {
  const out: VarUse[] = [];
  const re = /var\(\s*(--[^\s,)]+)\s*(,)?/g;
  let m: RegExpExecArray | null;
  for (;;) {
    m = re.exec(value);
    if (m === null) break;
    out.push({ name: m[1] as string, hasFallback: m[2] !== undefined });
  }
  return out;
}

/** engine 内部の中間変数 (`--un-*`) か。theme / user 変数ではない。 */
function isUnoVar(name: string): boolean {
  return name.startsWith('--un-');
}

function contextOf(wrappers: readonly CssWrapper[], pseudos: readonly string[]): RuleContext {
  let context: RuleContext = pseudos.length > 0 ? { pseudo: [...pseudos] } : {};
  for (const wrapper of wrappers) {
    if (wrapper.kind === 'media') context = { ...context, media: wrapper.prelude };
    else if (wrapper.kind === 'supports') context = { ...context, supports: wrapper.prelude };
    else if (wrapper.kind === 'container') context = { ...context, container: wrapper.prelude };
    else context = { ...context, layer: wrapper.prelude };
  }
  return context;
}

const IMPORTANT_RE = /\s*!\s*important\s*$/i;

interface TokenWork {
  atoms: StaticAtom[];
  order: number;
  /** verbatim 用の原文 slice (rule 出現順)。 */
  slices: { start: number; end: number }[];
}

function conflictKeyOf(property: string, context: RuleContext, important: boolean): string {
  return JSON.stringify([property, context, important]);
}

/**
 * CSS 仕様上 shorthand だが core の SHORTHAND_MAP に無いもの (比較用のみ)。
 * `inset` / `gap` / `grid-template` / `overflow` の展開が無いと
 * 論理 shorthand との競合を見落とす。
 */
const EXTRA_SHORTHANDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['inset', ['top', 'right', 'bottom', 'left']],
  ['gap', ['row-gap', 'column-gap']],
  ['grid-template', ['grid-template-rows', 'grid-template-columns', 'grid-template-areas']],
  ['overflow', ['overflow-x', 'overflow-y']],
]);

/** 循環 safe な transitive longhand 展開 (自身を含む)。 */
function longhandsStar(property: string, seen: Set<string> = new Set()): Set<string> {
  const out = new Set<string>([property]);
  if (seen.has(property)) return out;
  seen.add(property);
  const direct: readonly string[] = [
    ...longhandsOf(property),
    ...(EXTRA_SHORTHANDS.get(property) ?? []),
  ];
  for (const longhand of direct) {
    out.add(longhand);
    for (const transitive of longhandsStar(longhand, seen)) out.add(transitive);
  }
  return out;
}

/**
 * 論理 property の物理カバレッジ (比較用)。`padding-inline` →
 * `{padding-left, padding-right}`、`inset-inline` → `{left, right}`。
 * 方向依存 (ltr/rtl) は両方含める保守側。
 */
function physicalPeers(property: string): Set<string> {
  const out = new Set<string>();
  if (property === 'inset-inline') {
    out.add('left');
    out.add('right');
    return out;
  }
  if (property === 'inset-block') {
    out.add('top');
    out.add('bottom');
    return out;
  }
  const segments: string[] = property.split('-');
  const variants: string[][] = [[]];
  for (const seg of segments) {
    const options: string[] =
      seg === 'inline-start' || seg === 'inline-end' || seg === 'inline'
        ? ['left', 'right']
        : seg === 'block'
          ? ['top', 'bottom']
          : seg === 'start'
            ? ['left', 'right']
            : seg === 'end'
              ? ['top', 'bottom', 'left', 'right']
              : [seg];
    const next: string[][] = [];
    for (const base of variants) {
      for (const option of options) next.push([...base, option]);
    }
    variants.length = 0;
    variants.push(...next);
  }
  for (const variant of variants) {
    const joined: string = variant.join('-');
    if (joined !== property) out.add(joined);
  }
  return out;
}

/**
 * 2 declarations を独立 emit すると cascade が壊れる可能性があるか
 * (docs/unocss.md §2.8)。同一 longhand を覆う場合のみ true。
 * `mt-2` + `ml-4`、`text-lg` + `leading-6`、`transition-property` +
 * `transition-duration` は独立なので false。
 */
export function orderRiskProperty(pa: string, pb: string): boolean {
  if (pa === pb) return true;
  if (pa.startsWith('--') || pb.startsWith('--')) return false;
  const coverage = (p: string): Set<string> => {
    const set: Set<string> = longhandsStar(p);
    for (const peer of physicalPeers(p)) set.add(peer);
    return set;
  };
  const a: Set<string> = coverage(pa);
  for (const prop of coverage(pb)) {
    if (a.has(prop)) return true;
  }
  return false;
}

/** key 順を正規化した context 比較用 (pseudo / supports 除外)。 */
function restKey(context: RuleContext): string {
  const entries: [string, unknown][] = Object.entries(context)
    .filter(([k]) => k !== 'pseudo' && k !== 'supports')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * 同一 property 群の処理。pseudo の有無のみの違いは詳細度が決めるため保持し、
 * baseline `@supports` の fallback は捨てて enhancement を残す。
 * それ以外の組み合わせは順序を保証できないため null を返す (orderUnsafe)。
 */
function resolveSameProperty(atoms: readonly StaticAtom[]): StaticAtom[] | null {
  const base = atoms[0] as StaticAtom;
  // `!important` 違いは重要度が決めるため順序によらず保持する。
  if (!atoms.every((atom) => atom.important === base.important)) {
    return atoms.every((atom) => restKey(atom.context) === restKey(base.context))
      ? [...atoms]
      : null;
  }
  if (!atoms.every((atom) => restKey(atom.context) === restKey(base.context))) return null;
  const pseudos = atoms.map((atom) => atom.context.pseudo ?? []);
  const supports = atoms.map((atom) =>
    atom.context.supports === undefined ? null : normalizePrelude(atom.context.supports),
  );
  const firstPseudo: readonly string[] = pseudos[0] ?? [];
  const allPseudoEqual: boolean = pseudos.every(
    (p) => p.join(',') === firstPseudo.join(','),
  );
  if (!allPseudoEqual) {
    // pseudo 違い: rest/supports 同一かつ 2 件中 1 件が base のみ safe。
    const allSupportsEqual: boolean = supports.every((s) => s === supports[0]);
    const emptyCount: number = pseudos.filter((p) => p.length === 0).length;
    if (allSupportsEqual && pseudos.length === 2 && emptyCount === 1) return [...atoms];
    return null;
  }
  if (supports.every((s) => s === supports[0])) return [...atoms];
  // pseudo 同一・supports 違い: baseline enhancement のみ残す (fallback は dead code)。
  if (
    supports.length === 2 &&
    supports.includes(null) &&
    supports.some((s) => s !== null && BASELINE_SUPPORTS.has(s))
  ) {
    return atoms.filter((atom) => atom.context.supports !== undefined);
  }
  return null;
}

/** Tailwind v4 baseline で普遍の `@supports` 条件 (fallback 削減用 allowlist)。 */
const BASELINE_SUPPORTS: ReadonlySet<string> = new Set([
  '(color: color-mix(in lab, red, red))',
]);

function normalizePrelude(prelude: string): string {
  return prelude.trim().replace(/\s+/g, ' ');
}

/**
 * 同一 property 群の処理。pseudo の有無のみの違いは詳細度が決めるため保持し、
 * baseline `@supports` の fallback は捨てて enhancement を残す。
 * それ以外の組み合わせは順序を保証できないため false を返す (orderUnsafe)。
 */
function provenanceOf(token: string): [{ source: string; line: number; column: number }] {
  return [{ source: `unocss:${token}`, line: 1, column: 1 }];
}

async function resolveTokens(
  uno: UnoGenerator,
  uniqueTokens: readonly string[],
  opts?: ResolveOptions,
): Promise<UnoResolveResult> {
  const tokenSet = new Set(uniqueTokens);
  const generated = await uno.generate(new Set(uniqueTokens), { preflights: true });

  const unmatched = new Set<string>();
  for (const token of uniqueTokens) {
    if (!generated.matched.has(token)) unmatched.add(token);
  }

  const themeParts: string[] = [];
  const propertiesParts: string[] = [];
  const baseParts: string[] = [];
  const defaultParts: string[] = [];
  for (const name of generated.layers) {
    const text: string | undefined = await generated.getLayer(name);
    if (text === undefined || text.trim() === '') continue;
    if (name === 'theme') themeParts.push(text);
    else if (name === 'properties') propertiesParts.push(text);
    else if (name === 'base') baseParts.push(text);
    else defaultParts.push(text);
  }
  const globals: UnoGlobals = {
    theme: themeParts.join('\n'),
    properties: propertiesParts.join('\n'),
    base: baseParts.join('\n'),
    keyframes: '',
  };

  // `@property` 登録 (initial-value 付きのみが 1-arg read を解決する)。
  // engine 出力由来であり、値の焼き込みではない。
  const registered = new Set<string>();
  const propBlockRe = /@property\s+(--[^\s{]+)\s*\{([^}]*)\}/g;
  let pb: RegExpExecArray | null;
  for (;;) {
    pb = propBlockRe.exec(globals.properties);
    if (pb === null) break;
    if (/initial-value\s*:/.test(pb[2] ?? '')) registered.add(pb[1] as string);
  }

  const defaultText: string = defaultParts.join('\n');
  const rules = parseCssRules(defaultText);

  // opaque (`@keyframes` 等) は常に global へ。token 帰属は不要。
  const keyframesParts: string[] = [];
  const qualified: RawRule[] = [];
  for (const rule of rules) {
    if (rule.opaqueAt !== null) {
      keyframesParts.push(defaultText.slice(rule.start, rule.end));
    } else if (rule.selectors.length > 0) {
      qualified.push(rule);
    }
  }

  const fullGlobals: UnoGlobals = {
    theme: globals.theme,
    properties: globals.properties,
    base: globals.base,
    keyframes: keyframesParts.join('\n'),
  };

  if (opts?.verbatimOnly === true) {
    return {
      atoms: [],
      verbatimCss: assembleVerbatim(qualified, defaultText, tokenSet, unmatched, opts?.aliases),
      unmatched: [...unmatched],
      globals: fullGlobals,
    };
  }

  // token -> work。verbatim token は slices のみ使う。
  const works = new Map<string, TokenWork>();
  // atom 化不能だった matched token。要素全体が verbatim になる。
  const verbatimTokens = new Set<string>();
  let order = 0;

  const workOf = (token: string): TokenWork => {
    const existing: TokenWork | undefined = works.get(token);
    if (existing !== undefined) return existing;
    const work: TokenWork = { atoms: [], order, slices: [] };
    works.set(token, work);
    return work;
  };

  for (const rule of qualified) {
    order += 1;
    // owner attribution: selector 内 class と token 集合の積。
    const owners = new Set<string>();
    let ownerOk = true;
    for (const selector of rule.selectors) {
      const classes: string[] | null = classesInSelector(selector);
      if (classes === null) {
        ownerOk = false;
        break;
      }
      for (const cls of classes) {
        if (tokenSet.has(cls)) owners.add(cls);
      }
    }
    if (!ownerOk || owners.size === 0) continue;
    // 全 selector が同一 token (!-正規化)・同一 pseudo の場合のみ atom 化を試す。
    let convertible: { token: string; pseudos: readonly string[] } | null = null;
    {
      const mapped: { token: string; pseudos: readonly string[] }[] = [];
      let simple = true;
      for (const selector of rule.selectors) {
        const parsed = selectorToToken(selector, tokenSet);
        if (parsed === null) {
          simple = false;
          break;
        }
        mapped.push(parsed);
      }
      if (simple && mapped.length > 0) {
        const first = mapped[0] as { token: string; pseudos: readonly string[] };
        const key: string = normalizeBang(first.token);
        if (
          mapped.every(
            (m) =>
              normalizeBang(m.token) === key &&
              m.pseudos.join(',') === first.pseudos.join(','),
          )
        ) {
          const owner: string | undefined = [...owners].find(
            (t) => normalizeBang(t) === key,
          );
          if (owner !== undefined && !unmatched.has(owner)) {
            convertible = { token: owner, pseudos: first.pseudos };
          }
        }
      }
    }
    if (convertible === null) {
      for (const owner of owners) {
        workOf(owner).slices.push({ start: rule.start, end: rule.end });
        verbatimTokens.add(owner);
      }
      continue;
    }
    const context: RuleContext = contextOf(rule.wrappers, convertible.pseudos);
    const converted: StaticAtom[] | null = convertDecls(
      rule,
      convertible.token,
      context,
      registered,
    );
    if (converted === null || converted.length === 0) {
      // decl 不能・空 rule (nested 等) は verbatim に戻す。黙って落とさない。
      for (const owner of owners) {
        workOf(owner).slices.push({ start: rule.start, end: rule.end });
        verbatimTokens.add(owner);
      }
      continue;
    }
    const work = workOf(convertible.token);
    work.atoms.push(...converted);
    work.slices.push({ start: rule.start, end: rule.end });
  }

  // verbatim token が 1 件でもあれば要素全体が verbatim (原文のまま cascade 完全一致)。
  const needsVerbatim: boolean =
    uniqueTokens.some((t) => !unmatched.has(t) && verbatimTokens.has(t)) ||
    uniqueTokens.some((t) => {
      if (unmatched.has(t)) return false;
      const work: TokenWork | undefined = works.get(t);
      return work !== undefined && work.slices.length > 0 && work.atoms.length === 0;
    });
  if (needsVerbatim) {
    return {
      atoms: [],
      verbatimCss: assembleVerbatim(qualified, defaultText, tokenSet, unmatched, opts?.aliases),
      unmatched: [...unmatched],
      globals: fullGlobals,
    };
  }

  // 同一競合キーは出力順の後勝ち (Tailwind の stylesheet 順解決と同義)。
  const winners = new Map<string, { atom: StaticAtom; order: number }>();
  for (const [token, work] of works) {
    if (unmatched.has(token) || verbatimTokens.has(token)) continue;
    for (const atom of work.atoms) {
      const key: string = conflictKeyOf(atom.property, atom.context, atom.important);
      const prev = winners.get(key);
      if (prev === undefined || work.order >= prev.order) {
        winners.set(key, { atom, order: work.order });
      }
    }
  }
  const atoms: StaticAtom[] = [...winners.values()]
    .sort((x, y) => x.order - y.order)
    .map((entry) => entry.atom);

  // 同一 property 群の解決 (pseudo / baseline supports は保持、それ以外は verbatim)。
  const byProperty = new Map<string, StaticAtom[]>();
  for (const atom of atoms) {
    const list: StaticAtom[] | undefined = byProperty.get(atom.property);
    if (list === undefined) byProperty.set(atom.property, [atom]);
    else list.push(atom);
  }
  const kept: StaticAtom[] = [];
  for (const group of byProperty.values()) {
    if (group.length === 1) {
      kept.push(group[0] as StaticAtom);
      continue;
    }
    const resolved: StaticAtom[] | null = resolveSameProperty(group);
    if (resolved === null) {
      return {
        atoms: [],
        verbatimCss: assembleVerbatim(qualified, defaultText, tokenSet, unmatched, opts?.aliases),
        unmatched: [...unmatched],
        globals: fullGlobals,
      };
    }
    kept.push(...resolved);
  }

  for (let i = 0; i < kept.length; i += 1) {
    for (let j = i + 1; j < kept.length; j += 1) {
      const ai = kept[i] as StaticAtom;
      const aj = kept[j] as StaticAtom;
      if (ai.property !== aj.property && orderRiskProperty(ai.property, aj.property)) {
        return {
          atoms: [],
          verbatimCss: assembleVerbatim(qualified, defaultText, tokenSet, unmatched, opts?.aliases),
          unmatched: [...unmatched],
          globals: fullGlobals,
        };
      }
    }
  }

  return { atoms: kept, verbatimCss: '', unmatched: [...unmatched], globals: fullGlobals };
}

/**
 * selector 内の class 参照を alias に書き換える (削減モード用)。
 * quote 内 (属性値等) は触らない。escape 付き参照は unescape して照合し、
 * 今回の解決集合に属する matched token のみ置換する
 * (marker 用 `.group` 等の集合外・unmatched は原文維持。黙って意味を変えない)。
 */
function rewriteSelectorAliases(
  selector: string,
  aliases: ReadonlyMap<string, string>,
  tokenSet: ReadonlySet<string>,
  unmatched: ReadonlySet<string>,
): string {
  let out = '';
  let i = 0;
  while (i < selector.length) {
    const ch: string = selector[i] ?? '';
    if (ch === '"' || ch === "'") {
      const quote: string = ch;
      let j: number = i + 1;
      while (j < selector.length) {
        const c: string = selector[j] ?? '';
        if (c === '\\') j += 2;
        else if (c === quote) {
          j += 1;
          break;
        } else j += 1;
      }
      out += selector.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '.') {
      const split: { cls: string; rest: string } | null = splitClassRemainder(
        selector.slice(i),
      );
      if (split !== null && split.cls !== '') {
        const token: string = unescapeClass(split.cls);
        const alias: string | undefined = token.includes('\\')
          ? undefined
          : aliases.get(token);
        if (alias !== undefined && tokenSet.has(token) && !unmatched.has(token)) {
          out += `.${alias}`;
          i += 1 + split.cls.length;
          continue;
        }
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** rule slice 内の宣言 block 開始 `{` を探す (quote 外)。無ければ -1。 */
function ruleBodyOpen(slice: string): number {
  let quote: string | null = null;
  for (let i = 0; i < slice.length; i += 1) {
    const ch: string = slice[i] ?? '';
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') return i;
  }
  return -1;
}

/**
 * 1 rule を alias 書き換え済み text へ再構築する。
 * selector のみ置換し、宣言 body は原文のまま。wrapper
 * (`@media` 等) は外側に掛け直す (現状の verbatim 組立は wrapper を落とすが、
 * 削減 path では正しさのため保持する)。
 */
function rebuildRuleText(
  rule: RawRule,
  defaultText: string,
  aliases: ReadonlyMap<string, string>,
  tokenSet: ReadonlySet<string>,
  unmatched: ReadonlySet<string>,
): string {
  const slice: string = defaultText.slice(rule.start, rule.end);
  const open: number = ruleBodyOpen(slice);
  if (open < 0) return slice;
  const selectors: string[] = rule.selectors.map((s) =>
    rewriteSelectorAliases(s, aliases, tokenSet, unmatched),
  );
  let inner: string = `${selectors.join(',')}${slice.slice(open)}`;
  for (let k: number = rule.wrappers.length - 1; k >= 0; k -= 1) {
    const wrapper = rule.wrappers[k] as CssWrapper;
    inner =
      wrapper.prelude === ''
        ? `@${wrapper.kind}{${inner}}`
        : `@${wrapper.kind} ${wrapper.prelude}{${inner}}`;
  }
  return inner;
}

/**
 * matched token の rules を出力順に原文連結する (verbatim 用)。
 * unmatched の rules は存在しない。重複 slice は除く。
 * aliases 付きの場合は selector のみ書き換えて再構築する
 * (無しの場合と byte 同一にするため、無しの場合は原文 slice をそのまま使う)。
 */
function assembleVerbatim(
  rules: readonly RawRule[],
  defaultText: string,
  tokenSet: ReadonlySet<string>,
  unmatched: ReadonlySet<string>,
  aliases?: ReadonlyMap<string, string> | undefined,
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const rule of rules) {
    if (rule.opaqueAt !== null || rule.selectors.length === 0) continue;
    let owned = false;
    for (const selector of rule.selectors) {
      const classes: string[] | null = classesInSelector(selector);
      if (classes === null) continue;
      if (classes.some((cls) => tokenSet.has(cls) && !unmatched.has(cls))) {
        owned = true;
        break;
      }
    }
    if (!owned) continue;
    const key: string = `${rule.start}:${rule.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(
      aliases === undefined
        ? defaultText.slice(rule.start, rule.end)
        : rebuildRuleText(rule, defaultText, aliases, tokenSet, unmatched),
    );
  }
  return parts.join('\n');
}

/**
 * rule 宣言列を atoms へ。var 参照は「同 rule 定義」「fallback 付き」
 * 「登録済み (@property initial 付き)」「非 --un- (theme / user)」のみ受理し、
 * それ以外は null (token を verbatim に戻す)。
 */
function convertDecls(
  rule: RawRule,
  token: string,
  context: RuleContext,
  registered: ReadonlySet<string>,
): StaticAtom[] | null {
  const definedUno = new Set<string>();
  for (const decl of rule.decls) {
    const property: string = canonicalProperty(decl.prop);
    if (property.startsWith('--un-')) definedUno.add(property);
  }
  const atoms: StaticAtom[] = [];
  for (const decl of rule.decls) {
    const property: string = canonicalProperty(decl.prop);
    const important: boolean = IMPORTANT_RE.test(decl.value);
    const value: string = canonicalValue(decl.value.replace(IMPORTANT_RE, ''));
    if (classifyDeclaration(property, value) !== 'atomic') return null;
    for (const ref of varUses(value)) {
      if (!isUnoVar(ref.name)) continue;
      if (definedUno.has(ref.name)) continue;
      if (ref.hasFallback) continue;
      if (registered.has(ref.name)) continue;
      return null;
    }
    atoms.push(
      createStaticAtom({
        property,
        value,
        important,
        context,
        provenance: provenanceOf(token),
      }),
    );
  }
  return atoms;
}
