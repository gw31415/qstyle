import {
  buildGlobalAtRule,
  buildKeyframesRule,
  canonicalProperty,
  classifyDeclaration,
  createStaticAtom,
  parseGlobalAtRuleKey,
  parseKeyframesKey,
  parseLayerKey,
  rewriteAnimationValue,
} from '@qstyle/core';
import type {
  GlobalAtRule,
  KeyframesRule,
  Provenance,
  ResidualRuleNode,
  RuleContext,
  StaticAtom,
} from '@qstyle/core';
import type { StyleObject } from './index.js';

export interface Diagnostic {
  readonly severity: 'warn' | 'error';
  readonly message: string;
}

export interface LoweredStyle {
  readonly atoms: StaticAtom[];
  readonly residuals: ResidualRuleNode[];
  readonly diagnostics: Diagnostic[];
  readonly keyframes: KeyframesRule[];
  readonly globals: GlobalAtRule[];
}

export interface LowerOptions {
  readonly source?: string | undefined;
  /**
   * module 内の `@keyframes` 定義表 (sourceName -> 確定名)。同一オブジェクト内の
   * 定義を優先し、不足分のみ参照する (定義と参照の分離配置用)。
   */
  readonly keyframes?: ReadonlyMap<string, string> | undefined;
}

export interface ImportantSplit {
  readonly value: string;
  readonly important: boolean;
}

/**
 * 末尾 `!important` を value 文字列から important flag へ分離する。
 * template literal 側 (template.ts) と共有する。
 */
export function splitImportant(raw: string): ImportantSplit {
  const m: RegExpMatchArray | null = /^(.*?)\s*!important\s*$/i.exec(raw);
  if (m === null) return { value: raw, important: false };
  return { value: m[1] ?? '', important: true };
}

const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasCombinator(selector: string): boolean {
  return /[\s>+~]/.test(selector);
}

/**
 * ネストキー (`&:hover` / `& span.x` / `@media ...` 等) を context 差分へ変換する。
 * template literal 側 (template.ts) と共有する。対応不能なら null。
 * `&` は単純形 (pseudo / 単純子孫) を優先し、それ以外は広域ルールの
 * suffix (` > svg` / `--mod` / `:hover, :focus` 等) として受理する。
 */
export function parseNestedKey(key: string): RuleContext | null {
  if (key.startsWith('&')) {
    const body: string = key.slice(1);
    // `& <simple-selector>` は子孫セレクタ。外れれば suffix へ fallthrough。
    if (/\s/.test(body)) {
      const selector: string = body.trim();
      if (/^(?:[A-Za-z][\w-]*|\.[\w-]+)(?:\.[\w-]+)*$/.test(selector)) {
        return { descendant: selector };
      }
    } else {
      const pseudo: string | null = extractPseudo(key);
      if (pseudo !== null) return { pseudo: [pseudo] };
    }
    const suffix: string | null = parseAmpSuffix(body);
    return suffix === null ? null : { suffix };
  }
  if (key.startsWith('@')) {
    const lowered: string = key.toLowerCase();
    if (lowered.startsWith('@media')) {
      return { media: key.slice('@media'.length).trim() };
    }
    if (lowered.startsWith('@supports')) {
      return { supports: key.slice('@supports'.length).trim() };
    }
    if (lowered.startsWith('@container')) {
      return { container: key.slice('@container'.length).trim() };
    }
    if (lowered.startsWith('@layer')) {
      const layer: string | null = parseLayerKey(key);
      return layer === null ? null : { layer };
    }
    return null;
  }
  return null;
}

/**
 * `&` 以降の生サフィックスを正規化する (広域単純ルール):
 * - `{ } ; < !` を含む・空・カンマ要素の空・`&` の残存は拒否
 * - 先頭要素は `&` 直後の空白有無で連結 (`&--m`→直結 / `& .a`→子孫) を決める
 * - カンマ後の `&` は1個だけ剥がす (`&:hover, &:focus` / `& .a, & .b`)。
 *   剥がし後の空白は子孫、剥がした `&` の直結 (`&.b`) と `:` 始まりは直結、
 *   それ以外 (`, .b` / `, svg`) は子孫
 */
function parseAmpSuffix(body: string): string | null {
  if (body === '' || /[{}\;<!]/.test(body)) return null;
  const raws: string[] = body.split(',');
  const parts: string[] = [];
  for (let i = 0; i < raws.length; i += 1) {
    let raw: string = raws[i] ?? '';
    let stripped = false;
    if (i > 0) {
      const unseparated: string = raw.trimStart();
      if (unseparated.startsWith('&')) {
        raw = unseparated.slice(1);
        stripped = true;
      } else {
        raw = unseparated;
      }
    }
    if (raw.includes('&')) return null;
    const trimmed: string = raw.trim().replace(/\s+/g, ' ');
    if (trimmed === '') return null;
    if (i === 0) {
      parts.push((/^\s/.test(raw) ? ' ' : '') + trimmed);
    } else if (/^\s/.test(raw) || (!stripped && !trimmed.startsWith(':'))) {
      parts.push(` ${trimmed}`);
    } else {
      parts.push(trimmed);
    }
  }
  return parts.join(',');
}

