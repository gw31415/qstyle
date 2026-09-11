import postcss, { type ChildNode, type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { createGenerator, type UserConfig } from 'unocss';
import { parseStyleCss, type UtilityCssNode, type UtilityRequest, type UtilityState, type UtilityResolution, type UtilityAdapter } from '@qstyle/compiler';
import { NativeStyleError, type NativeStyleRule, type StyleSelector, type StyleWrapper } from '@qstyle/core';

export type NativeUnoNode = UtilityCssNode;
export type NativeUnoRequest = UtilityRequest;
export type NativeUnoState = UtilityState;
export type NativeUnoResult = UtilityResolution;
export type NativeUnoAdapter = UtilityAdapter;

function fail(message: string): never {
  throw new NativeStyleError({ code: 'QS1101', message: `UnoCSS: ${message}` });
}

function substituteSubject(selector: StyleSelector, text: string): StyleSelector {
  return { alternatives: selector.alternatives.map((parts) => parts.map((part) =>
    part.kind === 'subject' ? { kind: 'text' as const, text } : part)) };
}

/** Parse every output node; unsupported generator syntax is never a verbatim fallback. */
export function parseNativeUnoCss(css: string, tokens: ReadonlySet<string>): readonly NativeUnoNode[] {
  let root: ReturnType<typeof postcss.parse>;
  try { root = postcss.parse(css); } catch (error) { fail(String(error)); }
  const output: NativeUnoNode[] = [];
  const registerLayer = (names: readonly string[], wrappers: readonly StyleWrapper[]): void => {
    const parent = wrappers.flatMap((wrapper) => wrapper.kind === 'layer' ? [wrapper.name] : []).join('.');
    const conditions = wrappers.filter((wrapper) => wrapper.kind !== 'layer');
    output.push({ kind: 'layer-order', names: names.map((name) => parent ? `${parent}.${name}` : name),
      ...(conditions.length ? { wrappers: conditions } : {}) });
  };
  const rule = (node: Rule, wrappers: readonly StyleWrapper[]): void => {
    let selectors: ReturnType<ReturnType<typeof selectorParser>['astSync']>;
    try { selectors = selectorParser().astSync(node.selector, { lossless: true }); }
    catch (error) { fail(String(error)); }
    for (const selector of selectors.nodes) {
      const original = selector.toString();
      const targets = new Set<string>();
      selector.walkClasses((entry) => { if (tokens.has(entry.value)) targets.add(entry.value); });
      if (targets.size > 1) fail(`Cannot identify one utility subject in ${JSON.stringify(original)}.`);
      const local = targets.size === 1;
      if (local) selector.walkClasses((entry) => {
        if (targets.has(entry.value)) entry.replaceWith(selectorParser.nesting({ value: '&' }));
      });
      const rewritten = node.clone({ selector: local ? selector.toString() : '&' });
      // Changing selector text must not leave PostCSS's raw selector override active.
      delete rewritten.raws.selector;
      const parsed = parseStyleCss(rewritten.toString(), { file: '<unocss>' });
      if (parsed.globals.length) fail('A utility style rule cannot contain a global declaration.');
      for (const value of parsed.rules) {
        const parsedRule: NativeStyleRule = {
        ...value, wrappers: [...wrappers, ...value.wrappers],
        selector: local ? value.selector : substituteSubject(value.selector, original),
        };
        output.push(local ? { kind: 'local', token: [...targets][0]!, rule: parsedRule }
          : { kind: 'global-rule', rule: parsedRule });
      }
    }
  };
  const walk = (nodes: readonly ChildNode[], wrappers: readonly StyleWrapper[]): void => {
    for (const node of nodes) {
      if (node.type === 'comment') continue;
      if (node.type === 'rule') { rule(node, wrappers); continue; }
      if (node.type !== 'atrule') fail('A generated declaration must belong to a rule.');
      const name = node.name.toLowerCase();
      if (name === 'layer' && !node.nodes) {
        const names = node.params.split(',').map((value) => value.trim());
        if (!names.length || names.some((value) => !/^[\w-]+(?:\.[\w-]+)*$/.test(value))) fail('Invalid layer-order statement.');
        registerLayer(names, wrappers); continue;
      }
      if (['media', 'supports', 'container', 'layer'].includes(name)) {
        if (!node.nodes) fail(`@${name} requires a block.`);
        const parsed = parseStyleCss(`@${name} ${node.params}{&{opacity:1;}}`, { file: '<unocss>' });
        if (name === 'layer') registerLayer([node.params.trim()], wrappers);
        walk(node.nodes, [...wrappers, ...parsed.rules[0]!.wrappers]); continue;
      }
      if (['keyframes', 'property', 'font-face'].includes(name)) {
        const parsed = parseStyleCss(node.toString(), { file: '<unocss>' });
        for (const value of parsed.globals) output.push({ kind: 'global', value, wrappers });
        continue;
      }
      fail(`Unsupported generated at-rule @${node.name}.`);
    }
  };
  walk(root.nodes, []);
  return output;
}

function signature(node: NativeUnoNode): string {
  return JSON.stringify(node, (key, value: unknown) => key === 'source' ? undefined : value);
}

/** One generator per adapter; token sets are resolved together in official generator order. */
export async function createNativeUnoAdapter(config: UserConfig): Promise<NativeUnoAdapter> {
  const generator = await createGenerator(config);
  let queue: Promise<unknown> = Promise.resolve();
  const resolve = async (requests: readonly NativeUnoRequest[]): Promise<NativeUnoResult> => {
    if (new Set(requests.map((state) => state.id)).size !== requests.length) fail('Duplicate utility state identity.');
    const tokens = new Set(requests.flatMap((state) => [...state.tokens]));
    // Safelisted classes are fixed public selectors: they must apply even when
    // the only compiler-known use is in a component that has not rendered yet.
    const safelist = await generator.generate(new Set<string>(), { preflights: false, safelist: true });
    const fixedTokens = safelist.matched;
    const fixedNodes = parseNativeUnoCss(safelist.css, new Set());
    const fixedSignatures = new Set(fixedNodes.filter((node) => node.kind !== 'layer-order').map(signature));
    const utility = await generator.generate(tokens, { preflights: false, safelist: false });
    const complete = await generator.generate(tokens, { preflights: true, safelist: true });
    const explicitMatched = new Set([...utility.matched].filter((token) => !fixedTokens.has(token)));
    const utilityNodes = parseNativeUnoCss(utility.css, explicitMatched);
    const counts = new Map<string, number>();
    for (const node of utilityNodes) {
      if (node.kind === 'layer-order' || fixedSignatures.has(signature(node))) continue;
      const key = signature(node); counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const foundation: NativeUnoNode[] = [];
    const completeNodes = parseNativeUnoCss(complete.css, explicitMatched);
    const completeSignatures = new Set(completeNodes.map(signature));
    if ([...fixedSignatures].some((key) => !completeSignatures.has(key))) fail('Safelist output changed across token sets.');
    for (const node of completeNodes) {
      const key = signature(node); const remaining = counts.get(key) ?? 0;
      if (remaining) { counts.set(key, remaining - 1); continue; }
      if (node.kind === 'local') fail('A preflight targets a consumed utility, or utility output changed between generation passes.');
      foundation.push(node);
    }
    if ([...counts.values()].some(Boolean)) fail('Utility output is not stable between generation passes.');
    const states: NativeUnoState[] = [];
    for (const request of requests) {
      const result = await generator.generate(new Set(request.tokens), { preflights: false, safelist: false });
      const matched = new Set([...result.matched].filter((token) => !fixedTokens.has(token)));
      const nodes = parseNativeUnoCss(result.css, matched).filter((node) => node.kind !== 'layer-order' && !fixedSignatures.has(signature(node)));
      for (const token of result.matched) {
        const definitions = (values: readonly NativeUnoNode[]) => values
          .filter((node) => node.kind === 'local' && node.token === token).map(signature);
        if (JSON.stringify(definitions(nodes)) !== JSON.stringify(definitions(utilityNodes))) {
          fail(`Utility ${JSON.stringify(token)} changed its definition across owner token sets.`);
        }
      }
      states.push({ id: request.id,
        nodes,
        consumedTokens: [...new Set(request.tokens)].filter((token) => matched.has(token)),
        retainedTokens: [...new Set(request.tokens)].filter((token) => !matched.has(token)),
      });
    }
    return { foundation, states };
  };
  return { resolve(requests) {
    const work = queue.then(() => resolve(requests));
    queue = work.catch(() => undefined);
    return work;
  } };
}
