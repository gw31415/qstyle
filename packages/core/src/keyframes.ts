import { canonicalProperty, fnv1aHex } from './atom.js';
import { classifyDeclaration, isValidCustomPropertyName } from './safety.js';
import { serializeCssValue } from './units.js';
import type {
  AtRuleDecl,
  GlobalAtRule,
  KeyframesFrame,
  KeyframesRule,
  Provenance,
  ResidualReason,
} from './ir.js';

// `@keyframes fade` / `@property --x` / `@font-face` の純粋パーサ・正規化・
// hash・serialize (object/template の両 lowering から共有する)。

const KEYFRAMES_NAME_RE = /^[A-Za-z_][\w-]*$/;
const FRAME_PART_RE = /^(?:from|to|\d+(?:\.\d+)?%)$/;
/** `<layer-name>`: `<ident> ('.' <ident>)*`。空 (anonymous layer) も許す。 */
const LAYER_NAME_RE = /^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*$/;

/** `@keyframes <name>` なら定義名を返す (大文字小文字の prefix は許す)。 */
export function parseKeyframesKey(key: string): string | null {
  const m: RegExpMatchArray | null = /^@keyframes\s+(.+?)\s*$/i.exec(key);
  if (m === null) return null;
  const name: string = (m[1] ?? '').trim();
  return KEYFRAMES_NAME_RE.test(name) ? name : null;
}

/** `@font-face` / `@property --x` なら種別と prelude を返す。
 * `@property` の prelude は共有 custom property validator に一元化する
 * (release blocker 2: `--x}body{...` 等を CSS へ出さない)。 */
export function parseGlobalAtRuleKey(
  key: string,
): { at: 'font-face' | 'property'; prelude: string } | null {
  const trimmed: string = key.trim();
  if (/^@font-face\s*$/i.test(trimmed)) return { at: 'font-face', prelude: '' };
  const m: RegExpMatchArray | null = /^@property\s+(.+?)\s*$/i.exec(trimmed);
  if (m === null) return null;
  const prelude: string = (m[1] ?? '').trim();
  return isValidCustomPropertyName(prelude) ? { at: 'property', prelude } : null;
}

/** `@layer <name>` なら layer 名 (anonymous は '') を返す。 */
export function parseLayerKey(key: string): string | null {
  const m: RegExpMatchArray | null = /^@layer(.*)$/i.exec(key);
  if (m === null) return null;
  const prelude: string = (m[1] ?? '').trim();
  if (prelude === '') return '';
  return LAYER_NAME_RE.test(prelude) ? prelude : null;
}

/**
 * フレームセレクタ (`from` / `to` / `0%` / `0%, 100%`) を正規化する。
 * from/to は小文字化し、カンマ前後の空白を潰す。不正なら null。
 */
export function normalizeFrameSelector(selector: string): string | null {
  const parts: string[] = selector.split(',');
  const out: string[] = [];
  for (const raw of parts) {
    const part: string = raw.trim().toLowerCase();
    if (!FRAME_PART_RE.test(part)) return null;
    out.push(part);
  }
  return out.length === 0 ? null : out.join(', ');
}

/** フレームのソートキー (from=0% / to=100% として数値順、同値は安定)。 */
function frameOrder(selector: string): number {
  const head: string = selector.split(',')[0]?.trim() ?? '';
  if (head === 'from') return 0;
  if (head === 'to') return 100;
  const n: number = Number.parseFloat(head);
  return Number.isFinite(n) ? n : 50;
}

export type AtRuleDeclsInput = Record<string, string | number>;

export interface BuildFailure {
  readonly reason: ResidualReason;
  readonly message: string;
}

/**
 * 宣言 record を検証・canonical 化する (数値は px 則で serialize)。
 * `!important` suffix は flag へ分離する。失敗時は residual 理由を返す。
 */
export function buildAtRuleDecls(
  record: Record<string, unknown>,
  what: string,
): { decls: AtRuleDecl[] } | BuildFailure {
  const decls: AtRuleDecl[] = [];
  for (const key of Object.keys(record)) {
    const value: unknown = record[key];
    if (typeof value !== 'string' && typeof value !== 'number') {
      return { reason: 'unsupported-value', message: `${what} only accepts static values` };
    }
    let text: string;
    let important = false;
    if (typeof value === 'number') {
      text = serializeCssValue(key, value);
    } else {
      const m: RegExpMatchArray | null = /^(.*?)\s*!important\s*$/i.exec(value);
      if (m !== null) {
        text = (m[1] ?? '').trim();
        important = true;
      } else {
        text = value;
      }
    }
    const property: string = canonicalProperty(key);
    const verdict = classifyDeclaration(property, text);
    if (verdict !== 'atomic') {
      return { reason: verdict.residual, message: `${what} has an invalid declaration` };
    }
    decls.push({ property, value: text.trim().replace(/\s+/g, ' '), important });
  }
  decls.sort((a, b) => (a.property < b.property ? -1 : a.property > b.property ? 1 : 0));
  return { decls };
}

