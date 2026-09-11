import { describe, expect, it } from 'vitest';
import { presetWind4 } from 'unocss';
import { NativeIdentityRegistry, serializeNativeRule } from '@qstyle/core';
import { createNativeUnoAdapter, parseNativeUnoCss, type NativeUnoNode } from './native-adapter.js';

const className = `q1_${'a'.repeat(32)}`;
const localCss = (nodes: readonly NativeUnoNode[]) => nodes.flatMap((node) => node.kind === 'local'
  ? [serializeNativeRule(node.rule, [className], new NativeIdentityRegistry())] : []).join('');

describe('native UnoCSS adapter', () => {
  it('keeps overlapping safelisted utilities at the root with fixed DOM classes', async () => {
    const adapter = await createNativeUnoAdapter({ safelist: ['always'],
      rules: [['always', { display: 'grid' }], ['lazy', { opacity: '0.5' }]],
    });
    const result = await adapter.resolve([{ id: 'initial', tokens: [] }, { id: 'later', tokens: ['always', 'lazy'] }]);
    expect(result.foundation.some((node) => node.kind === 'global-rule' && node.rule.declarations.some((declaration) => declaration.property === 'display'))).toBe(true);
    expect(result.states[1]!.retainedTokens).toEqual(['always']);
    expect(result.states[1]!.consumedTokens).toEqual(['lazy']);
    expect(localCss(result.states[1]!.nodes)).not.toContain('display:grid');
    expect(localCss(result.states[1]!.nodes)).toContain('opacity:0.5');
  });
  it('preserves responsive/group/peer structure while separating preflights and lazy styles', async () => {
    const adapter = await createNativeUnoAdapter({ presets: [presetWind4()] });
    const result = await adapter.resolve([
      { id: 'initial', tokens: ['p-4', 'md:text-blue-500', 'group', 'group-hover:opacity-50', 'peer-checked:opacity-50', 'external'] },
      { id: 'lazy', tokens: ['animate-spin', 'hover:bg-red-500', 'w-[123px]'] },
    ]);
    const initial = result.states[0]!; const lazy = result.states[1]!;
    expect(initial.retainedTokens).toEqual(['group', 'external']);
    expect(localCss(initial.nodes)).toContain(`.group:hover .${className}`);
    expect(localCss(initial.nodes)).toContain('.peer:checked');
    expect(localCss(initial.nodes)).toContain('@media (min-width: 48rem)');
    expect(localCss(initial.nodes)).toContain('@supports (color: color-mix(in lab, red, red))');
    expect(localCss(initial.nodes)).not.toContain('animation:');
    expect(localCss(lazy.nodes)).toContain('width:123px;');
    expect(lazy.nodes.some((node) => node.kind === 'global' && node.value.kind === 'keyframes')).toBe(true);
    expect(result.foundation.some((node) => node.kind === 'global-rule'
      && node.rule.declarations.some((declaration) => declaration.property === '--colors-red-500'))).toBe(true);
    expect(result.foundation.some((node) => node.kind === 'local')).toBe(false);
  });

  it('retains nested wrappers for properties, keyframes and local rules', () => {
    const nodes = parseNativeUnoCss(`@layer utilities{@supports (display:grid){
      @media (min-width:1px){.foo:hover{color:red}}
      @keyframes pulse{from{opacity:0}to{opacity:1}}
    }} @layer theme, utilities;`, new Set(['foo']));
    expect(localCss(nodes)).toContain(`@layer utilities{@supports (display:grid){@media (min-width:1px){.${className}:hover{color:red;}}}}`);
    const keyframes = nodes.find((node) => node.kind === 'global');
    expect(keyframes?.kind === 'global' && keyframes.wrappers).toEqual([
      { kind: 'layer', name: 'utilities' }, { kind: 'supports', params: '(display:grid)' },
    ]);
    expect(nodes.at(-1)).toEqual({ kind: 'layer-order', names: ['theme', 'utilities'] });
  });

  it('records layer first occurrences including empty blocks and conditional nested names', () => {
    const nodes = parseNativeUnoCss('@media (min-width:30em){@layer first{.foo{color:red}}}'
      + '@layer empty{}@layer parent{@supports(display:grid){@layer child{.foo{display:grid}}}}'
      + '@layer last,first;', new Set(['foo']));
    expect(nodes.filter((node) => node.kind === 'layer-order')).toEqual([
      { kind: 'layer-order', names: ['first'], wrappers: [{ kind: 'media', params: '(min-width:30em)' }] },
      { kind: 'layer-order', names: ['empty'] },
      { kind: 'layer-order', names: ['parent'] },
      { kind: 'layer-order', names: ['parent.child'], wrappers: [{ kind: 'supports', params: '(display:grid)' }] },
      { kind: 'layer-order', names: ['last', 'first'] },
    ]);
  });

  it('preserves official CSS layers and includes configured safelist output at the root', async () => {
    const adapter = await createNativeUnoAdapter({ outputToCssLayers: true,
      rules: [['one', { color: 'red' }], ['always', { display: 'grid' }]], safelist: ['always'],
      preflights: [{ getCSS: () => 'body{margin:0}' }],
    });
    const result = await adapter.resolve([{ id: 'a', tokens: ['one'] }]);
    expect(result.foundation.some((node) => node.kind === 'layer-order')).toBe(true);
    expect(result.foundation.some((node) => node.kind === 'global-rule'
      && node.rule.declarations.some((declaration) => declaration.property === 'display'))).toBe(true);
    expect(localCss(result.states[0]!.nodes)).toContain('color:red;');
    expect(localCss(result.states[0]!.nodes)).not.toContain('display:grid;');
  });

  it('rejects unknown syntax and ambiguous utility subjects instead of emitting raw CSS', () => {
    expect(() => parseNativeUnoCss('@scope (.x){.foo{color:red}}', new Set(['foo']))).toThrow('QS1101');
    expect(() => parseNativeUnoCss('.foo .bar{color:red}', new Set(['foo', 'bar']))).toThrow('one utility subject');
  });

  it('does not poison a generator instance after a failed request', async () => {
    const adapter = await createNativeUnoAdapter({ rules: [['one', { color: 'red' }]] });
    await expect(adapter.resolve([{ id: 'a', tokens: [] }, { id: 'a', tokens: [] }])).rejects.toThrow('Duplicate');
    expect(localCss((await adapter.resolve([{ id: 'a', tokens: ['one'] }])).states[0]!.nodes)).toContain('color:red;');
  });
});
