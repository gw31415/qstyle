import MagicString from 'magic-string';
import type { Binding, NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { NativeIdentityRegistry, NativeStyleError, definitionSlotName, type OptimizedStyleProgram } from '@qstyle/core';
import {
  collectCssPropSites,
  findComponentOwner,
  isCssMacro,
  validateAuthoringUses,
  type ComponentOwner,
  type CssPropSite,
} from './bindings.js';
import { composeRuleContributions, emitStyleEvaluation, planStyleSite, type StyleSitePlan } from './compose.js';
import { analyzeClassValues, type FiniteClassValues } from './class-values.js';
import type { UtilityCssNode, UtilityRequest, UtilityState } from './utility-contract.js';
import { evaluateStatic } from './evaluate.js';
import { lowerStyleExpression, lowerStoredStyleExpression, type LowerStyleOptions, type StyleExpression } from './lower.js';
import { parseStyleModule, sourceSpan, type ParsedStyleModule } from './parse.js';

export interface AnalyzedStyleSite {
  readonly source: StyleSiteSource;
  readonly plan: StyleSitePlan;
  /** Original CSS plan: runtime evaluation must not replay class predicates. */
  readonly cssPlan?: StyleSitePlan;
  readonly classValues?: FiniteClassValues;
  readonly utilities?: readonly UtilityState[];
}

export interface AnalyzeStyleModuleOptions extends LowerStyleOptions {
  readonly utilities?: boolean;
}

interface StyleSiteOccurrence {
  /** The JSX attribute or spread that supplied this css value. */
  readonly node: t.Node;
  readonly expression: NodePath<t.Expression>;
}

interface StyleSiteSource {
  readonly id: string;
  readonly owner: ComponentOwner;
  readonly opening: NodePath<t.JSXOpeningElement>;
  readonly occurrences: readonly StyleSiteOccurrence[];
  readonly classExpression?: NodePath<t.Expression>;
}

export interface AnalyzedStyleModule {
  readonly module: ParsedStyleModule;
  readonly sites: readonly AnalyzedStyleSite[];
  readonly macros: readonly NodePath<t.CallExpression | t.TaggedTemplateExpression>[];
  readonly foundation?: { readonly opening: NodePath<t.JSXOpeningElement>; readonly demandId: string };
}

/** The graph supplies a head reached from a verified application render entry. */
export function attachUtilityFoundation(analysis: AnalyzedStyleModule, opening: NodePath<t.JSXOpeningElement>): AnalyzedStyleModule {
  return { ...analysis, foundation: { opening, demandId: `${analysis.module.file}#foundation` } };
}

function hasRuntime(expression: StyleExpression): boolean {
  return expression.kind === 'choice' || (expression.kind === 'style'
    ? expression.value.inputs.length > 0 : expression.items.some(hasRuntime));
}

interface StaticSpreadEntry {
  readonly key: string;
  readonly value: NodePath<t.Expression>;
}

/**
 * Return the source expression for each final own key of a statically known
 * object.  `evaluateStatic` proves that a spread has a fixed shape; this
 * companion keeps the source path needed to lower a `css` value from that
 * spread without evaluating application code during the build.
 */
function staticSpreadEntries(
  path: NodePath<t.Expression>, module: ParsedStyleModule, seen: Set<t.Node> = new Set(),
): readonly StaticSpreadEntry[] | undefined {
  if (seen.has(path.node)) return undefined;
  seen.add(path.node);
  try {
    if (path.isTSAsExpression() || path.isTSSatisfiesExpression() || path.isTSNonNullExpression()
      || path.isTypeCastExpression() || path.isParenthesizedExpression()) {
      const expression = path.get('expression');
      return expression.isExpression() ? staticSpreadEntries(expression, module, seen) : undefined;
    }
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding?.constant || binding.kind !== 'const' || !binding.path.isVariableDeclarator()) return undefined;
      const init = binding.path.get('init');
      return init.isExpression() ? staticSpreadEntries(init, module, seen) : undefined;
    }
    if (path.isConditionalExpression()) {
      const test = evaluateStatic(path.get('test'), module);
      if (test.kind !== 'literal') return undefined;
      const branch = test.value ? path.get('consequent') : path.get('alternate');
      return branch.isExpression() ? staticSpreadEntries(branch, module, seen) : undefined;
    }
    if (path.isLogicalExpression()) {
      const left = evaluateStatic(path.get('left'), module);
      if (left.kind !== 'literal') return undefined;
      const useRight = path.node.operator === '&&' ? Boolean(left.value) : !left.value;
      if (!useRight) return staticSpreadEntries(path.get('left'), module, seen);
      return staticSpreadEntries(path.get('right'), module, seen);
    }
    if (!path.isObjectExpression()) return undefined;

    const byKey = new Map<string, NodePath<t.Expression>>();
    const properties = path.get('properties') as NodePath<t.Node>[];
    const keyOf = (property: NodePath<t.ObjectProperty>): string | undefined => {
      if (!property.node.computed) {
        const key = property.node.key;
        if (key.type === 'Identifier') return key.name;
        if (key.type === 'StringLiteral' || key.type === 'NumericLiteral') return String(key.value);
        return undefined;
      }
      const key = property.get('key');
      if (!key.isExpression()) return undefined;
      const evaluated = evaluateStatic(key, module);
      if (evaluated.kind !== 'literal') return undefined;
      return String(evaluated.value);
    };
    for (const property of properties) {
      if (property.isSpreadElement()) {
        const argument = property.get('argument');
        if (!argument.isExpression()) return undefined;
        const nested = staticSpreadEntries(argument, module, seen);
        if (!nested) return undefined;
        for (const entry of nested) byKey.set(entry.key, entry.value);
        continue;
      }
      if (!property.isObjectProperty()) return undefined;
      const key = keyOf(property);
      const value = property.get('value');
      if (key === undefined || !value.isExpression()) return undefined;
      byKey.set(key, value);
    }
    return [...byKey].map(([key, value]) => ({ key, value }));
  } finally {
    seen.delete(path.node);
  }
}

