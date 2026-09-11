import type {
  DeclarationDefinition, NativeGlobal, NativeKeyframes, NativeStyleRule,
  SelectorPart, StyleDeclaration, StyleSelector, StyleValue, StyleWrapper,
} from './native-ir.js';

export const CANONICAL_VERSION: string = 'qstyle-native-1';

/** CSS token spelling is retained. Only fields without semantic order are sorted. */
export function canonicalStyleValue(value: StyleValue): readonly unknown[] {
  return value.kind === 'static'
    ? ['static', value.css]
    : ['slot', value.index, value.unit, value.fallback ?? null];
}

export function canonicalStyleDeclaration(declaration: StyleDeclaration): readonly unknown[] {
  return [declaration.property, canonicalStyleValue(declaration.value), declaration.important];
}

export function canonicalStyleSelector(selector: StyleSelector): readonly unknown[] {
  return normalizeStyleSelector(selector).alternatives.map((parts) => parts.map((part) =>
    part.kind === 'subject' ? ['subject'] : ['text', part.text]));
}

/** Parser/flattening boundaries do not distinguish otherwise identical token text. */
export function normalizeStyleSelector(selector: StyleSelector): StyleSelector {
  return { alternatives: selector.alternatives.map((original) => {
    const parts: SelectorPart[] = [];
    for (const part of original) {
      if (part.kind === 'subject') { parts.push(part); continue; }
      const previous = parts.at(-1);
      if (previous?.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: previous.text + part.text };
      else if (part.text) parts.push({ ...part });
    }
    const first = parts[0];
    if (first?.kind === 'text') parts[0] = { kind: 'text', text: first.text.trimStart() };
    const last = parts.at(-1);
    if (last?.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text.trimEnd() };
    return parts.filter((part) => part.kind !== 'text' || part.text !== '');
  }) };
}

export function canonicalStyleWrappers(wrappers: readonly StyleWrapper[]): readonly unknown[] {
  return wrappers.map((wrapper) => wrapper.kind === 'layer'
    ? ['layer', wrapper.name]
    : [wrapper.kind, wrapper.params]);
}

export function canonicalRule(rule: NativeStyleRule): string {
  return JSON.stringify([
    CANONICAL_VERSION, 'rule', canonicalStyleSelector(rule.selector),
    canonicalStyleWrappers(rule.wrappers), rule.declarations.map(canonicalStyleDeclaration),
    [...new Set(rule.dependencies)].sort(),
  ]);
}

export function canonicalDeclaration(definition: DeclarationDefinition): string {
  return JSON.stringify([
    CANONICAL_VERSION, 'declaration', canonicalStyleSelector(definition.selector),
    canonicalStyleWrappers(definition.wrappers),
    canonicalStyleDeclaration(definition.declaration),
  ]);
}

export function canonicalGlobal(global: NativeGlobal | NativeKeyframes): string {
  const wrappers = canonicalStyleWrappers(global.wrappers ?? []);
  if (global.kind === 'keyframes') {
    return JSON.stringify([CANONICAL_VERSION, global.kind,
      wrappers,
      global.frames.map((frame) => [frame.selector, frame.declarations.map(canonicalStyleDeclaration)])]);
  }
  return JSON.stringify([
    CANONICAL_VERSION, global.kind, wrappers, global.name,
    global.declarations.map(canonicalStyleDeclaration),
  ]);
}
