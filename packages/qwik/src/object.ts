import { createStaticAtom } from '@qstyle/core';
import type {
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
}

export interface LowerOptions {
  readonly source?: string | undefined;
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
}

function warn(sink: Sink, message: string): void {
  sink.diagnostics.push({ severity: 'warn', message });
}

function lowerInto(
  record: Record<string, unknown>,
  context: RuleContext,
  provenance: readonly Provenance[],
  sink: Sink,
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
      if (typeof value === 'number') {
        sink.atoms.push(
          createStaticAtom({ property: key, value, context, provenance }),
        );
        continue;
      }
      const split: ImportantSplit = splitImportant(value);
      sink.atoms.push(
        createStaticAtom({
          property: key,
          value: split.value,
          important: split.important,
          context,
          provenance,
        }),
      );
      continue;
    }

    if (key.startsWith('&')) {
      if (!isPlainObject(value)) {
        sink.residuals.push({
          kind: 'residual-rule',
          cssText: key,
          scope: 'component',
          reason: 'unsupported-selector',
          provenance,
        });
        warn(sink, `unsupported nested selector value for ${JSON.stringify(key)}`);
        continue;
      }
      const pseudo: string | null = extractPseudo(key);
      if (pseudo === null) {
        sink.residuals.push({
          kind: 'residual-rule',
          cssText: key,
          scope: 'component',
          reason: 'unsupported-selector',
          provenance,
        });
        warn(sink, `unsupported nested selector ${JSON.stringify(key)}`);
        continue;
      }
      lowerInto(
        value,
        { ...context, pseudo: [...(context.pseudo ?? []), pseudo] },
        provenance,
        sink,
      );
      continue;
    }

    if (key.startsWith('@')) {
      if (!isPlainObject(value)) {
        sink.residuals.push({
          kind: 'residual-rule',
          cssText: key,
          scope: 'component',
          reason: 'unsupported-at-rule',
          provenance,
        });
        warn(sink, `unsupported at-rule value for ${JSON.stringify(key)}`);
        continue;
      }
      const lowered: string = key.toLowerCase();
      if (lowered.startsWith('@media')) {
        const condition: string = key.slice('@media'.length).trim();
        lowerInto(value, { ...context, media: condition }, provenance, sink);
        continue;
      }
      if (lowered.startsWith('@supports')) {
        const condition: string = key.slice('@supports'.length).trim();
        lowerInto(value, { ...context, supports: condition }, provenance, sink);
        continue;
      }
      if (lowered.startsWith('@container')) {
        const condition: string = key.slice('@container'.length).trim();
        lowerInto(value, { ...context, container: condition }, provenance, sink);
        continue;
      }
      sink.residuals.push({
        kind: 'residual-rule',
        cssText: key,
        scope: 'component',
        reason: 'unsupported-at-rule',
        provenance,
      });
      warn(sink, `unsupported at-rule ${JSON.stringify(key)}`);
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
 */
export function lowerStyleObject(
  style: StyleObject,
  opts: LowerOptions = {},
): LoweredStyle {
  const source: string = opts.source ?? '<inline>';
  const provenance: readonly Provenance[] = [{ source, line: 1, column: 1 }];
  const sink: Sink = { atoms: [], residuals: [], diagnostics: [] };
  lowerInto(style as Record<string, unknown>, {}, provenance, sink);
  return { atoms: sink.atoms, residuals: sink.residuals, diagnostics: sink.diagnostics };
}