export function mergeRuleContext(base: RuleContext, delta: RuleContext): RuleContext {
  const tail = mergeTail(base, delta);
  return {
    ...base,
    ...delta,
    pseudo: [...(base.pseudo ?? []), ...(delta.pseudo ?? [])],
    layer: mergeLayerName(base.layer, delta.layer),
    descendant: tail.descendant,
    suffix: tail.suffix,
  };
}

/** 片側 context の selector tail を順序付きリストへ (`descendant` は単一・`,` なし)。 */
function tailList(context: RuleContext): string[] {
  const desc: string = context.descendant !== undefined ? ` ${context.descendant}` : '';
  if (context.suffix === undefined) return [desc];
  return context.suffix.split(',').map((part) => `${desc}${part}`);
}

/** 単純子孫1段 (` .a` / ` svg`) のみ descendant field に残す (単層互換用)。 */
const SIMPLE_TAIL_RE = /^ (?:[A-Za-z][\w-]*|\.[\w-]+(?:\.[\w-]+)*)$/;

/**
 * selector tail の結合はレベル順の直積 (外側×内側)。
 * `&:hover,:focus` × ` .x` → `:hover .x,:focus .x`。
 * 単純子孫1段に畳める場合のみ descendant に戻し、単層の hash 互換を保つ。
 */
function mergeTail(
  base: RuleContext,
  delta: RuleContext,
): { descendant?: string | undefined; suffix?: string | undefined } {
  const crossed: string[] = [];
  for (const x of tailList(base)) {
    for (const y of tailList(delta)) crossed.push(`${x}${y}`);
  }
  if (crossed.length === 1 && crossed[0] === '') return {};
  if (crossed.length === 1 && SIMPLE_TAIL_RE.test(crossed[0] as string)) {
    return { descendant: (crossed[0] as string).trim() };
  }
  return { suffix: crossed.join(',') };
}

/** nested `@layer a { @layer b }` は `a.b` (anonymous は空として畳む)。 */
function mergeLayerName(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return [a, b].filter((s) => s !== '').join('.');
}

/**
 * `&:hover` / `&::before` / `:focus-visible`-with-args 形のみ抽出する。
 * combinator や複雑な関数引数を含む場合は null (residual 側に回す)。
 */
function extractPseudo(key: string): string | null {
  const body: string = key.slice(1);
  const m: RegExpMatchArray | null = /^::?[\w-]+(?:\([^()\s]*\))?$/.exec(body);
  if (m === null) return null;
  if (hasCombinator(body)) return null;
  return body;
}

interface Sink {
  readonly atoms: StaticAtom[];
  readonly residuals: ResidualRuleNode[];
  readonly diagnostics: Diagnostic[];
  readonly keyframes: KeyframesRule[];
  readonly globals: GlobalAtRule[];
}

function warn(sink: Sink, message: string): void {
  sink.diagnostics.push({ severity: 'warn', message });
}

function lowerInto(
  record: Record<string, unknown>,
  context: RuleContext,
  provenance: readonly Provenance[],
  sink: Sink,
  keyframes: ReadonlyMap<string, string>,
): void {
  for (const key of Object.keys(record)) {
    if (DANGEROUS_KEYS.has(key)) {
      warn(sink, `ignored dangerous key ${JSON.stringify(key)}`);
      continue;
    }
    const value: unknown = record[key];

    // falsy primitive は無視する (composition の falsy 対応は M3)。
    if (value === null || value === undefined || typeof value === 'boolean') {
      continue;
    }

    if (typeof value === 'string' || typeof value === 'number') {
      // 末尾 `!important` は value 文字列ではなく important flag に立てる
      // (CMP-014 / CSS-008: priority を cascade 上正しく保つため)。
      // 数値は createStaticAtom 経由で serialize (px 付与等) する。
      const split: ImportantSplit =
        typeof value === 'number'
          ? { value: String(value), important: false }
          : splitImportant(value);
      // 同一オブジェクト内の `@keyframes` 定義は確定名へ書換える。
      const property: string = canonicalProperty(key);
      const text: string =
        typeof value === 'number' ||
        (property !== 'animation' && property !== 'animation-name')
          ? split.value
          : rewriteAnimationValue(split.value, keyframes);
      // canonical 化した property と value を safety 判定に通す (OBJ-023:
      // 構文として不正な値を silent emit しない)。
      const verdict = classifyDeclaration(property, text);
      if (verdict !== 'atomic') {
        sink.residuals.push({
          kind: 'residual-rule',
          cssText: `${key}`,
          scope: 'component',
          reason: verdict.residual,
          provenance,
        });
        warn(sink, `invalid declaration for property ${JSON.stringify(key)}`);
        continue;
      }
      sink.atoms.push(
        createStaticAtom({
          property: key,
          value: typeof value === 'number' ? value : text,
          important: split.important,
          context,
          provenance,
        }),
      );
      continue;
    }

    if (key.startsWith('&') || key.startsWith('@')) {
      const isSelector: boolean = key.startsWith('&');
      if (!isPlainObject(value)) {
        sink.residuals.push({
          kind: 'residual-rule',
          cssText: key,
          scope: 'component',
          reason: isSelector ? 'unsupported-selector' : 'unsupported-at-rule',
          provenance,
        });
        warn(sink, `unsupported nested value for ${JSON.stringify(key)}`);
        continue;
      }
      const delta: RuleContext | null = parseNestedKey(key);
      if (delta === null) {
        sink.residuals.push({
          kind: 'residual-rule',
          cssText: key,
          scope: 'component',
          reason: isSelector ? 'unsupported-selector' : 'unsupported-at-rule',
          provenance,
        });
        warn(sink, `unsupported nested key ${JSON.stringify(key)}`);
        continue;
      }
      lowerInto(value, mergeRuleContext(context, delta), provenance, sink, keyframes);
      continue;
    }

    // property キーの下の object / array / function 等は値として扱えない。
    sink.residuals.push({
      kind: 'residual-rule',
      cssText: `${key}`,
      scope: 'component',
      reason: 'unsupported-value',
      provenance,
    });
    warn(sink, `unsupported value for property ${JSON.stringify(key)}`);
  }
}

