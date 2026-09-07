import { createParametricAtom, isValidCustomPropertyName } from '@qstyle/core';
import {
  buildGlobalAtRule,
  buildKeyframesRule,
  parseGlobalAtRuleKey,
  parseKeyframesKey,
  rewriteAnimationValue,
} from '@qstyle/core';
import type {
  GlobalAtRule,
  KeyframesRule,
  ParametricAtom,
  Provenance,
  ResidualRuleNode,
  RuleContext,
  RuntimeValueType,
  StaticAtom,
  TemplatePartInput,
  TemplateSlotInput,
} from '@qstyle/core';
import { isStyleHandle } from './compose.js';
import type { Diagnostic } from './object.js';
import { lowerStyleObject, mergeRuleContext, parseNestedKey, splitImportant } from './object.js';
import type { StyleHandle } from './index.js';

export interface TemplateLowerOptions {
  readonly source?: string | undefined;
}

export interface LoweredTemplate {
  readonly atoms: StaticAtom[];
  readonly parametrics: ParametricAtom[];
  readonly residuals: ResidualRuleNode[];
  readonly diagnostics: Diagnostic[];
  readonly keyframes: KeyframesRule[];
  readonly globals: GlobalAtRule[];
}

type ScannedItem =
  | { kind: 'decl'; prop: string; value: string }
  | { kind: 'block'; header: string; items: ScannedItem[] }
  | { kind: 'handle'; handle: StyleHandle }
  | { kind: 'runtime' };

const HANDLE_MARK = '\0H';
const RUNTIME_MARK = '\0R';

function classifyValue(value: unknown): string {
  if (isStyleHandle(value)) return `${HANDLE_MARK}${slotIndex(value)}\0`;
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return `${RUNTIME_MARK}\0`;
}

// interpolation slot の handle 解決表。buildText 開始時に reset され、
// lowerTaggedTemplate が完全同期のため呼び出し間の混入はない。
const slotTable: StyleHandle[] = [];
function slotIndex(handle: StyleHandle): number {
  slotTable.push(handle);
  return slotTable.length - 1;
}

function buildText(
  strings: readonly string[],
  values: readonly unknown[],
): { text: string; handles: StyleHandle[] } {
  slotTable.length = 0;
  let text = '';
  for (let i = 0; i < strings.length; i += 1) {
    text += strings[i] ?? '';
    if (i < values.length) text += classifyValue(values[i]);
  }
  return { text, handles: [...slotTable] };
}

interface Scanner {
  text: string;
  index: number;
}

function skipComment(scanner: Scanner): boolean {
  // scanner.text[scanner.index] === '/' && next === '*' が前提。
  const end: number = scanner.text.indexOf('*/', scanner.index + 2);
  if (end < 0) {
    scanner.index = scanner.text.length;
    return false;
  }
  scanner.index = end + 2;
  return true;
}

/**
 * `{...}` ブロックの中身を対応する `}` まで scan する (再帰)。
 * 文字列・escape・コメント・sentinel を考慮する。
 */
