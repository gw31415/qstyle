import { describe, expect, it } from 'vitest';
import { SUBJECT_SELECTOR, type NativeStyleRule } from './native-ir.js';
import { optimizeStyleProgram, type StyleProgramState } from './program.js';

function state(id: string, values: readonly (readonly [string, string])[]): StyleProgramState {
  const rule: NativeStyleRule = { selector: SUBJECT_SELECTOR, wrappers: [], dependencies: [],
    declarations: values.map(([property, css]) => ({ property, value: { kind: 'static', css }, important: false })) };
  return { id, demand: { id, owner: id.split(':')[0]!, styleState: id, renderPath: 'return',
    lazyBoundary: id, predicate: id }, rules: [rule] };
}

describe('whole-site program integration', () => {
  it('keeps development classes attached to consumers when CSS values change', () => {
    const input = (color: string) => [
      state('a', [['color', color], ['width', '100px']]),
      state('b', [['color', color], ['background', 'white']]),
    ];
    const before = optimizeStyleProgram(input('red'), undefined, undefined, true);
    const after = optimizeStyleProgram(input('blue'), undefined, undefined, true);
    expect(after.classesByState).toEqual(before.classesByState);
    expect(after.packs.map((pack) => pack.css).join('')).toContain('color:blue;');
    expect(optimizeStyleProgram(input('red')).classesByState)
      .not.toEqual(optimizeStyleProgram(input('blue')).classesByState);
  });

  it('uses two classes, one shared declaration, and independently lazy specific packs', () => {
    const a = state('route-a', [['color', 'red'], ['padding', '8px']]);
    const b = state('route-b', [['color', 'blue'], ['padding', '8px']]);
    const result = optimizeStyleProgram([a, b]);
    expect(result.cover.K).toBe(2);
    expect(result.cover.T).toBe(2);
    expect(result.declarations).toHaveLength(3);
    expect(result.packs).toHaveLength(3);
    const allCss = result.packs.map((pack) => pack.css).join('');
    expect(allCss.match(/padding:8px;/g)).toHaveLength(1);
    const initial = result.packs.filter((pack) => pack.demandIds.includes('route-a')).map((pack) => pack.css).join('');
    expect(initial).toContain('color:red;');
    expect(initial).not.toContain('color:blue;');
    const changedTraversal = optimizeStyleProgram([b, a]);
    expect(changedTraversal.packs).toEqual(result.packs);
    expect(changedTraversal.classes).toEqual(result.classes);
  });

  it('minimizes site-wide class types instead of adding one class for every combination', () => {
    const result = optimizeStyleProgram([
      state('red', [['color', 'red']]), state('space', [['padding', '8px']]),
      state('both', [['color', 'red'], ['padding', '8px']]),
    ]);
    expect(result.cover.K).toBe(2);
    expect(result.cover.T).toBe(4);
    expect(result.classesByState.get('both')).toHaveLength(2);
    expect(result.packs.map((pack) => pack.css).join('').match(/color:red;/g)).toHaveLength(1);
  });

  it('does not merge opposite style states in the same component', () => {
    const result = optimizeStyleProgram([
      state('Card:active', [['color', 'red']]), state('Card:inactive', [['color', 'blue']]),
    ]);
    expect(result.packs).toHaveLength(2);
    for (const pack of result.packs) expect(pack.demandIds).toHaveLength(1);
  });

  it('rejects contradictory cascade order instead of duplicating the declaration', () => {
    expect(() => optimizeStyleProgram([state('repeated', [['color', 'red'], ['color', 'blue'], ['color', 'red']])])).toThrow(/cycle/);
    expect(() => optimizeStyleProgram([
      state('a', [['padding', '8px'], ['padding-left', '2px']]),
      state('b', [['padding-left', '2px'], ['padding', '8px']]),
    ])).toThrow(/cycle/);
  });
});
