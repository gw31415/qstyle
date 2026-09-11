import { describe, expect, it } from 'vitest';
import { NativeIdentityRegistry, serializeNativeRule } from '@qstyle/core';
import { collectCssPropSites } from './bindings.js';
import { lowerStyleExpression, type LoweredStyle, type StyleExpression } from './lower.js';
import { parseStyleModule } from './parse.js';

function lower(expression: string, setup = ''): StyleExpression {
  const module = parseStyleModule(`import {component$} from '@qwik.dev/core';
    import {css} from '@qstyle/qwik';
    ${setup}
    export const Card = component$(() => <div css={${expression}} />);`, 'card.tsx');
  return lowerStyleExpression(collectCssPropSites(module)[0]!.expression, module);
}

function onlyStyle(expression: StyleExpression): LoweredStyle {
  expect(expression.kind).toBe('style');
  if (expression.kind !== 'style') throw new Error('Expected one style');
  return expression.value;
}

describe('style AST lowering', () => {
  it('lowers constant objects and nested contexts while preserving whitespace', () => {
    const style = onlyStyle(lower(`{width:100, opacity:.5, content:'"a  b"', '@media (min-width: 1px)': {
      '@media (max-width: 2px)': {'&:hover': {color:'red'}}
    }}`));
    const css = style.rules.map((rule) => serializeNativeRule(rule, [`q1_${'a'.repeat(32)}`], new NativeIdentityRegistry())).join('');
    expect(css).toContain('width:100px;');
    expect(css).toContain('opacity:0.5;');
    expect(css).toContain('content:"a  b";');
    expect(css).toContain('@media (min-width: 1px){@media (max-width: 2px){');
    expect(style.inputs).toEqual([]);
  });

  it('resolves static macro handles without embedding compiler objects', () => {
    const style = onlyStyle(lower('base', `const base = css({padding:12});`));
    expect(style.rules[0]!.declarations[0]!.value).toEqual({ kind: 'static', css: '12px' });
    expect(style.inputs).toEqual([]);
  });

  it('keeps runtime values as slots with the right unit and original evaluation order', () => {
    const style = onlyStyle(lower(`{width:readWidth(), opacity:readOpacity(), '--theme':readToken()}`));
    expect(style.inputs.map((input) => input.code)).toEqual(['readWidth()', 'readOpacity()', 'readToken()']);
    expect(style.bindings.map((binding) => binding.definition.declaration.value)).toEqual([
      { kind: 'slot', index: 0, unit: 'length' }, { kind: 'slot', index: 1, unit: 'unitless' },
      { kind: 'slot', index: 2, unit: 'raw' },
    ]);
  });

  it('does not discard evaluation of an overwritten object value', () => {
    const style = onlyStyle(lower(`{width:first(), color:'red', width:last()}`));
    expect(style.inputs.map((input) => input.code)).toEqual(['first()', 'last()']);
    expect(style.bindings[0]!.parts).toEqual([{ input: 1 }]);
    expect(style.rules.flatMap((rule) => rule.declarations).map((declaration) => declaration.property)).toEqual(['width', 'color']);
  });

  it('keeps finite style choices inside the matching render branch', () => {
    const expression = lower(`[base, active.value && selected, {width:width.value}]`,
      `const base=css({padding:8}); const selected=css({color:'red'});`);
    expect(expression.kind).toBe('sequence');
    if (expression.kind !== 'sequence') throw new Error('Expected sequence');
    expect(expression.items.map((item) => item.kind)).toEqual(['style', 'choice', 'style']);
    const choice = expression.items[1]!;
    if (choice.kind !== 'choice') throw new Error('Expected choice');
    expect(choice.test.code).toBe('active.value');
    expect(choice.alternate).toEqual({ kind: 'sequence', items: [] });
  });

  it('forms a complete template value when a unit adjoins an interpolation', () => {
    const style = onlyStyle(lower('css`width:${width.value}px; opacity:${opacity.value};`'));
    expect(style.bindings[0]!.parts).toEqual([{ input: 0 }, 'px']);
    expect(style.bindings[0]!.definition.declaration.value).toMatchObject({ kind: 'slot', unit: 'raw' });
    const output = style.rules.map((rule) => serializeNativeRule(rule, [`q1_${'a'.repeat(32)}`], new NativeIdentityRegistry())).join('');
    expect(output).not.toContain(')px');
    expect(style.inputs.map((input) => input.code)).toEqual(['width.value', 'opacity.value']);
  });

  it('uses consistent units for static template numbers without making them runtime slots', () => {
    const style = onlyStyle(lower('css`width:${100}; height:${20}px; opacity:${0.5}; content:"${2}";`'));
    expect(style.inputs).toEqual([]);
    expect(style.bindings).toEqual([]);
    expect(style.rules.flatMap((rule) => rule.declarations).map((declaration) => declaration.value)).toEqual([
      { kind: 'static', css: '100px' }, { kind: 'static', css: '20px' },
      { kind: 'static', css: '0.5' }, { kind: 'static', css: '"2"' },
    ]);
  });

  it('does not let object values introduce declarations but preserves quoted punctuation', () => {
    expect(() => lower(`{color:'red;background:blue'}`)).toThrow(/exactly one/);
    expect(() => lower(`{color:'red;'}`)).toThrow(/trailing CSS/);
    const style = onlyStyle(lower(`{content:'"a; b"', color:'red !important'}`));
    expect(style.rules[0]!.declarations[0]!.value).toEqual({ kind: 'static', css: '"a; b"' });
    expect(style.rules[0]!.declarations[1]!.important).toBe(true);
  });

  it('fails closed on unknown structure, dynamic selectors and unsupported macros', () => {
    expect(() => lower('makeStyle()')).toThrow('QS1102');
    expect(() => lower('css`${selector.value}{color:red}`')).toThrow(/structure/);
    expect(() => lower('{...unknown}')).toThrow('QS1102');
    expect(() => lower('css()')).toThrow('QS1102');
  });

  it('does not inline an effectful local handle at its later use site', () => {
    expect(() => lower('local', 'const local=css({width:sideEffect()});')).toThrow(/must be static/);
  });

  it('rejects mutable bindings and raw object aliases as reusable handles', () => {
    expect(() => lower('local', 'let local=css({color:\'red\'});')).toThrow('QS1102');
    expect(() => lower('local', 'var local=css({color:\'red\'});')).toThrow('QS1102');
    expect(() => lower('palette', 'const palette={color:\'red\'}; palette.color=\'blue\';')).toThrow('QS1102');
    expect(() => lower('alias', 'const palette={color:\'red\'}; const alias=palette;')).toThrow('QS1102');
  });

  it('resolves imported handles from qstyle modules through the module resolver', () => {
    const module = parseStyleModule(`import {component$} from '@qwik.dev/core';
      import {card as base} from './theme.qstyle';
      export const Card = component$(() => <div css={base} />);`, 'card.tsx');
    const resolved: StyleExpression = { kind: 'sequence', items: [] };
    const site = collectCssPropSites(module)[0]!;
    expect(lowerStyleExpression(site.expression, module, {
      resolveImport(source, imported) {
        expect(source).toBe('./theme.qstyle');
        expect(imported).toBe('card');
        return resolved;
      },
    })).toBe(resolved);
  });
});