function scanItems(scanner: Scanner, inBlock: boolean): ScannedItem[] | null {
  const items: ScannedItem[] = [];
  let buffer = '';
  let closed = false;

  const flushDecl = (chunk: string): void => {
    const text: string = chunk.trim();
    if (text === '') return;
    const colon: number = findUnquotedChar(text, ':');
    if (colon < 0) {
      // sentinel のみの断片 (handle/runtime) の可能性がある。
      const slot: ScannedItem | null = parseStandaloneSlot(text);
      if (slot !== null) {
        items.push(slot);
        return;
      }
      items.push({ kind: 'runtime' });
      return;
    }
    const prop: string = text.slice(0, colon).trim();
    const value: string = text.slice(colon + 1).trim();
    if (prop === '' || value === '') {
      items.push({ kind: 'runtime' });
      return;
    }
    // release blocker 2: custom property 名は core の共有 validator に一元化する
    // (`--x}body{...` 等を decl として受理しない)。非 custom は従来の最小 grammar。
    if (
      prop.includes('\0') ||
      !(prop.startsWith('--') ? isValidCustomPropertyName(prop) : /^[A-Za-z-][\w-]*$/.test(prop))
    ) {
      items.push({ kind: 'runtime' });
      return;
    }
    if (value.includes(HANDLE_MARK)) {
      // value 内の StyleHandle 参照は M5b でも未対応。
      items.push({ kind: 'runtime' });
      return;
    }
    // value 内の runtime interpolation は marker を保持したまま decl に載せ、
    // lowering 段階で ParametricAtom へ落とす。
    items.push({ kind: 'decl', prop, value });
  };

  while (scanner.index < scanner.text.length) {
    const ch: string = scanner.text[scanner.index] ?? '';
    if (ch === '/' && scanner.text[scanner.index + 1] === '*') {
      if (!skipComment(scanner)) {
        items.push({ kind: 'runtime' });
        break;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end: number = skipString(scanner.text, scanner.index);
      if (end < 0) {
        items.push({ kind: 'runtime' });
        scanner.index = scanner.text.length;
        break;
      }
      buffer += scanner.text.slice(scanner.index, end);
      scanner.index = end;
      continue;
    }
    if (ch === '{') {
      const header: string = buffer.trim();
      buffer = '';
      scanner.index += 1;
      if (header.includes('\0')) {
        // selector/at-rule 条件内の interpolation (TPL-013/014)。
        skipBalanced(scanner);
        items.push({ kind: 'runtime' });
        continue;
      }
      const inner: ScannedItem[] | null = scanItems(scanner, true);
      if (inner === null) {
        items.push({ kind: 'runtime' });
        break;
      }
      items.push({ kind: 'block', header, items: inner });
      continue;
    }
    if (ch === '}') {
      if (!inBlock) {
        items.push({ kind: 'runtime' });
        scanner.index += 1;
        continue;
      }
      closed = true;
      scanner.index += 1;
      break;
    }
    if (ch === ';') {
      flushDecl(buffer);
      buffer = '';
      scanner.index += 1;
      continue;
    }
    buffer += ch;
    scanner.index += 1;
  }
  if (buffer.trim() !== '') flushDecl(buffer);
  if (inBlock && !closed) return null;
  return items;
}

/** quote で囲まれていない最初の target を探す。 */
function findUnquotedChar(text: string, target: string): number {
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
    if (ch === target) return i;
  }
  return -1;
}

function skipString(text: string, start: number): number {
  const quote: string = text[start] ?? '';
  let i: number = start + 1;
  while (i < text.length) {
    const ch: string = text[i] ?? '';
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === '\n') return -1;
    i += 1;
  }
  return -1;
}