function isStyleTarget(opening: NodePath<t.JSXOpeningElement>): boolean {
  const tag = opening.node.name;
  return tag.type === 'JSXIdentifier' && /^[a-z]/.test(tag.name);
}

function knownSpread(
  argument: NodePath<t.Expression>, module: ParsedStyleModule,
): readonly StaticSpreadEntry[] {
  const value = evaluateStatic(argument, module, { allowStoredStructuralValues: true });
  if (value.kind !== 'object') {
    throw new NativeStyleError({ code: 'QS1102', message: 'JSX spread keys must be statically known.',
      source: sourceSpan(module.file, argument.node) });
  }
  const entries = staticSpreadEntries(argument, module);
  if (!entries) {
    throw new NativeStyleError({ code: 'QS1102', message: 'JSX spread keys must be statically known.',
      source: sourceSpan(module.file, argument.node) });
  }
  return entries;
}

function collectStyleSites(module: ParsedStyleModule, utilities = false): readonly StyleSiteSource[] {
  const explicit = collectCssPropSites(module);
  const byAttribute = new Map<t.Node, CssPropSite>();
  for (const site of explicit) byAttribute.set(site.attribute.node, site);

  const sites: StyleSiteSource[] = [];
  module.program.traverse({
    JSXOpeningElement(opening) {
      const occurrences: StyleSiteOccurrence[] = [];
      let owner: ComponentOwner | undefined;
      let classExpression: NodePath<t.Expression> | undefined;
      let hasClass = false;
      const hasCssAttribute = opening.get('attributes').some((attribute) =>
        attribute.isJSXAttribute() && attribute.node.name.type === 'JSXIdentifier' && attribute.node.name.name === 'css');
      for (const attribute of opening.get('attributes')) {
        if (attribute.isJSXAttribute()) {
          if (utilities && isStyleTarget(opening) && attribute.node.name.type === 'JSXIdentifier'
            && ['class', 'className'].includes(attribute.node.name.name)) {
            hasClass = true;
            const value = attribute.get('value');
            const expression = value.isJSXExpressionContainer() ? value.get('expression') : value;
            classExpression = expression.isExpression() ? expression : undefined;
          }
          const site = byAttribute.get(attribute.node);
          if (!site) continue;
          occurrences.push({ node: attribute.node, expression: site.expression });
          owner ??= site.owner;
          continue;
        }
        const argument = attribute.get('argument');
        if (!argument.isExpression()) {
          if (owner) throw new NativeStyleError({ code: 'QS1102', message: 'JSX spread keys must be statically known.',
            source: sourceSpan(module.file, attribute.node) });
          continue;
        }
        const value = evaluateStatic(argument, module, { allowStoredStructuralValues: true });
        if (value.kind !== 'object') {
          if (owner || hasCssAttribute || isStyleTarget(opening)) throw new NativeStyleError({ code: 'QS1102', message: 'JSX spread keys must be statically known.',
            source: sourceSpan(module.file, attribute.node) });
          continue;
        }
        const entries = knownSpread(argument, module);
        if (utilities && isStyleTarget(opening)) for (const entry of entries) {
          if (entry.key === 'class' || entry.key === 'className') { hasClass = true; classExpression = entry.value; }
        }
        const css = entries.find((entry) => entry.key === 'css');
        if (!css) continue;
        if (!isStyleTarget(opening)) {
          throw new NativeStyleError({ code: 'QS1103', message: 'Apply css to a DOM element, not a component or Slot.',
            source: sourceSpan(module.file, opening.node) });
        }
        occurrences.push({ node: attribute.node, expression: css.value });
        owner ??= findComponentOwner(opening, module);
      }
      if (!occurrences.length && !hasClass) return;
      sites.push({ id: `${module.file}#element:${sites.length}`, owner: owner ?? findComponentOwner(opening, module),
        opening, occurrences, ...(classExpression ? { classExpression } : {}) });
    },
  });
  return sites;
}

