import { describe, expect, it } from 'vitest';
import { optimizeFixedStyleProgram, type StyleProgramState } from './program.js';
import { SUBJECT_SELECTOR, type NativeStyleRule } from './native-ir.js';

const rule = (property: string, css: string): NativeStyleRule => ({
  selector: { alternatives: [[{ kind: 'text', text: ':root' }]] }, wrappers: [], dependencies: [],
  declarations: [{ property, value: { kind: 'static', css }, important: false }],
});
const state = (id: string, rules: readonly NativeStyleRule[]): StyleProgramState => ({ id, rules,
  demand: { id, owner: id, renderPath: id, styleState: id, lazyBoundary: id, predicate: id },
});

describe('fixed selector declarations', () => {
  it('shares one definition and payload across identical render demands without generating classes', () => {
    const result = optimizeFixedStyleProgram([state('a', [rule('--brand', 'red')]), state('b', [rule('--brand', 'red')])]);
    expect(result.declarations).toHaveLength(1);
    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]!.css).toBe(':root{--brand:red;}');
    expect(result.packs[0]!.demandIds).toEqual(['a', 'b']);
  });
  it('preserves fallback order and rejects contradictory cascade order', () => {
    const red = rule('color', 'red'); const blue = rule('color', 'blue');
    const result = optimizeFixedStyleProgram([state('a', [red, blue])]);
    expect(result.packs[0]!.css).toBe(':root{color:red;}:root{color:blue;}');
    expect(() => optimizeFixedStyleProgram([state('a', [red, blue]), state('b', [blue, red])])).toThrow('QS1601');
    expect(() => optimizeFixedStyleProgram([state('a', [red, blue, red])])).toThrow('QS1601');
  });
  it('rejects local subjects, runtime slots and order dependencies across lazy demands', () => {
    expect(() => optimizeFixedStyleProgram([state('a', [{ ...rule('color', 'red'), selector: SUBJECT_SELECTOR }])])).toThrow('QS1101');
    expect(() => optimizeFixedStyleProgram([state('a', [{ ...rule('width', '1px'),
      declarations: [{ property: 'width', important: false, value: { kind: 'slot', index: 0, unit: 'length' } }] }])])).toThrow('QS1102');
    expect(() => optimizeFixedStyleProgram([state('a', [rule('color', 'red'), rule('color', 'blue')]),
      state('b', [rule('color', 'red')])])).toThrow('QS1601');
  });
});