function skipBalanced(scanner: Scanner): void {
  let depth = 1;
  while (scanner.index < scanner.text.length && depth > 0) {
    const ch: string = scanner.text[scanner.index] ?? '';
    if (ch === '"' || ch === "'") {
      const end: number = skipString(scanner.text, scanner.index);
      scanner.index = end < 0 ? scanner.text.length : end;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    scanner.index += 1;
  }
}

function parseStandaloneSlot(text: string): ScannedItem | null {
  let m: RegExpMatchArray | null = /^\0H(\d+)\0$/.exec(text);
  if (m !== null) {
    const handle: StyleHandle | undefined = slotTable[Number(m[1])];
    if (handle === undefined) return { kind: 'runtime' };
    return { kind: 'handle', handle };
  }
  m = /^\0R\0$/.exec(text);
  if (m !== null) return { kind: 'runtime' };
  return null;
}

type Segment =
  | { kind: 'record'; record: Record<string, unknown> }
  | { kind: 'handle'; handle: StyleHandle }
  | { kind: 'parametric'; atom: ParametricAtom }
  | { kind: 'runtime' };

interface TemplateSink {
  readonly parametrics: ParametricAtom[];
  readonly residuals: ResidualRuleNode[];
  readonly diagnostics: Diagnostic[];
  readonly provenance: readonly Provenance[];
  readonly keyframes: KeyframesRule[];
  readonly globals: GlobalAtRule[];
}

/** decl value 内の runtime marker 列 (`\0R\0`)。 */
const RUNTIME_SEQ = `${RUNTIME_MARK}\0`;

function hasRuntimeMarker(value: string): boolean {
  return value.includes(RUNTIME_SEQ);
}

// 単位 prefix -> slot 型。長い単位から先に照合する (`rem` vs `em`, `ms` vs `s`)。
const UNIT_TABLE: ReadonlyArray<readonly [string, RuntimeValueType]> = [
  ['px', 'length'],
  ['em', 'length'],
  ['rem', 'length'],
  ['vw', 'length'],
  ['vh', 'length'],
  ['vmin', 'length'],
  ['vmax', 'length'],
  ['ch', 'length'],
  ['ex', 'length'],
  ['cm', 'length'],
  ['mm', 'length'],
  ['in', 'length'],
  ['pt', 'length'],
  ['pc', 'length'],
  ['q', 'length'],
  ['lh', 'length'],
  ['rlh', 'length'],
  ['cap', 'length'],
  ['ic', 'length'],
  ['vi', 'length'],
  ['vb', 'length'],
  ['cqw', 'length'],
  ['cqh', 'length'],
  ['cqi', 'length'],
  ['cqb', 'length'],
  ['cqmin', 'length'],
  ['cqmax', 'length'],
  ['%', 'percentage'],
  ['deg', 'angle'],
  ['grad', 'angle'],
  ['rad', 'angle'],
  ['turn', 'angle'],
  ['ms', 'time'],
  ['s', 'time'],
];
const ORDERED_UNITS: ReadonlyArray<readonly [string, RuntimeValueType]> = [...UNIT_TABLE].sort(
  (a, b) => b[0].length - a[0].length,
);

/**
 * marker 直後の静的 text から slot 型を推測する (DYN-001/003)。
 * 単位 prefix に一致し、かつその直後が `[a-zA-Z%]` でない場合のみ型を付け、
 * それ以外 (単一 marker そのまま等) は 'custom'。
 */
function inferTypeFromSuffix(text: string): RuntimeValueType {
  const lower: string = text.toLowerCase();
  for (const [unit, type] of ORDERED_UNITS) {
    if (!lower.startsWith(unit)) continue;
    if (/[a-zA-Z%]/.test(lower.charAt(unit.length))) continue;
    return type;
  }
  return 'custom';
}

/**
 * decl value を marker で分割して ParametricAtom の構成要素へ変換する。
 * 静的 run は text 部分、各 `\0R\0` は slot 部分 (型は直後の text から推測)。
 * marker を含まない value には呼ばれない (null は保険)。
 */
function splitRuntimeValue(
  value: string,
): { parts: TemplatePartInput[]; slots: TemplateSlotInput[] } | null {
  const parts: TemplatePartInput[] = [];
  const slots: TemplateSlotInput[] = [];
  let buffer = '';
  let index = 0;
  while (index < value.length) {
    if (value.startsWith(RUNTIME_SEQ, index)) {
      slots.push({ valueType: inferTypeFromSuffix(value.slice(index + RUNTIME_SEQ.length)) });
      if (buffer !== '') {
        parts.push({ kind: 'text', text: buffer });
        buffer = '';
      }
      parts.push({ kind: 'slot', slotIndex: slots.length - 1 });
      index += RUNTIME_SEQ.length;
      continue;
    }
    buffer += value[index] ?? '';
    index += 1;
  }
  if (buffer !== '') parts.push({ kind: 'text', text: buffer });
  if (slots.length === 0) return null;
  return { parts, slots };
}

/**
 * runtime decl (value が `\0R\0` を含む) を ParametricAtom へ落とす。
 * `!important` は静的 value と同様に flag へ分離する。失敗時は residual + warn。
 */
function buildParametricAtom(
  prop: string,
  rawValue: string,
  context: RuleContext,
  sink: TemplateSink,
): ParametricAtom | null {
  const split = splitImportant(rawValue);
  const parsed = splitRuntimeValue(split.value);
  if (parsed === null) {
    sink.residuals.push({
      kind: 'residual-rule',
      cssText: `${prop}:${rawValue}`,
      scope: 'component',
      reason: 'unsupported-value',
      provenance: sink.provenance,
    });
    sink.diagnostics.push({ severity: 'warn', message: 'runtime interpolation needs a slot' });
    return null;
  }
  return createParametricAtom({
    property: prop,
    parts: parsed.parts,
    slots: parsed.slots,
    important: split.important,
    context,
    provenance: sink.provenance,
  });
}

/** block 部分木が runtime decl を含むか (含むなら template 側で context を解決する)。 */
function containsRuntimeDecl(item: { readonly items: readonly ScannedItem[] }): boolean {
  return item.items.some((child) => {
    if (child.kind === 'decl') return hasRuntimeMarker(child.value);
    if (child.kind === 'block') return containsRuntimeDecl(child);
    return false;
  });
}

/**
 * block を record へ落とす。runtime decl を含む block はここでネスト key を
 * context へ解決し (DYN-008)、対応不能なら block 全体を residual にして
 * null を返す。static decl のみの block は従来どおり record 経由。
 * `@keyframes` / `@font-face` / `@property` は top-level のみ global 系 IR へ
 * 落とし (nested は residual)、record には載せず null を返す。
 */
function lowerBlock(
  item: { readonly header: string; readonly items: ScannedItem[] },
  sink: TemplateSink,
  context: RuleContext,
): Record<string, unknown> | null {
  const keyframesName: string | null = parseKeyframesKey(item.header);
  const globalKey: { at: 'font-face' | 'property'; prelude: string } | null =
    keyframesName === null ? parseGlobalAtRuleKey(item.header) : null;
  if (keyframesName !== null || globalKey !== null) {
    if (isScopedContext(context)) {
      sink.residuals.push({
        kind: 'residual-rule',
        cssText: item.header,
        scope: 'component',
        reason: 'unsupported-at-rule',
        provenance: sink.provenance,
      });
      sink.diagnostics.push({
        severity: 'warn',
        message: `nested ${JSON.stringify(item.header)} is not supported; kept as residual`,
      });
      return null;
    }
    lowerAtRuleBlock(item.items, sink, keyframesName, globalKey);
    return null;
  }
  if (!containsRuntimeDecl(item)) return blockToRecord(item.items, sink, context);
  const delta: RuleContext | null = parseNestedKey(item.header);
  if (delta === null) {
    sink.residuals.push({
      kind: 'residual-rule',
      cssText: item.header,
      scope: 'component',
      reason: item.header.startsWith('&') ? 'unsupported-selector' : 'unsupported-at-rule',
      provenance: sink.provenance,
    });
    sink.diagnostics.push({
      severity: 'warn',
      message: `unsupported nested key ${JSON.stringify(item.header)}`,
    });
    return null;
  }
  return blockToRecord(item.items, sink, mergeRuleContext(context, delta));
}

/** context が何らかのスコープ (pseudo/media/…) を持つか。 */
function isScopedContext(context: RuleContext): boolean {
  return (
    (context.pseudo?.length ?? 0) > 0 ||
    context.media !== undefined ||
    context.supports !== undefined ||
    context.container !== undefined ||
    context.layer !== undefined ||
    context.descendant !== undefined ||
    context.suffix !== undefined
  );
}

/**
 * `@keyframes` / `@font-face` / `@property` ブロックを global 系 IR へ落とす。
 * 子要素は static decl (keyframes は frame ブロック) のみ受理し、
 * interpolation・handle・ネスト混じりは block 全体を residual にする。
 */
function lowerAtRuleBlock(
  items: readonly ScannedItem[],
  sink: TemplateSink,
  keyframesName: string | null,
  globalKey: { at: 'font-face' | 'property'; prelude: string } | null,
): void {
  const fail = (message: string): void => {
    sink.residuals.push({
      kind: 'residual-rule',
      cssText: keyframesName !== null ? `@keyframes ${keyframesName}` : '@font-face/@property',
      scope: 'component',
      reason: 'unsupported-value',
      provenance: sink.provenance,
    });
    sink.diagnostics.push({ severity: 'warn', message });
  };
  const readDecls = (
    decls: readonly ScannedItem[],
  ): Record<string, unknown> | null => {
    const record: Record<string, unknown> = {};
    for (const decl of decls) {
      // interpolation marker (runtime/handle) 混じりは受理しない。
      if (decl.kind !== 'decl') return null;
      if (decl.value.includes(HANDLE_MARK) || decl.value.includes(RUNTIME_MARK)) return null;
      record[decl.prop] = decl.value;
    }
    return record;
  };
  if (keyframesName !== null) {
    const framesRecord: Record<string, unknown> = {};
    for (const child of items) {
      if (child.kind !== 'block') {
        fail('@keyframes block only accepts frame blocks with static declarations');
        return;
      }
      const frameRecord: Record<string, unknown> | null = readDecls(child.items);
      if (frameRecord === null) {
        fail('@keyframes frame only accepts static declarations');
        return;
      }
      framesRecord[child.header] = { ...(framesRecord[child.header] as Record<string, unknown> | undefined), ...frameRecord };
    }
    const built = buildKeyframesRule(keyframesName, framesRecord, sink.provenance);
    if ('rule' in built) {
      sink.keyframes.push(built.rule);
    } else {
      sink.residuals.push({
        kind: 'residual-rule',
        cssText: `@keyframes ${keyframesName}`,
        scope: 'component',
        reason: built.reason,
        provenance: sink.provenance,
      });
      sink.diagnostics.push({ severity: 'warn', message: built.message });
    }
    return;
  }
  if (globalKey !== null) {
    const record: Record<string, unknown> | null = readDecls(items);
    if (record === null) {
      fail(`@${globalKey.at} block only accepts static declarations`);
      return;
    }
    const built = buildGlobalAtRule(globalKey.at, globalKey.prelude, record, sink.provenance);
    if ('rule' in built) {
      sink.globals.push(built.rule);
    } else {
      sink.residuals.push({
        kind: 'residual-rule',
        cssText: `@${globalKey.at} ${globalKey.prelude}`.trim(),
        scope: 'component',
        reason: built.reason,
        provenance: sink.provenance,
      });
      sink.diagnostics.push({ severity: 'warn', message: built.message });
    }
  }
}

function blockToRecord(
  items: ScannedItem[],
  sink: TemplateSink,
  context: RuleContext,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const item of items) {
    if (item.kind === 'decl') {
      if (hasRuntimeMarker(item.value)) {
        // runtime decl は record に載せず、ここで context を解決して
        // ParametricAtom へ落とす。静的 decl は従来どおり nested record 経由。
        const atom: ParametricAtom | null = buildParametricAtom(
          item.prop,
          item.value,
          context,
          sink,
        );
        if (atom !== null) sink.parametrics.push(atom);
        continue;
      }
      record[item.prop] = item.value;
    } else if (item.kind === 'block') {
      const inner = lowerBlock(item, sink, context);
      if (inner !== null) record[item.header] = inner;
    } else if (item.kind === 'handle') {
      sink.residuals.push({
        kind: 'residual-rule',
        cssText: 'nested StyleHandle interpolation',
        scope: 'component',
        reason: 'unsupported-value',
        provenance: sink.provenance,
      });
      sink.diagnostics.push({
        severity: 'warn',
        message: 'StyleHandle interpolation inside a nested block is not supported yet',
      });
    } else {
      sink.residuals.push({
        kind: 'residual-rule',
        cssText: 'runtime interpolation',
        scope: 'component',
        reason: 'unsupported-value',
        provenance: sink.provenance,
      });
      sink.diagnostics.push({
        severity: 'warn',
        message: 'runtime interpolation needs M5 ParametricAtom; kept as residual for now',
      });
    }
  }
  return record;
}