function isMacroReference(path: NodePath<t.Node>): boolean {
  const parent = path.parentPath;
  if (parent?.isCallExpression() && parent.node.callee === path.node) return true;
  if (parent?.isTaggedTemplateExpression() && parent.node.tag === path.node) return true;
  if (parent?.isMemberExpression() && !parent.node.computed && parent.node.object === path.node
    && parent.node.property.type === 'Identifier' && parent.node.property.name === 'css') {
    const outer = parent.parentPath;
    return (outer?.isCallExpression() && outer.node.callee === parent.node)
      || (outer?.isTaggedTemplateExpression() && outer.node.tag === parent.node);
  }
  return false;
}

/** A macro binding is callable only at a directly recognized css site. */
function validateCssMacroEscapes(module: ParsedStyleModule): void {
  const checked = new Set<Binding>();
  const fail = (path: NodePath<t.Node>): never => {
    throw new NativeStyleError({ code: 'QS1102', message: 'The css macro binding escapes into runtime code.',
      source: sourceSpan(module.file, path.node), fixHint: 'Call css directly in a compile-time style expression.' });
  };
  const inspect = (binding: Binding): void => {
    if (checked.has(binding)) return;
    checked.add(binding);
    for (const reference of binding.referencePaths) {
      if (!isMacroReference(reference)) fail(reference);
    }
  };
  module.program.traverse({
    ImportDeclaration(path) {
      if (path.node.source.value !== '@qstyle/qwik') return;
      for (const specifier of path.get('specifiers')) {
        const local = specifier.node.local;
        const binding = path.scope.getBinding(local.name);
        if (!binding) continue;
        if (specifier.isImportSpecifier()) {
          const imported = specifier.node.imported;
          if ((imported.type === 'Identifier' ? imported.name : imported.value) === 'css') inspect(binding);
        } else if (specifier.isImportNamespaceSpecifier()) {
          // Namespace references are checked through `styles.css(...)` in
          // isMacroReference; using the namespace itself still escapes.
          inspect(binding);
        }
      }
    },
  });
}

