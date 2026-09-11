import valueParser from 'postcss-value-parser';
import {
  canonicalGlobal,
  NativeIdentityRegistry,
  NativeStyleError,
  serializeNativeGlobal,
  type NativeGlobal,
  type NativeIdentityNamespace,
  type NativeStyleRule,
  type SourceSpan,
  type StyleDeclaration,
} from '@qstyle/core';
import type { NamedNativeKeyframes, ParsedNativeGlobal } from './css.js';

export interface ResolvedGlobalPayload {
  readonly id: string;
  readonly kind: ParsedNativeGlobal['kind'];
  readonly css: string;
  readonly source?: SourceSpan;
}

export interface ResolvedStyleGlobals {
  readonly rules: readonly NativeStyleRule[];
  readonly globals: readonly ResolvedGlobalPayload[];
}

type ParsedValue = ReturnType<typeof valueParser>;
type ValueNode = ParsedValue['nodes'][number];

/** CSS-wide names and animation keywords which cannot be disambiguated in a shorthand. */
const ANIMATION_KEYWORDS = new Set([
  'normal', 'reverse', 'alternate', 'alternate-reverse', 'none', 'forwards', 'backwards',
  'both', 'running', 'paused', 'infinite', 'initial', 'inherit', 'unset', 'revert', 'revert-layer',
  'ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end',
]);

function sourceOf(global: ParsedNativeGlobal): SourceSpan | undefined {
  return global.source;
}

function fail(
  code: 'QS1101' | 'QS1102' | 'QS1601', message: string,
  source?: SourceSpan, related?: readonly SourceSpan[],
): never {
  throw new NativeStyleError({ code, message, ...(source ? { source } : {}), ...(related?.length ? { related } : {}) });
}

function sourceNameOf(global: ParsedNativeGlobal): string | undefined {
  if (global.kind !== 'keyframes') return undefined;
  const named = global as NamedNativeKeyframes;
  return typeof named.sourceName === 'string' ? named.sourceName : undefined;
}

function isPropertyGlobal(global: ParsedNativeGlobal): global is NativeGlobal & { readonly kind: 'property' } {
  return global.kind === 'property';
}

function rawGlobalError(error: unknown, global: ParsedNativeGlobal): never {
  if (error instanceof NativeStyleError) {
    const source = error.diagnostic.source ?? sourceOf(global);
    throw new NativeStyleError({
      ...error.diagnostic,
      ...(source ? { source } : {}),
    });
  }
  throw error;
}

function isUnclosedNode(node: ValueNode): boolean {
  return 'unclosed' in node && node.unclosed === true;
}

function parseValue(value: string, source: SourceSpan | undefined, label: string): ParsedValue {
  const parsed = valueParser(value);
  let malformed = false;
  parsed.walk((node) => {
    if (isUnclosedNode(node)) malformed = true;
  });
  if (malformed) fail('QS1101', `Malformed ${label}.`, source);
  return parsed;
}

function isTrivia(node: ValueNode): boolean {
  return node.type === 'space' || node.type === 'comment';
}

function splitTopLevel(nodes: readonly ValueNode[]): ValueNode[][] {
  const segments: ValueNode[][] = [[]];
  for (const node of nodes) {
    if (node.type === 'div' && node.value === ',') segments.push([]);
    else segments[segments.length - 1]!.push(node);
  }
  return segments;
}

function meaningful(nodes: readonly ValueNode[]): ValueNode[] {
  return nodes.filter((node) => !isTrivia(node));
}

interface RewrittenAnimation {
  readonly value: string;
  readonly dependencies: readonly string[];
}

function rewriteAnimationName(
  value: string, keyframes: ReadonlyMap<string, string>, source: SourceSpan | undefined,
): RewrittenAnimation {
  const parsed = parseValue(value, source, 'animation-name value');
  const dependencies = new Set<string>();
  for (const segment of splitTopLevel(parsed.nodes)) {
    const tokens = meaningful(segment);
    if (tokens.length === 0) fail('QS1102', 'animation-name cannot contain an empty item.', source);
    if (tokens.length !== 1) {
      fail('QS1102', 'animation-name contains an ambiguous or unsupported item.', source);
    }
    const token = tokens[0]!;
    if (token.type !== 'word' && token.type !== 'string') continue;
    const id = keyframes.get(token.value);
    if (id === undefined || (token.type === 'word' && ANIMATION_KEYWORDS.has(token.value.toLowerCase()))) continue;
    token.value = id;
    dependencies.add(id);
  }
  return { value: valueParser.stringify(parsed.nodes), dependencies: [...dependencies] };
}

