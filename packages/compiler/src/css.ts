import postcss from 'postcss';
import type { AtRule, ChildNode, Declaration, Node, Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import valueParser from 'postcss-value-parser';
import {
  NativeStyleError,
  nativeProperty,
  type NativeGlobal,
  type NativeKeyframes,
  type NativeStyleRule,
  type SelectorPart,
  type SourceSpan,
  type StyleDeclaration,
  type StyleSelector,
  type StyleWrapper,
} from '@qstyle/core';

export interface ParseStyleCssOptions {
  readonly file?: string;
  readonly offset?: number;
}

/**
 * The core keyframe IR deliberately leaves naming to the identity phase. The
 * CSS frontend still has to retain the author name so the lowering phase can
 * resolve animation references without guessing from frame contents.
 */
export interface NamedNativeKeyframes extends NativeKeyframes {
  readonly sourceName: string;
}

export type ParsedNativeGlobal = NativeGlobal | NamedNativeKeyframes;

export interface ParsedStyleCss {
  readonly rules: readonly NativeStyleRule[];
  readonly globals: readonly ParsedNativeGlobal[];
}

/** Decoded fixed class names, counted independently of declaration/rule count. */
export function selectorClassNames(selector: StyleSelector): readonly string[] {
  const names = new Set<string>();
  const text = selector.alternatives.map((parts) => parts.map((part) => part.kind === 'text' ? part.text : '&').join('')).join(',');
  const ast = selectorParser().astSync(text);
  ast.walkClasses((node) => { names.add(node.value); });
  return [...names].sort();
}

interface ParseContext {
  readonly file: string;
  readonly offset: number;
  readonly length: number;
}

const SUBJECT_SELECTOR: StyleSelector = Object.freeze({
  alternatives: Object.freeze([Object.freeze([{ kind: 'subject' as const }])]),
});

const KEYFRAME_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const LAYER_NAME = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

function sourceSpan(context: ParseContext, node: Node, fallbackIndex = 0): SourceSpan {
  const start = node.source?.start?.offset ?? fallbackIndex;
  const end = node.source?.end?.offset ?? start + 1;
  const absoluteStart = context.offset + start;
  const absoluteEnd = context.offset + Math.max(end, start + 1);
  return { file: context.file, start: absoluteStart, end: absoluteEnd };
}

function offsetSpan(context: ParseContext, index: number, width = 1): SourceSpan {
  const start = context.offset + Math.max(0, Math.min(index, context.length));
  return { file: context.file, start, end: start + Math.max(1, width) };
}

function syntaxError(context: ParseContext, message: string, node?: Node, index?: number): never {
  throw new NativeStyleError({
    code: 'QS1101',
    message,
    source: node === undefined
      ? offsetSpan(context, index ?? 0)
      : sourceSpan(context, node, index ?? 0),
  });
}

function rethrowWithSource(error: unknown, context: ParseContext, node: Node, message?: string): never {
  if (error instanceof NativeStyleError) {
    throw new NativeStyleError({
      ...error.diagnostic,
      source: error.diagnostic.source ?? sourceSpan(context, node),
    });
  }
  syntaxError(context, message ?? (error instanceof Error ? error.message : String(error)), node);
}

function validateValueSyntax(context: ParseContext, value: string, node: Node, label: string): void {
  if (value.trim().length === 0) syntaxError(context, `${label} cannot be empty.`, node);
  try {
    const parsed = valueParser(value);
    let malformed = false;
    parsed.walk((token) => {
      if ('unclosed' in token && token.unclosed === true) malformed = true;
    });
    if (malformed) syntaxError(context, `Malformed ${label}.`, node);
  } catch (error) {
    if (error instanceof NativeStyleError) throw error;
    rethrowWithSource(error, context, node, `Malformed ${label}.`);
  }
}

function parseDeclaration(context: ParseContext, node: Declaration, label: string): StyleDeclaration {
  if (node.value.trim().length === 0) syntaxError(context, `${label} has an empty value.`, node);
  let property: string;
  try {
    property = nativeProperty(node.prop);
  } catch (error) {
    rethrowWithSource(error, context, node, `Invalid CSS property ${JSON.stringify(node.prop)}.`);
  }
  // PostCSS keeps the comment-free value in `node.value` and stores the
  // original token spelling in `raws.value.raw` whenever comments required a
  // normalized value. Preserve the raw spelling so comments cannot join or
  // split adjacent CSS tokens when the value is serialized later.
  const value = node.raws.value?.raw ?? node.value;
  validateValueSyntax(context, value, node, `${label} value`);
  return {
    property,
    value: { kind: 'static', css: value },
    important: node.important === true,
  };
}

function parseSelector(context: ParseContext, text: string, node: Rule): StyleSelector {
  let root: ReturnType<ReturnType<typeof selectorParser>['astSync']>;
  try {
    root = selectorParser().astSync(text, { lossless: true });
  } catch (error) {
    rethrowWithSource(error, context, node, 'Malformed nested selector.');
  }
  const rootWithTrailingComma = root as typeof root & { readonly trailingComma?: boolean };
  if (rootWithTrailingComma.trailingComma === true) {
    syntaxError(context, 'A nested selector cannot end with a comma.', node);
  }
  if (root.nodes.length === 0) syntaxError(context, 'A nested selector cannot be empty.', node);

  const alternatives: SelectorPart[][] = [];
  for (const selector of root.nodes) {
    const serialized = selector.toString();
    if (selector.nodes.length === 0 || serialized.trim().length === 0) {
      syntaxError(context, 'A nested selector cannot contain an empty alternative.', node);
    }
    const nestingOffsets: number[] = [];
    selector.walkNesting((nesting) => {
      // sourceIndex points at the structural ampersand. A quoted or escaped
      // ampersand is a string/tag node and never reaches this visitor.
      const local = nesting.sourceIndex - selector.sourceIndex;
      if (local >= 0 && local < serialized.length) nestingOffsets.push(local);
    });
    if (nestingOffsets.length === 0) {
      syntaxError(context, 'Nested selector structure must contain a structural &.', node);
    }
    nestingOffsets.sort((a, b) => a - b);
    const parts: SelectorPart[] = [];
    let cursor = 0;
    for (const offset of nestingOffsets) {
      if (offset < cursor) continue;
      if (offset > cursor) parts.push({ kind: 'text', text: serialized.slice(cursor, offset) });
      parts.push({ kind: 'subject' });
      cursor = offset + 1;
    }
    if (cursor < serialized.length) parts.push({ kind: 'text', text: serialized.slice(cursor) });
    alternatives.push(parts);
  }
  return { alternatives };
}

function selectorText(node: Rule): string {
  // PostCSS removes comments from rule.selector when they occur between
  // tokens. Its raw selector keeps the original spelling and spacing.
  const raw = node.raws.selector;
  return raw?.raw ?? node.selector;
}

/** Replace every structural child `&` with a parent alternative. */
function composeSelector(parent: StyleSelector, child: StyleSelector): StyleSelector {
  const alternatives: SelectorPart[][] = [];
  for (const childAlternative of child.alternatives) {
    let variants: SelectorPart[][] = [[]];
    for (const part of childAlternative) {
      if (part.kind === 'text') {
        for (const variant of variants) variant.push(part);
        continue;
      }
      const next: SelectorPart[][] = [];
      for (const variant of variants) {
        for (const parentAlternative of parent.alternatives) {
          next.push([...variant, ...parentAlternative]);
        }
      }
      variants = next;
    }
    alternatives.push(...variants);
  }
  return { alternatives };
}

function groupSource(context: ParseContext, declarations: readonly Declaration[]): SourceSpan | undefined {
  const first = declarations[0];
  const last = declarations[declarations.length - 1];
  if (first === undefined || last === undefined) return undefined;
  const start = first.source?.start?.offset ?? 0;
  const end = last.source?.end?.offset ?? start + 1;
  return {
    file: context.file,
    start: context.offset + start,
    end: context.offset + Math.max(end, start + 1),
  };
}

function buildRule(
  context: ParseContext,
  selector: StyleSelector,
  wrappers: readonly StyleWrapper[],
  declarations: readonly Declaration[],
): NativeStyleRule {
  const source = groupSource(context, declarations);
  return {
    selector,
    wrappers: [...wrappers],
    declarations: declarations.map((declaration) => parseDeclaration(context, declaration, 'Style declaration')),
    dependencies: [],
    ...(source === undefined ? {} : { source }),
  };
}

function isLayerName(context: ParseContext, params: string, node: AtRule): boolean {
  const name = params.trim();
  return name.length > 0 && LAYER_NAME.test(name);
}

function rawAtRuleParams(node: AtRule): string {
  return node.raws.params?.raw ?? node.params;
}

function parseWrapper(context: ParseContext, node: AtRule): StyleWrapper {
  const kind = node.name.toLowerCase();
  const params = rawAtRuleParams(node).trim();
  if (kind === 'layer') {
    if (!isLayerName(context, params, node)) {
      syntaxError(context, 'Only named @layer blocks are supported.', node);
    }
    return { kind: 'layer', name: params };
  }
  if (params.length === 0) syntaxError(context, `@${kind} requires a condition.`, node);
  validateValueSyntax(context, params, node, `@${kind} condition`);
  if (kind === 'media' || kind === 'supports' || kind === 'container') {
    return { kind, params };
  }
  syntaxError(context, `Unsupported at-rule @${node.name}.`, node);
}

function parseKeyframeName(context: ParseContext, node: AtRule): string {
  const name = rawAtRuleParams(node).trim();
  validateValueSyntax(context, name, node, '@keyframes name');
  if (!KEYFRAME_NAME.test(name)) syntaxError(context, '@keyframes requires one identifier name.', node);
  return name;
}

function validFrameSelector(context: ParseContext, selector: string, node: Rule): string {
  validateValueSyntax(context, selector, node, 'keyframe selector');
  const parts = selector.split(',');
  if (parts.length === 0 || parts.some((part) => {
    const value = part.trim();
    return !/^(?:from|to|\d+(?:\.\d+)?%)$/i.test(value);
  })) {
    syntaxError(context, `Unsupported keyframe selector ${JSON.stringify(selector)}.`, node);
  }
  return selector.trim();
}

function parseKeyframes(
  context: ParseContext, node: AtRule, wrappers: readonly StyleWrapper[] = [],
): NamedNativeKeyframes {
  const sourceName = parseKeyframeName(context, node);
  if (node.nodes === undefined || node.nodes.length === 0) {
    syntaxError(context, '@keyframes cannot be empty.', node);
  }
  const frames: NativeKeyframes['frames'][number][] = [];
  for (const child of node.nodes) {
    if (child.type === 'comment') continue;
    if (child.type !== 'rule') syntaxError(context, '@keyframes may contain only frame rules.', child);
    const frame = child as Rule;
    const declarations: Declaration[] = [];
    for (const frameChild of frame.nodes ?? []) {
      if (frameChild.type === 'comment') continue;
      if (frameChild.type !== 'decl') {
        syntaxError(context, 'Keyframe frames may contain only declarations.', frameChild);
      }
      declarations.push(frameChild as Declaration);
    }
    if (declarations.length === 0) syntaxError(context, 'A keyframe frame cannot be empty.', frame);
    frames.push({
      selector: validFrameSelector(context, frame.selector, frame),
      declarations: declarations.map((declaration) => parseDeclaration(context, declaration, 'Keyframe declaration')),
    });
  }
  if (frames.length === 0) syntaxError(context, '@keyframes cannot be empty.', node);
  return {
    kind: 'keyframes',
    sourceName,
    frames,
    ...(wrappers.length > 0 ? { wrappers: [...wrappers] } : {}),
    source: sourceSpan(context, node),
  };
}

function parseGlobal(
  context: ParseContext, node: AtRule, wrappers: readonly StyleWrapper[] = [],
): ParsedNativeGlobal {
  const kind = node.name.toLowerCase();
  if (node.nodes === undefined || node.nodes.length === 0) {
    syntaxError(context, `@${node.name} cannot be empty.`, node);
  }
  if (kind === 'keyframes') return parseKeyframes(context, node, wrappers);
  if (kind !== 'font-face' && kind !== 'property') {
    syntaxError(context, `Unsupported at-rule @${node.name}.`, node);
  }
  let name = '';
  if (kind === 'property') {
    const params = rawAtRuleParams(node).trim();
    if (params.length === 0) syntaxError(context, '@property requires a custom property name.', node);
    try {
      name = nativeProperty(params);
    } catch (error) {
      rethrowWithSource(error, context, node, 'Invalid @property custom property name.');
    }
    if (!name.startsWith('--')) syntaxError(context, '@property requires a custom property name.', node);
  } else if (rawAtRuleParams(node).trim().length !== 0) {
    syntaxError(context, '@font-face does not accept a prelude.', node);
  }
  const declarations: Declaration[] = [];
  for (const child of node.nodes) {
    if (child.type === 'comment') continue;
    if (child.type !== 'decl') syntaxError(context, `@${kind} may contain only declarations.`, child);
    declarations.push(child as Declaration);
  }
  if (declarations.length === 0) syntaxError(context, `@${kind} cannot be empty.`, node);
  return {
    kind,
    name,
    declarations: declarations.map((declaration) => parseDeclaration(context, declaration, `@${kind} declaration`)),
    ...(wrappers.length > 0 ? { wrappers: [...wrappers] } : {}),
    source: sourceSpan(context, node),
  };
}

interface WalkerState {
  readonly selector: StyleSelector;
  readonly wrappers: readonly StyleWrapper[];
  /** Globals are valid only as direct children of the input root. */
  readonly rootScope: boolean;
}

function walkContainer(
  context: ParseContext,
  nodes: readonly ChildNode[],
  state: WalkerState,
  rules: NativeStyleRule[],
  globals: ParsedNativeGlobal[],
): void {
  let declarations: Declaration[] = [];
  const flush = (): void => {
    if (declarations.length > 0) {
      rules.push(buildRule(context, state.selector, state.wrappers, declarations));
      declarations = [];
    }
  };
  for (const child of nodes) {
    if (child.type === 'comment') continue;
    if (child.type === 'decl') {
      declarations.push(child);
      continue;
    }
    flush();
    if (child.type === 'rule') {
      const nested = child as Rule;
      const parsed = parseSelector(context, selectorText(nested), nested);
      walkContainer(context, nested.nodes ?? [], {
        selector: composeSelector(state.selector, parsed),
        wrappers: state.wrappers,
        rootScope: false,
      }, rules, globals);
      continue;
    }
    if (child.type === 'atrule') {
      const atRule = child as AtRule;
      const name = atRule.name.toLowerCase();
      if (name === 'import' || name === 'scope') {
        syntaxError(context, `Unsupported at-rule @${atRule.name}.`, atRule);
      }
      if (name === 'font-face' || name === 'property' || name === 'keyframes') {
        if (!state.rootScope || state.selector !== SUBJECT_SELECTOR) {
          syntaxError(context, `@${atRule.name} is only supported at the style root or a stylesheet wrapper.`, atRule);
        }
        globals.push(parseGlobal(context, atRule, state.wrappers));
        continue;
      }
      if (name === 'media' || name === 'supports' || name === 'container' || name === 'layer') {
        if (atRule.nodes === undefined) syntaxError(context, `@${atRule.name} requires a block.`, atRule);
        const wrapper = parseWrapper(context, atRule);
        walkContainer(context, atRule.nodes, {
          selector: state.selector,
          wrappers: [...state.wrappers, wrapper],
          rootScope: state.rootScope,
        }, rules, globals);
        continue;
      }
      syntaxError(context, `Unsupported at-rule @${atRule.name}.`, atRule);
    }
    syntaxError(context, 'Unsupported CSS node.', child as Node);
  }
  flush();
}

/**
 * Parse a declaration/nesting CSS body for one local style handle.
 * Top-level declarations use an implicit `&` subject; all explicit nested
 * selectors must contain structural ampersands and are flattened into IR.
 */
export function parseStyleCss(text: string, options: ParseStyleCssOptions = {}): ParsedStyleCss {
  const context: ParseContext = {
    file: options.file ?? '<inline>',
    offset: options.offset ?? 0,
    length: text.length,
  };
  let root: ReturnType<typeof postcss.parse>;
  try {
    root = postcss.parse(text, { from: context.file });
  } catch (error) {
    const details = error as Error & { input?: { offset?: number }; reason?: string };
    const index = details.input?.offset ?? 0;
    syntaxError(context, `Cannot parse CSS: ${details.reason ?? details.message}`, undefined, index);
  }
  const rules: NativeStyleRule[] = [];
  const globals: ParsedNativeGlobal[] = [];
  walkContainer(context, root.nodes, {
    selector: SUBJECT_SELECTOR,
    wrappers: [],
    rootScope: true,
  }, rules, globals);
  return { rules, globals };
}