function isFailure(value: { decls: AtRuleDecl[] } | BuildFailure): value is BuildFailure {
  return (value as BuildFailure).reason !== undefined;
}

/**
 * `@keyframes` ブロック (frame selector -> 宣言 record) を KeyframesRule へ。
 * name は内容 hash 由来でグローバル安定 (`qkf_xxxxxxxx`)。
 */
export function buildKeyframesRule(
  sourceName: string,
  framesRecord: Record<string, unknown>,
  provenance: readonly Provenance[],
): { rule: KeyframesRule } | BuildFailure {
  const frames: KeyframesFrame[] = [];
  for (const key of Object.keys(framesRecord)) {
    const selector: string | null = normalizeFrameSelector(key);
    if (selector === null) {
      return {
        reason: 'unsupported-syntax',
        message: `@keyframes frame selector ${JSON.stringify(key)} is not supported`,
      };
    }
    const body: unknown = framesRecord[key];
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return {
        reason: 'unsupported-value',
        message: `@keyframes frame ${JSON.stringify(key)} only accepts static declarations`,
      };
    }
    const built = buildAtRuleDecls(body as Record<string, unknown>, '@keyframes frame');
    if (isFailure(built)) return built;
    frames.push({ selector, decls: built.decls });
  }
  if (frames.length === 0) {
    return { reason: 'unsupported-syntax', message: '@keyframes block is empty' };
  }
  // ponytail: フレームは数値順に正規化 (同値は author 順を保つ)。同一内容↔同一 hash。
  const indexed: Array<{ frame: KeyframesFrame; index: number }> = frames.map((frame, index) => ({
    frame,
    index,
  }));
  indexed.sort(
    (a, b) => frameOrder(a.frame.selector) - frameOrder(b.frame.selector) || a.index - b.index,
  );
  const sorted: KeyframesFrame[] = indexed.map((entry) => entry.frame);
  const name: string = `qkf_${fnv1aHex(JSON.stringify(sorted))}`;
  return { rule: { kind: 'keyframes-rule', name, sourceName, frames: sorted, provenance } };
}

/** `@font-face` / `@property` ブロックを GlobalAtRule へ。 */
export function buildGlobalAtRule(
  at: 'font-face' | 'property',
  prelude: string,
  record: Record<string, unknown>,
  provenance: readonly Provenance[],
): { rule: GlobalAtRule } | BuildFailure {
  const built = buildAtRuleDecls(record, `@${at}`);
  if (isFailure(built)) return built;
  if (built.decls.length === 0) {
    return { reason: 'unsupported-syntax', message: `@${at} block is empty` };
  }
  const id: string = `qg_${fnv1aHex(JSON.stringify([at, prelude, built.decls]))}`;
  return { rule: { kind: 'global-at-rule', at, prelude, decls: built.decls, id, provenance } };
}

function serializeAtDecls(decls: readonly AtRuleDecl[]): string {
  return decls
    .map((d) => `${d.property}:${d.value}${d.important ? '!important' : ''}`)
    .join(';');
}

/** `@keyframes qkf_...{from{...}...}` (keyframes は class に属さない global CSS)。 */
export function serializeKeyframesCss(rule: KeyframesRule): string {
  const frames: string = rule.frames
    .map((frame) => `${frame.selector}{${serializeAtDecls(frame.decls)}}`)
    .join('');
  return `@keyframes ${rule.name}{${frames}}`;
}

/** `@font-face{...}` / `@property --x{...}` (global CSS)。 */
export function serializeGlobalAtRuleCss(rule: GlobalAtRule): string {
  const head: string = rule.prelude === '' ? `@${rule.at}` : `@${rule.at} ${rule.prelude}`;
  return `${head}{${serializeAtDecls(rule.decls)}}`;
}

/** CSS-wide keyword と `none` は keyframes 参照に書換えない (誤変換防止)。 */
const NON_ANIMATION_NAMES: ReadonlySet<string> = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'none',
]);

/**
 * `animation` / `animation-name` 値中の定義名トークンを確定名へ書換える。
 * カンマ区切り・空白区切りの完全一致のみ置換し、関数・var() 内は触らない。
 */
export function rewriteAnimationValue(
  value: string,
  keyframes: ReadonlyMap<string, string>,
): string {
  if (keyframes.size === 0) return value;
  return value
    .split(',')
    .map((part) =>
      part
        .split(/(\s+)/)
        .map((token) => {
          if (token === '' || /^\s+$/.test(token)) return token;
          if (NON_ANIMATION_NAMES.has(token.toLowerCase())) return token;
          return keyframes.get(token) ?? token;
        })
        .join(''),
    )
    .join(',');
}
