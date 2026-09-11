import { canonicalDeclaration, canonicalStyleValue, normalizeStyleSelector } from './canonical.js';
import { NativeIdentityRegistry, nativeSlotName } from './identity.js';
import { NativeStyleError } from './native-diagnostic.js';
import { nativeProperty } from './native-values.js';
import type {
  DeclarationDefinition, NativeGlobal, NativeKeyframes, NativeStyleRule,
  StyleDeclaration, StyleSelector, StyleWrapper,
} from './native-ir.js';

export function slotSchema(declaration: StyleDeclaration): string {
  return JSON.stringify([declaration.property, canonicalStyleValue(declaration.value)]);
}

export function declarationSlotName(
  declaration: StyleDeclaration, registry: NativeIdentityRegistry, contextSchema?: string,
): string | undefined {
  return declaration.value.kind === 'slot'
    ? nativeSlotName(contextSchema ?? slotSchema(declaration), declaration.value.index, registry)
    : undefined;
}

export function serializeNativeDeclaration(
  declaration: StyleDeclaration, registry: NativeIdentityRegistry, contextSchema?: string,
): string {
  const property = nativeProperty(declaration.property);
  const value = declaration.value;
  const css = value.kind === 'static' ? value.css
    : `var(${declarationSlotName(declaration, registry, contextSchema)}${value.fallback === undefined ? '' : `,${value.fallback}`})`;
  return `${property}:${css}${declaration.important ? '!important' : ''};`;
}

/** All generated class selectors have equal specificity, including inside :is(). */
export function serializeNativeSelector(selector: StyleSelector, classNames: readonly string[]): string {
  const classes = [...new Set(classNames)].sort();
  if (classes.some((name) => !/^q1_[a-f0-9]{32}$/.test(name))) {
    throw new NativeStyleError({ code: 'QS1101', message: 'Native selectors require registered q1 class names.' });
  }
  if (!classes.length) {
    throw new NativeStyleError({ code: 'QS1101', message: 'A local style declaration requires an applying class.' });
  }
  const output: string[] = [];
  for (const parts of normalizeStyleSelector(selector).alternatives) {
    const subjects = parts.filter((part) => part.kind === 'subject').length;
    if (!subjects) {
      throw new NativeStyleError({ code: 'QS1101', message: 'A local style selector must contain a parsed subject.' });
    }
    if (subjects === 1) {
      for (const name of classes) output.push(parts.map((part) => part.kind === 'subject' ? `.${name}` : part.text).join(''));
    } else {
      const subject = classes.length === 1 ? `.${classes[0]}` : `:is(${classes.map((name) => `.${name}`).join(',')})`;
      output.push(parts.map((part) => part.kind === 'subject' ? subject : part.text).join(''));
    }
  }
  return [...new Set(output)].join(',');
}

export function wrapNativeCss(css: string, wrappers: readonly StyleWrapper[]): string {
  for (let index = wrappers.length - 1; index >= 0; index--) {
    const wrapper = wrappers[index]!;
    css = wrapper.kind === 'layer'
      ? `@layer ${wrapper.name}{${css}}`
      : `@${wrapper.kind} ${wrapper.params}{${css}}`;
  }
  return css;
}

export function serializeNativeRule(
  rule: NativeStyleRule, classNames: readonly string[], registry: NativeIdentityRegistry,
): string {
  const fixed = rule.selector.alternatives.length > 0 && rule.selector.alternatives.every((parts) => parts.every((part) => part.kind === 'text'));
  if (fixed && rule.declarations.some((declaration) => declaration.value.kind !== 'static')) {
    throw new NativeStyleError({ code: 'QS1102', message: 'Fixed selector declarations must be static.' });
  }
  const selector = fixed ? rule.selector.alternatives.map((parts) => parts.map((part) => part.kind === 'text' ? part.text : '').join('')).join(',')
    : serializeNativeSelector(rule.selector, classNames);
  return wrapNativeCss(`${selector}{${rule.declarations
    .map((declaration) => serializeNativeDeclaration(declaration, registry, canonicalDeclaration({
      selector: rule.selector, wrappers: rule.wrappers, declaration, dependencies: rule.dependencies,
    }))).join('')}}`, rule.wrappers);
}

/** Inline variable assignment must use exactly the same context schema as CSS emission. */
export function definitionSlotName(definition: DeclarationDefinition, registry: NativeIdentityRegistry): string | undefined {
  return declarationSlotName(definition.declaration, registry, canonicalDeclaration(definition));
}

export function serializeDeclarationDefinition(
  definition: DeclarationDefinition, classNames: readonly string[], registry: NativeIdentityRegistry,
): string {
  return serializeNativeRule({ ...definition, declarations: [definition.declaration] }, classNames, registry);
}

export function serializeNativeGlobal(
  global: NativeGlobal | NativeKeyframes, registry: NativeIdentityRegistry, name?: string,
): string {
  const declarations = (values: readonly StyleDeclaration[]): string => {
    if (values.some((value) => value.value.kind !== 'static')) {
      throw new NativeStyleError({ code: 'QS1102', message: 'Global declarations and keyframes must be static.' });
    }
    return values.map((value) => serializeNativeDeclaration(value, registry)).join('');
  };
  if (global.kind === 'keyframes') {
    if (!name || !/^qk1_[a-f0-9]{32}$/.test(name)) {
      throw new NativeStyleError({ code: 'QS1101', message: 'Keyframes require a registered content identity.' });
    }
    return wrapNativeCss(
      `@keyframes ${name}{${global.frames.map((frame) => `${frame.selector}{${declarations(frame.declarations)}}`).join('')}}`,
      global.wrappers ?? [],
    );
  }
  if (global.kind === 'property') nativeProperty(global.name);
  return wrapNativeCss(
    `@${global.kind}${global.name ? ` ${global.name}` : ''}{${declarations(global.declarations)}}`,
    global.wrappers ?? [],
  );
}