/** The same analysis is retained from whole-graph discovery through final emission. */
export function analyzeStyleModule(code: string, file: string, options: AnalyzeStyleModuleOptions = {}): AnalyzedStyleModule {
  const module = parseStyleModule(code, file);
  validateCssMacroEscapes(module);
  validateAuthoringUses(module);
  const owners = new Map<t.Node, string>();
  const sites = collectStyleSites(module, options.utilities).map((source): AnalyzedStyleSite => {
    let owner = owners.get(source.owner.callback.node);
    if (!owner) { owner = `${file}#owner:${owners.size}`; owners.set(source.owner.callback.node, owner); }
    // JSX applies the final `css` property write. Composition arrays inside
    // that value are lowered separately by lowerStyleExpression.
    const last = source.occurrences[source.occurrences.length - 1];
    const expression: StyleExpression = last ? lowerStyleExpression(last.expression, module, options) : { kind: 'sequence', items: [] };
    return { source, plan: planStyleSite(expression, source.id, owner), ...(options.utilities ? {
      classValues: source.classExpression ? analyzeClassValues(source.classExpression, module) : { values: [''], tokens: [[]] },
    } : {}) };
  });
  const macros: NodePath<t.CallExpression | t.TaggedTemplateExpression>[] = [];
  const collect = (path: NodePath<t.CallExpression | t.TaggedTemplateExpression>): void => {
    const occurrence = sites.flatMap((site) => site.source.occurrences).find((candidate) =>
      path.node.start! >= candidate.node.start! && path.node.end! <= candidate.node.end!);
    if (occurrence) {
      // The final explicit css attribute is removed with its opening element,
      // so its macro call never reaches runtime. A macro inside a spread is
      // retained in the generated spread expression and must be erased.
      const isExplicit = occurrence.node.type === 'JSXAttribute';
      const finalOccurrence = sites.some((site) => site.source.occurrences[site.source.occurrences.length - 1]?.node === occurrence.node);
      if (isExplicit && finalOccurrence) return;
      if (!macros.some((outer) => path.node.start! >= outer.node.start! && path.node.end! <= outer.node.end!)) macros.push(path);
      return;
    }
    const lowered = lowerStyleExpression(path as NodePath<t.Expression>, module, options);
    if (hasRuntime(lowered)) throw new NativeStyleError({ code: 'QS1102',
      message: 'A reusable or unused css macro must be entirely static.', source: sourceSpan(file, path.node) });
    if (!macros.some((outer) => path.node.start! >= outer.node.start! && path.node.end! <= outer.node.end!)) macros.push(path);
  };
  module.program.traverse({
    CallExpression(path) { if (isCssMacro(path.get('callee'))) collect(path); },
    TaggedTemplateExpression(path) { if (isCssMacro(path.get('tag'))) collect(path); },
  });
  return { module, sites, macros };
}

export function utilityRequests(analysis: AnalyzedStyleModule): readonly UtilityRequest[] {
  return analysis.sites.flatMap((site) => site.classValues?.tokens.map((tokens, index) => ({
    id: `${site.plan.id}/class:${index}`, tokens,
  })) ?? []);
}