function rewriteAnimationShorthand(
  value: string, keyframes: ReadonlyMap<string, string>, source: SourceSpan | undefined,
): RewrittenAnimation {
  const parsed = parseValue(value, source, 'animation value');
  const dependencies = new Set<string>();
  for (const segment of splitTopLevel(parsed.nodes)) {
    const candidates = meaningful(segment).filter((node): node is Extract<ValueNode, { type: 'word' | 'string' }> =>
      (node.type === 'word' || node.type === 'string') && keyframes.has(node.value));
    if (candidates.length > 1) {
      fail('QS1102', 'animation contains more than one possible keyframe name.', source);
    }
    const candidate = candidates[0];
    if (candidate === undefined) continue;
    if (candidate.type === 'word' && ANIMATION_KEYWORDS.has(candidate.value.toLowerCase())) {
      fail('QS1102', `Keyframe name ${JSON.stringify(candidate.value)} is ambiguous in animation shorthand.`, source);
    }
    const id = keyframes.get(candidate.value)!;
    candidate.value = id;
    dependencies.add(id);
  }
  return { value: valueParser.stringify(parsed.nodes), dependencies: [...dependencies] };
}

function firstVarName(node: Extract<ValueNode, { type: 'function' }>): string | undefined {
  if (node.value.toLowerCase() !== 'var') return undefined;
  const first = meaningful(splitTopLevel(node.nodes)[0] ?? [])[0];
  return first?.type === 'word' ? first.value : undefined;
}

function collectVariableReferences(
  value: string, properties: ReadonlyMap<string, string>, source: SourceSpan | undefined,
): readonly string[] {
  const parsed = parseValue(value, source, 'declaration value');
  const dependencies = new Set<string>();
  parsed.walk((node) => {
    if (node.type !== 'function') return;
    const name = firstVarName(node);
    if (name !== undefined) {
      const id = properties.get(name);
      if (id !== undefined) dependencies.add(id);
    }
  });
  return [...dependencies];
}

function globalIdentity(
  global: ParsedNativeGlobal, identities: NativeIdentityRegistry,
): { readonly id: string; readonly namespace: NativeIdentityNamespace; readonly canonical: string } {
  const canonical = canonicalGlobal(global);
  const namespace: NativeIdentityNamespace = global.kind === 'keyframes' ? 'keyframes' : 'global';
  const digest = identities.identify(namespace, canonical, sourceOf(global));
  return {
    namespace,
    canonical,
    id: global.kind === 'keyframes' ? `qk1_${digest}` : digest,
  };
}

