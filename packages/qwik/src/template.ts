import type { Provenance, ResidualRuleNode, StaticAtom } from '@qstyle/core';
import { isStyleHandle } from './compose.js';
import type { Diagnostic } from './object.js';
import { lowerStyleObject } from './object.js';
import type { StyleHandle } from './index.js';

export interface TemplateLowerOptions {
  readonly source?: string | undefined;
}

export interface LoweredTemplate {
  readonly atoms: StaticAtom[];
  readonly residuals: ResidualRuleNode[];
  readonly diagnostics: Diagnostic[];
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
    if (prop.includes('\0') || !/^(?:--[^\s]+|[A-Za-z-][\w-]*)$/.test(prop)) {
      items.push({ kind: 'runtime' });
      return;
    }
    if (value.includes('\0')) {
      // value 内の interpolation は M4 では扱わない (M5 の RuntimeSlot へ)。
      items.push({ kind: 'runtime' });
      return;
    }
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
  | { kind: 'runtime' };

function blockToRecord(
  items: ScannedItem[],
  provenance: readonly Provenance[],
  residuals: ResidualRuleNode[],
  diagnostics: Diagnostic[],
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const item of items) {
    if (item.kind === 'decl') {
      record[item.prop] = item.value;
    } else if (item.kind === 'block') {
      record[item.header] = blockToRecord(item.items, provenance, residuals, diagnostics);
    } else if (item.kind === 'handle') {
      residuals.push({
        kind: 'residual-rule',
        cssText: 'nested StyleHandle interpolation',
        scope: 'component',
        reason: 'unsupported-value',
        provenance,
      });
      diagnostics.push({
        severity: 'warn',
        message: 'StyleHandle interpolation inside a nested block is not supported yet',
      });
    } else {
      residuals.push({
        kind: 'residual-rule',
        cssText: 'runtime interpolation',
        scope: 'component',
        reason: 'unsupported-value',
        provenance,
      });
      diagnostics.push({
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
 * 同一 semantic hash になる (TPL-017)。runtime interpolation は M5 までの
 * stub として residual + warn に落とす。
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
  const residuals: ResidualRuleNode[] = [];
  const diagnostics: Diagnostic[] = [];
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
    return { atoms, residuals, diagnostics };
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
      currentRecord()[item.prop] = item.value;
    } else if (item.kind === 'block') {
      currentRecord()[item.header] = blockToRecord(
        item.items,
        provenance,
        residuals,
        diagnostics,
      );
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
      for (const residual of segment.handle.residuals) residuals.push(residual);
    } else if (segment.kind === 'runtime') {
      pushResidual('runtime interpolation', 'runtime interpolation needs M5 ParametricAtom');
    } else {
      const lowered = lowerStyleObject(
        segment.record as Parameters<typeof lowerStyleObject>[0],
        { source: provenance[0]?.source ?? '<template>' },
      );
      for (const atom of lowered.atoms) atoms.push(atom);
      for (const residual of lowered.residuals) residuals.push(residual);
      for (const diagnostic of lowered.diagnostics) diagnostics.push(diagnostic);
    }
  }
  return { atoms, residuals, diagnostics };
}