/** Utility order is the adapter order; CSS contributions follow it regardless of JSX attribute order. */
export function composeUtilityStates(
  analysis: AnalyzedStyleModule, resolved: ReadonlyMap<string, UtilityState>, maxStates = 256,
): AnalyzedStyleModule {
  return { ...analysis, sites: analysis.sites.map((site) => {
    if (!site.classValues) return site;
    const cssPlan = site.cssPlan ?? site.plan;
    const utilities = site.classValues.values.map((_, index) => {
      const id = `${cssPlan.id}/class:${index}`;
      const state = resolved.get(id);
      if (!state) throw new NativeStyleError({ code: 'QS1401', message: `Missing utility resolution for ${id}.` });
      return state;
    });
    if (utilities.length * cssPlan.states.length > maxStates) throw new NativeStyleError({ code: 'QS1602',
      message: `Style site ${cssPlan.id} exceeds the exact combined class/CSS state limit (${maxStates}).` });
    const alternatives = utilities.flatMap((utility) => cssPlan.alternatives.map((css) => ({
      rules: composeRuleContributions(utility.nodes.flatMap((node) => node.kind === 'local' ? [node.rule] : []), css.rules),
      globals: [...utility.nodes.flatMap((node) => node.kind === 'global' ? [{ ...node.value, wrappers: node.wrappers }] : []), ...css.globals],
    })));
    const states = alternatives.map((alternative, index) => ({ id: `${cssPlan.id}/state:${index}`, rules: alternative.rules,
      demand: { ...cssPlan.states[index % cssPlan.states.length]!.demand, id: `${cssPlan.id}/state:${index}`,
        styleState: String(index), predicate: `choice(${cssPlan.id})=${index}` },
    }));
    return { ...site, cssPlan, utilities, plan: { ...cssPlan, alternatives, states } };
  }) };
}

/** Fixed selectors and statements retain the same render demand as their utility state. */
export function utilityAuxiliaryNodes(site: AnalyzedStyleSite, stateIndex: number): readonly UtilityCssNode[] {
  const utility = site.utilities?.[Math.floor(stateIndex / (site.cssPlan?.states.length ?? 1))];
  return utility?.nodes.filter((node) => node.kind === 'global-rule' || node.kind === 'layer-order') ?? [];
}

export interface EmitStyleModuleOptions {
  readonly packModule?: (packId: string) => string;
  readonly dev?: boolean;
}