function registerGlobals(
  globals: readonly ParsedNativeGlobal[], identities: NativeIdentityRegistry,
): {
  readonly payloads: readonly ResolvedGlobalPayload[];
  readonly keyframes: ReadonlyMap<string, string>;
  readonly properties: ReadonlyMap<string, string>;
  readonly fontFaceIds: readonly string[];
} {
  const payloads: ResolvedGlobalPayload[] = [];
  const byCanonical = new Map<string, ResolvedGlobalPayload>();
  const keyframeNames = new Map<string, { canonical: string; id: string; source?: SourceSpan }>();
  const propertyNames = new Map<string, { canonical: string; id: string; source?: SourceSpan }>();
  const keyframes = new Map<string, string>();
  const properties = new Map<string, string>();
  const fontFaceIds: string[] = [];

  for (const global of globals) {
    const identity = globalIdentity(global, identities);
    const source = sourceOf(global);
    const priorName = sourceNameOf(global);
    if (priorName !== undefined) {
      const previous = keyframeNames.get(priorName);
      if (previous !== undefined && previous.canonical !== identity.canonical) {
        fail('QS1601', `Conflicting @keyframes definitions for source name ${JSON.stringify(priorName)}.`, sourceOf(global), previous.source ? [previous.source] : undefined);
      }
      keyframeNames.set(priorName, {
        canonical: identity.canonical,
        id: identity.id,
        ...(source ? { source } : {}),
      });
      keyframes.set(priorName, identity.id);
    }
    if (isPropertyGlobal(global)) {
      const previous = propertyNames.get(global.name);
      if (previous !== undefined && previous.canonical !== identity.canonical) {
        fail('QS1601', `Conflicting @property definitions for ${JSON.stringify(global.name)}.`, sourceOf(global), previous.source ? [previous.source] : undefined);
      }
      propertyNames.set(global.name, {
        canonical: identity.canonical,
        id: identity.id,
        ...(source ? { source } : {}),
      });
      properties.set(global.name, identity.id);
    }

    if (!byCanonical.has(`${identity.namespace}:${identity.canonical}`)) {
      let css: string;
      try {
        css = serializeNativeGlobal(global, identities, global.kind === 'keyframes' ? identity.id : undefined);
      } catch (error) {
        rawGlobalError(error, global);
      }
      const payload: ResolvedGlobalPayload = { id: identity.id, kind: global.kind, css, ...(source ? { source } : {}) };
      byCanonical.set(`${identity.namespace}:${identity.canonical}`, payload);
      payloads.push(payload);
      if (global.kind === 'font-face') fontFaceIds.push(identity.id);
    } else if (global.kind === 'font-face') {
      // Identical font faces may repeat after a competing face. Keep the final
      // occurrence's position, since source order participates in face matching.
      const index = payloads.findIndex((payload) => payload.id === identity.id);
      if (index >= 0) payloads.push(...payloads.splice(index, 1));
      if (!fontFaceIds.includes(identity.id)) fontFaceIds.push(identity.id);
    }
  }
  return { payloads, keyframes, properties, fontFaceIds };
}

function rewriteRule(
  rule: NativeStyleRule,
  keyframes: ReadonlyMap<string, string>,
  properties: ReadonlyMap<string, string>,
  fontFaceIds: readonly string[],
): NativeStyleRule {
  const dependencies = new Set<string>(rule.dependencies);
  const declarations: StyleDeclaration[] = [];
  for (const declaration of rule.declarations) {
    if (declaration.value.kind !== 'static') {
      if (declaration.property === 'animation' || declaration.property === 'animation-name') {
        fail('QS1102', `Dynamic ${declaration.property} cannot be resolved to a static keyframe identity.`, rule.source);
      }
      declarations.push(declaration);
      continue;
    }
    let value = declaration.value.css;
    if (declaration.property === 'animation-name') {
      const rewritten = rewriteAnimationName(value, keyframes, rule.source);
      value = rewritten.value;
      rewritten.dependencies.forEach((id) => dependencies.add(id));
    } else if (declaration.property === 'animation') {
      const rewritten = rewriteAnimationShorthand(value, keyframes, rule.source);
      value = rewritten.value;
      rewritten.dependencies.forEach((id) => dependencies.add(id));
    }
    collectVariableReferences(value, properties, rule.source).forEach((id) => dependencies.add(id));
    if (declaration.property.startsWith('--')) {
      const id = properties.get(declaration.property);
      if (id !== undefined) dependencies.add(id);
    }
    if (declaration.property === 'font' || declaration.property === 'font-family') {
      fontFaceIds.forEach((id) => dependencies.add(id));
    }
    declarations.push(value === declaration.value.css
      ? declaration
      : { ...declaration, value: { kind: 'static', css: value } });
  }
  return { ...rule, declarations, dependencies: [...dependencies] };
}

/** Canonicalize static globals, rename keyframes, and attach global dependencies to rules. */
export function resolveStyleGlobals(
  rules: readonly NativeStyleRule[], globals: readonly ParsedNativeGlobal[],
  identities: NativeIdentityRegistry = new NativeIdentityRegistry(),
): ResolvedStyleGlobals {
  const registered = registerGlobals(globals, identities);
  return {
    rules: rules.map((rule) => rewriteRule(
      rule, registered.keyframes, registered.properties, registered.fontFaceIds,
    )),
    globals: registered.payloads,
  };
}