/**
 * `css` tagged template literal を Style IR へ lowering する (plan.md §22)。
 * object syntax と同一の canonical IR に落とすため、両記法の等価な宣言は
 * 同一 semantic hash になる (TPL-017)。decl value 内の runtime interpolation
 * は ParametricAtom (M5b) へ落とし、それ以外の marker (prop / selector / 単独)
 * は residual + warn に落とす。
 */
export function lowerTaggedTemplate(
  strings: TemplateStringsArray | readonly string[],
  values: readonly unknown[],
  opts: TemplateLowerOptions = {},
): LoweredTemplate {
  const provenance: readonly Provenance[] = [
    { source: opts.source ?? '<template>', line: 1, column: 1 },
  ];
  const atoms: StaticAtom[] = [];
  const parametrics: ParametricAtom[] = [];
  const residuals: ResidualRuleNode[] = [];
  const diagnostics: Diagnostic[] = [];
  const keyframes: KeyframesRule[] = [];
  const globals: GlobalAtRule[] = [];
  const sink: TemplateSink = { parametrics, residuals, diagnostics, provenance, keyframes, globals };
  const pushResidual = (cssText: string, message: string): void => {
    residuals.push({
      kind: 'residual-rule',
      cssText,
      scope: 'component',
      reason: 'unsupported-value',
      provenance,
    });
    diagnostics.push({ severity: 'warn', message });
  };

  const { text } = buildText(strings, values);
  const scanner: Scanner = { text, index: 0 };
  const items: ScannedItem[] | null = scanItems(scanner, false);
  if (items === null) {
    pushResidual(text, 'unbalanced block in template literal');
    return { atoms, parametrics, residuals, diagnostics, keyframes, globals };
  }

  const segments: Segment[] = [];
  let current: Record<string, unknown> | null = null;
  const currentRecord = (): Record<string, unknown> => {
    if (current === null) {
      current = {};
      segments.push({ kind: 'record', record: current });
    }
    return current;
  };

  for (const item of items) {
    if (item.kind === 'decl') {
      if (hasRuntimeMarker(item.value)) {
        // decl value の runtime interpolation は ParametricAtom として独立 op にする。
        // source 順を保つため record segment をここで区切る。
        const atom = buildParametricAtom(item.prop, item.value, {}, sink);
        if (atom !== null) segments.push({ kind: 'parametric', atom });
        current = null;
        continue;
      }
      currentRecord()[item.prop] = item.value;
    } else if (item.kind === 'block') {
      const inner = lowerBlock(item, sink, {});
      if (inner !== null) currentRecord()[item.header] = inner;
    } else if (item.kind === 'handle') {
      segments.push({ kind: 'handle', handle: item.handle });
      current = null;
    } else {
      segments.push({ kind: 'runtime' });
      current = null;
    }
  }

  for (const segment of segments) {
    if (segment.kind === 'handle') {
      for (const atom of segment.handle.atoms) atoms.push(atom);
      for (const parametric of segment.handle.parametrics) parametrics.push(parametric);
      for (const residual of segment.handle.residuals) residuals.push(residual);
      for (const rule of segment.handle.keyframes) keyframes.push(rule);
      for (const rule of segment.handle.globals) globals.push(rule);
    } else if (segment.kind === 'parametric') {
      parametrics.push(segment.atom);
    } else if (segment.kind === 'runtime') {
      pushResidual('runtime interpolation', 'runtime interpolation without a property context');
    } else {
      const lowered = lowerStyleObject(
        segment.record as Parameters<typeof lowerStyleObject>[0],
        { source: provenance[0]?.source ?? '<template>' },
      );
      for (const atom of lowered.atoms) atoms.push(atom);
      for (const residual of lowered.residuals) residuals.push(residual);
      for (const diagnostic of lowered.diagnostics) diagnostics.push(diagnostic);
      for (const rule of lowered.keyframes) keyframes.push(rule);
      for (const rule of lowered.globals) globals.push(rule);
    }
  }
  // 同一 template 内の `@keyframes` 定義は静的な animation 参照へ書換える
  // (record segment 経由の宣言は定義を知らないため post-pass で統一する)。
  if (keyframes.length > 0) {
    const table = new Map<string, string>(keyframes.map((rule) => [rule.sourceName, rule.name]));
    for (let i = 0; i < atoms.length; i += 1) {
      const atom: StaticAtom = atoms[i] as StaticAtom;
      if (atom.property !== 'animation' && atom.property !== 'animation-name') continue;
      const rewritten: string = rewriteAnimationValue(atom.value, table);
      if (rewritten !== atom.value) atoms[i] = { ...atom, value: rewritten };
    }
  }
  // 動的な animation 参照は確定名へ書換えできないため、同一 template 内に
  // `@keyframes` 定義がある場合は residual に落とす (書換え不能の黙殺防止)。
  if (keyframes.length > 0) {
    const kept: ParametricAtom[] = [];
    for (const atom of parametrics) {
      if (atom.property === 'animation' || atom.property === 'animation-name') {
        pushResidual(
          `${atom.property}:runtime value`,
          'dynamic animation with local @keyframes cannot be rewritten; use a static value',
        );
      } else {
        kept.push(atom);
      }
    }
    parametrics.length = 0;
    for (const atom of kept) parametrics.push(atom);
  }
  return { atoms, parametrics, residuals, diagnostics, keyframes, globals };
}