/** Emit ordinary TSX for the Qwik optimizer, preserving attribute evaluation order. */
export function emitStyleModule(
  analysis: AnalyzedStyleModule, program: OptimizedStyleProgram, options: EmitStyleModuleOptions = {},
): { code: string; map: ReturnType<MagicString['generateMap']> } {
  const { module } = analysis;
  const edits = new MagicString(module.code);
  let prefix = '__qstyle';
  while (module.code.includes(prefix)) prefix += '_';
  let ordinal = 0;
  const fresh = (kind: string): string => `${prefix}_${kind}${ordinal++}`;
  const packNames = new Map<string, string>();
  const packName = (pack: string): string => {
    let name = packNames.get(pack);
    if (!name) { name = fresh('Pack'); packNames.set(pack, name); }
    return name;
  };
  const fail: (node: t.Node, message: string) => never = (node, message) => {
    throw new NativeStyleError({ code: 'QS1102', message, source: sourceSpan(module.file, node) });
  };
  const read = (node: t.Node): string => module.code.slice(node.start!, node.end!);
  const readGenerated = (
    node: t.Node,
    extraReplacements: readonly { readonly node: t.Node; readonly text: string }[] = [],
  ): string => {
    const start = node.start!;
    const end = node.end!;
    const replacements = [
      ...analysis.macros.map((macro) => ({ node: macro.node, text: 'void 0' })),
      ...extraReplacements,
    ].filter(({ node: candidate }) => candidate.start! >= start && candidate.end! <= end)
      .sort((left, right) => left.node.start! - right.node.start!);
    if (!replacements.length) return read(node);
    let cursor = start;
    let generated = '';
    for (const replacement of replacements) {
      const replacementStart = replacement.node.start!;
      const replacementEnd = replacement.node.end!;
      if (replacementStart < cursor) continue;
      generated += module.code.slice(cursor, replacementStart);
      generated += replacement.text;
      cursor = replacementEnd;
    }
    return generated + module.code.slice(cursor, end);
  };
  const checkStyle = (path: NodePath<t.Expression>): void => {
    const value = evaluateStatic(path, module);
    if (value.kind === 'literal' && (value.value == null || typeof value.value === 'string')) {
      if (typeof value.value === 'string' && /--qstyle-/.test(value.value)) fail(path.node, 'The --qstyle- variable namespace is reserved.');
      return;
    }
    if (value.kind === 'object') {
      for (const [key] of value.entries) if (key.startsWith('--qstyle-')) fail(path.node, 'The --qstyle- variable namespace is reserved.');
      return;
    }
    fail(path.node, 'The explicit style attribute must have statically known keys or a static CSS string.');
  };
  for (const { source, plan, cssPlan = plan, classValues, utilities } of analysis.sites) {
    const element = source.opening.parentPath;
    if (!element.isJSXElement()) fail(source.opening.node, 'Expected a JSX element style owner.');
    const body: string[] = [];
    const attributes: string[] = [];
    let explicitClass: string | undefined; let explicitStyle: string | undefined;
    const evaluation = emitStyleEvaluation(cssPlan, fresh('eval'), undefined, options.dev);
    let evaluationState = evaluation.state;
    let evaluationSlots = evaluation.slots;
    const occurrences = new Map(source.occurrences.map((occurrence) => [occurrence.node, occurrence]));
    const finalOccurrence = source.occurrences[source.occurrences.length - 1];
    let evaluationInserted = false;
    for (const attribute of source.opening.get('attributes')) {
      if (attribute.isJSXSpreadAttribute()) {
        const argument = attribute.get('argument');
        if (!argument.isExpression()) fail(attribute.node, 'JSX spread keys must be statically known.');
        const entries = knownSpread(argument, module);
        const name = fresh('spread');
        const occurrence = occurrences.get(attribute.node);
        let spreadReplacements: readonly { readonly node: t.Node; readonly text: string }[] = [];
        if (occurrence && occurrence.node === finalOccurrence?.node
          && occurrence.expression.node.start! >= argument.node.start!
          && occurrence.expression.node.end! <= argument.node.end!) {
          const result = fresh('result');
          const runEvaluation = `(()=>{${evaluation.code}return {state:${evaluation.state},slots:${evaluation.slots}};})()`;
          body.push(`let ${result};`);
          spreadReplacements = [{ node: occurrence.expression.node, text: `(${result}=${runEvaluation},void 0)` }];
          evaluationState = `${result}.state`;
          evaluationSlots = `${result}.slots`;
          evaluationInserted = true;
        }
        body.push(`const ${name}={...(${readGenerated(argument.node, spreadReplacements)})};`);
        if (occurrence && occurrence.node === finalOccurrence?.node && !evaluationInserted) {
          const stored = planStyleSite(lowerStoredStyleExpression(occurrence.expression, module, `${name}.css`), cssPlan.id, cssPlan.ownerId);
          const captured = emitStyleEvaluation(stored, fresh('eval'), undefined, options.dev);
          body.push(captured.code);
          evaluationState = captured.state;
          evaluationSlots = captured.slots;
          evaluationInserted = true;
        }
        const compilerKeys = new Set(['css', 'style', 'class', 'className']);
        for (const entry of entries) {
          const access = `${name}[${JSON.stringify(entry.key)}]`;
          if (entry.key === 'style') {
            checkStyle(entry.value);
            explicitStyle = access;
          } else if (entry.key === 'class' || entry.key === 'className') {
            explicitClass = access;
          }
        }
        if (occurrence && occurrence.node === finalOccurrence?.node && !evaluationInserted) {
          body.push(evaluation.code);
          evaluationInserted = true;
        }
        const retained = entries.some((entry) => !compilerKeys.has(entry.key));
        if (retained) {
          const rest = fresh('spread');
          const removals = entries.filter((entry) => compilerKeys.has(entry.key))
            .map((entry) => `delete ${rest}[${JSON.stringify(entry.key)}];`).join('');
          body.push(`const ${rest}={...${name}};${removals}`);
          attributes.push(` {...${rest}}`);
        }
        continue;
      }
      const occurrence = occurrences.get(attribute.node);
      if (occurrence) {
        if (occurrence.node === finalOccurrence?.node) {
          if (!evaluationInserted) {
            body.push(evaluation.code);
            evaluationInserted = true;
          }
        } else {
          // Preserve evaluation of an overwritten explicit css value while
          // keeping its style out of the final class/pack state. Spread
          // values are already evaluated by the generated object copy above.
          const discarded = fresh('discard');
          body.push(`const ${discarded}=(${readGenerated(occurrence.expression.node)});`);
        }
        continue;
      }
      if (!attribute.isJSXAttribute()) fail(source.opening.node, 'Unsupported JSX attribute.');
      const key = read(attribute.node.name);
      const value = attribute.get('value');
      let expression: string;
      if (!value.node) expression = 'true';
      else if (value.isStringLiteral()) {
        if (key === 'style' && /--qstyle-/.test(value.node.value)) {
          fail(value.node, 'The --qstyle- variable namespace is reserved.');
        }
        expression = JSON.stringify(value.node.value);
      }
      else if (value.isJSXExpressionContainer() && value.get('expression').isExpression()) {
        const path = value.get('expression') as NodePath<t.Expression>;
        if (key === 'style') checkStyle(path);
        expression = read(path.node);
      } else fail(attribute.node, 'Unsupported JSX attribute value.');
      const name = fresh('attr'); body.push(`const ${name}=(${expression});`);
      if (key === 'class' || key === 'className') explicitClass = name;
      else if (key === 'style') explicitStyle = name;
      else attributes.push(` ${key}={${name}}`);
    }
    if (!evaluationInserted) body.push(evaluation.code);
    if (classValues) {
      if (!utilities) fail(source.opening.node, 'Utility states must be resolved before module emission.');
      const index = fresh('classIndex');
      const normalized = explicitClass ? `(typeof ${explicitClass}==="string"?${explicitClass}.trim():"")` : '""';
      body.push(`const ${index}=${JSON.stringify(classValues.values)}.indexOf(${normalized});`);
      body.push(`if(${index}<0)throw new Error("[qstyle QS1102] Class value is outside the proven finite set.");`);
      const combined = fresh('state');
      body.push(`const ${combined}=${index}*${cssPlan.states.length}+${evaluationState};`);
      evaluationState = combined;
      const retained = fresh('class');
      body.push(`const ${retained}=${JSON.stringify(utilities.map((utility) => utility.retainedTokens.join(' ')))}[${index}];`);
      explicitClass = retained;
    }
    const classChoices = plan.states.map((state) => {
      const classes = program.classesByState.get(state.id);
      if (!classes) fail(source.opening.node, `Missing frozen class assignment for ${state.id}.`);
      return classes.join(' ');
    });
    const generatedClass = classChoices.length === 1 ? JSON.stringify(classChoices[0]) : `${JSON.stringify(classChoices)}[${evaluationState}]`;
    attributes.push(` class={${explicitClass ? `[${explicitClass},${generatedClass}]` : generatedClass}}`);
    let style = evaluationSlots;
    if (explicitStyle) {
      const names = new Set<string>();
      // All slot keys are known after emission; no browser registry is required.
      const collectSlots = (expression: StyleExpression): void => {
        if (expression.kind === 'style') {
          for (const binding of expression.value.bindings) {
            const name = definitionSlotName(binding.definition, new NativeIdentityRegistry());
            if (name) names.add(name);
          }
        } else if (expression.kind === 'sequence') expression.items.forEach(collectSlots);
        else { collectSlots(expression.consequent); collectSlots(expression.alternate); }
      };
      collectSlots(cssPlan.expression);
      const serialized = [...names].map((name) => `(${evaluationSlots}[${JSON.stringify(name)}]===undefined?"":${JSON.stringify(name + ':')}+${evaluationSlots}[${JSON.stringify(name)}]+";")`).join('+') || '""';
      style = `(typeof ${explicitStyle}==="string"?(${serialized})+${explicitStyle}:{...${evaluationSlots},...${explicitStyle}})`;
    }
    attributes.push(` style={${style}}`);
    const allPacks = new Map<string, number[]>();
    plan.states.forEach((state, index) => {
      const packs = program.packsByDemand.get(state.demand.id);
      if (!packs) fail(source.opening.node, `Missing frozen pack demand for ${state.id}.`);
      for (const pack of packs) {
        const cases = allPacks.get(pack) ?? []; cases.push(index); allPacks.set(pack, cases);
      }
    });
    const owners = [...allPacks].map(([pack, cases]) => {
      const jsx = `<${packName(pack)}/>`;
      return cases.length === plan.states.length ? jsx : `{(${cases.map((index) => `${evaluationState}===${index}`).join('||')})?${jsx}:null}`;
    }).join('');
    const child = element.parentPath?.isJSXElement() || element.parentPath?.isJSXFragment();
    // Literal attributes and a single static CSS state have no evaluation to
    // capture. Keep them static for Qwik and insert sibling owners directly in
    // a JSX child list, avoiding an unnecessary resumable Fragment and style {}.
    let literalClass = '';
    let hasLiteralClass = false;
    const literalAttributes: string[] = [];
    const staticAttributes = source.opening.get('attributes').every((attribute) => {
      if (!attribute.isJSXAttribute()) return false;
      if (occurrences.has(attribute.node)) return true;
      const key = read(attribute.node.name);
      const value = attribute.get('value');
      if (key === 'style') return false;
      if (key === 'class' || key === 'className') {
        if (!value.isStringLiteral()) return false;
        hasLiteralClass = true;
        literalClass = value.node.value;
        return true;
      }
      if (value.node && !value.isStringLiteral()) return false;
      literalAttributes.push(` ${read(attribute.node)}`);
      return true;
    });
    if (staticAttributes && source.occurrences.length <= 1 && plan.states.length === 1
      && !hasRuntime(cssPlan.expression) && (!classValues || classValues.values.length === 1)) {
      const retained = classValues ? utilities![0]!.retainedTokens.join(' ') : literalClass;
      const classes = [retained, classChoices[0]].filter(Boolean).join(' ');
      if (classes || hasLiteralClass) literalAttributes.push(` class={${JSON.stringify(classes)}}`);
      if (owners) edits.appendLeft(element.node.start!, `${child ? '' : '<>'}${owners}`);
      edits.overwrite(source.opening.node.start!, source.opening.node.end!,
        `<${read(source.opening.node.name)}${literalAttributes.join('')}${source.opening.node.selfClosing ? '/>' : '>'}`);
      if (owners && !child) edits.appendRight(element.node.end!, '</>');
      continue;
    }
    edits.appendLeft(element.node.start!, `${child ? '{' : ''}(()=>{${body.join('\n')}return <>${owners}`);
    edits.overwrite(source.opening.node.start!, source.opening.node.end!,
      `<${read(source.opening.node.name)}${attributes.join('')}${source.opening.node.selfClosing ? '/>' : '>'}`);
    edits.appendRight(element.node.end!, `</>;})()${child ? '}' : ''}`);
  }
  for (const macro of analysis.macros) edits.overwrite(macro.node.start!, macro.node.end!, 'void 0');
  if (analysis.foundation) {
    const { opening, demandId } = analysis.foundation;
    const packs = program.packsByDemand.get(demandId);
    if (!packs) fail(opening.node, `Missing utility foundation demand ${demandId}.`);
    const owners = packs.map((pack) => `<${packName(pack)}/>`).join('');
    if (opening.node.selfClosing) edits.overwrite(opening.node.end! - 2, opening.node.end!, `>${owners}</head>`);
    else edits.appendLeft(opening.node.end!, owners);
  }
  const imports = [...packNames].map(([pack, name]) => `import { StylePack as ${name} } from ${JSON.stringify(options.packModule?.(pack) ?? `virtual:qstyle-native:${pack}.tsx`)};`).join('\n');
  if (imports) edits.prepend(imports + '\n');
  return { code: edits.toString(), map: edits.generateMap({ source: module.file, includeContent: true, hires: true }) };
}
