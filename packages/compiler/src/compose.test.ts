import { describe, expect, it } from 'vitest';
import { NativeIdentityRegistry, definitionSlotName, optimizeStyleProgram } from '@qstyle/core';
import { collectCssPropSites } from './bindings.js';
import { lowerStyleExpression } from './lower.js';
import { parseStyleModule } from './parse.js';
import { emitStyleEvaluation, planStyleSite } from './compose.js';

function plan(expression: string) {
  const module = parseStyleModule(`import {component$} from '@qwik.dev/core';import {css} from '@qstyle/qwik';
    export const C=component$(()=> <div css={${expression}}/>);`, 'compose.tsx');
  const site = collectCssPropSites(module)[0]!;
  return planStyleSite(lowerStyleExpression(site.expression, module), 'C/div', 'C');
}

describe('finite composition and runtime evaluation', () => {
  it('numbers the cartesian product in source order and evaluates only chosen branches', () => {
    const compiled = plan(`[{padding:8}, flagA ? {color:'red',width:read('a')} : {color:'blue'},
      flagB && {opacity:read('b')}]`);
    expect(compiled.alternatives).toHaveLength(4);
    expect(compiled.states.map((state) => state.id)).toEqual([
      'C/div/state:0', 'C/div/state:1', 'C/div/state:2', 'C/div/state:3',
    ]);
    const emitted = emitStyleEvaluation(compiled, '__test');
    const run = new Function('flagA', 'flagB', 'read', `${emitted.code};return [${emitted.state},${emitted.slots}];`);
    for (const [a, b, expected, calls] of [
      [true, true, 0, ['a', 'b']], [true, false, 1, ['a']],
      [false, true, 2, ['b']], [false, false, 3, []],
    ] as const) {
      const actual: string[] = [];
      const [index, slots] = run(a, b, (name: string) => { actual.push(name); return name === 'a' ? 101 : 0.5; });
      expect(index).toBe(expected); expect(actual).toEqual(calls);
      expect(Object.values(slots)).toEqual(calls.map((name) => name === 'a' ? '101px' : '0.5'));
    }
  });

  it('evaluates overwritten inputs once and uses exactly the CSS slot schema', () => {
    const compiled = plan(`{width:read('discarded'),width:read('used')}`);
    const identities = new NativeIdentityRegistry();
    const emitted = emitStyleEvaluation(compiled, '__test', identities);
    const seen: string[] = [];
    const slots = new Function('read', `${emitted.code};return ${emitted.slots};`)((name: string) => {
      seen.push(name); return name === 'used' ? 101 : 100;
    });
    expect(seen).toEqual(['discarded', 'used']);
    const rule = compiled.states[0]!.rules[0]!;
    const variable = definitionSlotName({ ...rule, declaration: rule.declarations[0]! }, identities)!;
    expect(slots).toEqual({ [variable]: '101px' });
  });

  it('handles template units and removes invalid values without NaNpx', () => {
    const compiled = plan('css`width:${value}px; opacity:${opacity};`');
    const emitted = emitStyleEvaluation(compiled, '__test');
    const run = new Function('value', 'opacity', `${emitted.code};return ${emitted.slots};`);
    expect(Object.values(run(100, 0.5))).toEqual(['100px', '0.5']);
    for (const value of [null, undefined, false, NaN, Infinity, {}]) {
      expect(Object.values(run(value, value))).toEqual([undefined, undefined]);
    }
    expect(Object.values(run(101, 1))).toEqual(['101px', '1']);
  });

  it('fails closed before enumerating beyond the configured state bound', () => {
    const expression = plan(`flagA ? {color:'red'} : {color:'blue'}`).expression;
    expect(() => planStyleSite({ kind: 'sequence', items: [expression, expression] }, 'large', 'C', 3)).toThrow('QS1602');
  });

  it('replaces same-context contributions while preserving final CSS fallback order', () => {
    const compiled = plan(`[css\`color:red;display:block;\`, flag && css\`color:blue;display:-webkit-box;display:flex;\`]`);
    const declarations = compiled.states.map((state) => state.rules.flatMap((rule) => rule.declarations)
      .map((declaration) => [declaration.property, declaration.value]));
    expect(declarations[0]).toEqual([
      ['color', { kind: 'static', css: 'blue' }],
      ['display', { kind: 'static', css: '-webkit-box' }], ['display', { kind: 'static', css: 'flex' }],
    ]);
    expect(declarations[1]).toHaveLength(2);
    expect(() => optimizeStyleProgram(compiled.states)).not.toThrow();
  });
});