/**
 * `css` prop / `css()` object syntax を Style IR へ lowering する (plan.md §20)。
 * 安全に atomize できないものは ResidualRuleNode + warn diagnostic に落とし、
 * silent miscompile しない (correctness first)。
 * top-level の `@keyframes` / `@font-face` / `@property` は global 系 IR へ落とす
 * (nested は residual)。`@keyframes` 定義名は同一オブジェクト内の
 * `animation` / `animation-name` 参照へ書換える (内容 hash 名で重複排除)。
 */
export function lowerStyleObject(
  style: StyleObject,
  opts: LowerOptions = {},
): LoweredStyle {
  const source: string = opts.source ?? '<inline>';
  const provenance: readonly Provenance[] = [{ source, line: 1, column: 1 }];
  const sink: Sink = { atoms: [], residuals: [], diagnostics: [], keyframes: [], globals: [] };
  const keyframesByName = new Map<string, string>();
  const record = style as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (DANGEROUS_KEYS.has(key)) {
      warn(sink, `ignored dangerous key ${JSON.stringify(key)}`);
      continue;
    }
    const keyframesName: string | null = parseKeyframesKey(key);
    const globalKey: { at: 'font-face' | 'property'; prelude: string } | null =
      keyframesName === null ? parseGlobalAtRuleKey(key) : null;
    if (keyframesName === null && globalKey === null) {
      rest[key] = record[key];
      continue;
    }
    const body: unknown = record[key];
    if (!isPlainObject(body)) {
      sink.residuals.push({
        kind: 'residual-rule',
        cssText: key,
        scope: 'component',
        reason: 'unsupported-at-rule',
        provenance,
      });
      warn(sink, `unsupported nested value for ${JSON.stringify(key)}`);
      continue;
    }
    if (keyframesName !== null) {
      const built = buildKeyframesRule(keyframesName, body, provenance);
      if ('rule' in built) {
        sink.keyframes.push(built.rule);
        keyframesByName.set(keyframesName, built.rule.name);
      } else {
        sink.residuals.push({
          kind: 'residual-rule',
          cssText: key,
          scope: 'component',
          reason: built.reason,
          provenance,
        });
        warn(sink, built.message);
      }
      continue;
    }
    if (globalKey !== null) {
      const built = buildGlobalAtRule(globalKey.at, globalKey.prelude, body, provenance);
      if ('rule' in built) {
        sink.globals.push(built.rule);
      } else {
        sink.residuals.push({
          kind: 'residual-rule',
          cssText: key,
          scope: 'component',
          reason: built.reason,
          provenance,
        });
        warn(sink, built.message);
      }
    }
  }
  lowerInto(rest, {}, provenance, sink, combinedKeyframes(keyframesByName, opts.keyframes));
  return {
    atoms: sink.atoms,
    residuals: sink.residuals,
    diagnostics: sink.diagnostics,
    keyframes: sink.keyframes,
    globals: sink.globals,
  };
}

/** 同一オブジェクト内の定義を優先した書換え表 (外部表は不足分のみ)。 */
function combinedKeyframes(
  local: ReadonlyMap<string, string>,
  external: ReadonlyMap<string, string> | undefined,
): ReadonlyMap<string, string> {
  if (external === undefined || external.size === 0) return local;
  if (local.size === 0) return external;
  const combined = new Map<string, string>(external);
  for (const [name, hashed] of local) combined.set(name, hashed);
  return combined;
}
