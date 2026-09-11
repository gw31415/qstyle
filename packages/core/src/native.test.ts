import { describe, expect, it } from 'vitest';
import { canonicalDeclaration, canonicalGlobal, canonicalRule } from './canonical.js';
import { DeclarationDictionary, createNativePacks } from './declarations.js';
import { NativeIdentityRegistry, nativeClassName, sha256Prefix128 } from './identity.js';
import { SUBJECT_SELECTOR } from './native-ir.js';
import type { DeclarationDefinition, DemandSite, NativeKeyframes, NativeStyleRule, StyleDeclaration } from './native-ir.js';
import { evaluateNativeSlot, nativeProperty, nativeStaticValue } from './native-values.js';
import { definitionSlotName, serializeDeclarationDefinition, serializeNativeGlobal, serializeNativeRule } from './serialize.js';

const value = (property: string, css: string): StyleDeclaration => ({ property, value: { kind: 'static', css }, important: false });
const definition = (property: string, css: string): DeclarationDefinition => ({
  selector: SUBJECT_SELECTOR, wrappers: [], declaration: value(property, css), dependencies: [],
});
const site = (id: string, predicate = 'true'): DemandSite => ({
  id, owner: 'Card', renderPath: 'return/0', styleState: id, lazyBoundary: 'Card', predicate,
});
const classA = `q1_${'a'.repeat(32)}`;
const classB = `q1_${'b'.repeat(32)}`;

describe('native semantic identities', () => {
  it('uses the SHA-256 128-bit prefix and isolates namespaces', () => {
    expect(sha256Prefix128('abc')).toBe('ba7816bf8f01cfea414140de5dae2223');
    const registry = new NativeIdentityRegistry();
    expect(registry.identify('rule', 'same')).not.toBe(registry.identify('pack', 'same'));
    expect(registry.identify('rule', 'same')).toBe(registry.identify('rule', 'same'));
    expect(nativeClassName(['b', 'a'], registry)).toBe(nativeClassName(['a', 'b', 'a'], registry));
  });

  it('rejects a forced collision and relates both sources', () => {
    const registry = new NativeIdentityRegistry(() => '0'.repeat(32));
    registry.identify('declaration', 'first', { file: 'a.tsx', start: 1, end: 2 });
    try {
      registry.identify('declaration', 'second', { file: 'b.tsx', start: 3, end: 4 });
      throw new Error('Expected collision');
    } catch (error) {
      expect(error).toMatchObject({ code: 'QS1301', diagnostic: {
        source: { file: 'b.tsx' }, related: [{ file: 'a.tsx' }],
      } });
    }
  });

  it('excludes source location, includes declaration order, and ignores object field insertion order', () => {
    const rule: NativeStyleRule = { selector: SUBJECT_SELECTOR, wrappers: [],
      declarations: [value('padding', '8px'), value('padding-left', '2px')], dependencies: [] };
    const relocated = { source: { file: '/different/checkout.tsx', start: 500, end: 900 },
      dependencies: [], declarations: rule.declarations, wrappers: [], selector: SUBJECT_SELECTOR };
    expect(canonicalRule(rule)).toBe(canonicalRule(relocated));
    expect(canonicalRule(rule)).not.toBe(canonicalRule({ ...rule, declarations: [...rule.declarations].reverse() }));
  });

  it('does not merge different parametric fallbacks', () => {
    const make = (fallback: string): DeclarationDefinition => ({ ...definition('width', ''),
      declaration: { property: 'width', important: false, value: { kind: 'slot', index: 0, unit: 'length', fallback } } });
    const a = make('10px'); const b = make('20px');
    expect(canonicalDeclaration(a)).not.toBe(canonicalDeclaration(b));
    const registry = new NativeIdentityRegistry();
    expect(serializeDeclarationDefinition(a, [classA], registry)).toContain(',10px)');
    expect(serializeDeclarationDefinition(b, [classA], registry)).toContain(',20px)');
  });

  it('ignores synthetic selector text boundaries in both identity and payload', () => {
    const flat: DeclarationDefinition = { ...definition('color', 'red'), selector: { alternatives: [[
      { kind: 'subject' }, { kind: 'text', text: ':hover:focus' },
    ]] } };
    const nested: DeclarationDefinition = { ...flat, selector: { alternatives: [[
      { kind: 'text', text: ' ' }, { kind: 'subject' },
      { kind: 'text', text: ':hover' }, { kind: 'text', text: ':focus ' },
    ]] } };
    expect(canonicalDeclaration(flat)).toBe(canonicalDeclaration(nested));
    expect(serializeDeclarationDefinition(flat, [classA], new NativeIdentityRegistry()))
      .toBe(serializeDeclarationDefinition(nested, [classA], new NativeIdentityRegistry()));
    const descendant = { ...flat, selector: { alternatives: [[
      { kind: 'subject' as const }, { kind: 'text' as const, text: ' :hover:focus' },
    ]] } };
    expect(canonicalDeclaration(flat)).not.toBe(canonicalDeclaration(descendant));
  });

  it('isolates dynamic slots in different selector contexts on the same element', () => {
    const base: DeclarationDefinition = { ...definition('width', ''), declaration: {
      property: 'width', important: false, value: { kind: 'slot', index: 0, unit: 'length' },
    } };
    const hover: DeclarationDefinition = { ...base, selector: { alternatives: [[
      { kind: 'subject' }, { kind: 'text', text: ':hover' },
    ]] } };
    const registry = new NativeIdentityRegistry();
    expect(definitionSlotName(base, registry)).not.toBe(definitionSlotName(hover, registry));
    expect(serializeDeclarationDefinition(base, [classA], registry)).toContain(`var(${definitionSlotName(base, registry)})`);
    expect(serializeDeclarationDefinition(hover, [classA], registry)).toContain(`var(${definitionSlotName(hover, registry)})`);
  });
});

describe('ordered native CSS', () => {
  it('retains ordered wrappers for globals and includes them in identity', () => {
    const global = {
      kind: 'font-face' as const,
      name: '',
      declarations: [value('font-family', 'Demo')],
    };
    const wrapped = {
      ...global,
      wrappers: [
        { kind: 'layer' as const, name: 'fonts' },
        { kind: 'supports' as const, params: '(font-tech(color-COLRv1))' },
        { kind: 'layer' as const, name: 'theme' },
      ],
    };
    expect(canonicalGlobal(global)).toBe(canonicalGlobal({ ...global, wrappers: [] }));
    expect(canonicalGlobal(global)).not.toBe(canonicalGlobal(wrapped));
    expect(serializeNativeGlobal(wrapped, new NativeIdentityRegistry())).toBe(
      '@layer fonts{@supports (font-tech(color-COLRv1)){@layer theme{@font-face{font-family:Demo;}}}}',
    );
  });

  it('wraps keyframes with the same ordered wrapper contract', () => {
    const keyframes: NativeKeyframes = {
      kind: 'keyframes',
      wrappers: [
        { kind: 'media', params: '(prefers-reduced-motion: no-preference)' },
        { kind: 'layer', name: 'motion' },
      ],
      frames: [{ selector: 'from', declarations: [value('opacity', '0')] }],
    };
    expect(serializeNativeGlobal(keyframes, new NativeIdentityRegistry(), `qk1_${'a'.repeat(32)}`)).toBe(
      `@media (prefers-reduced-motion: no-preference){@layer motion{@keyframes qk1_${'a'.repeat(32)}{from{opacity:0;}}}}`,
    );
  });

  it('retains repeated and interleaved wrappers', () => {
    const rule: NativeStyleRule = { selector: SUBJECT_SELECTOR, declarations: [value('color', 'red')], dependencies: [],
      wrappers: [
        { kind: 'media', params: '(min-width: 10px)' },
        { kind: 'supports', params: '(display: grid)' },
        { kind: 'media', params: '(max-width: 30px)' },
        { kind: 'layer', name: 'components' },
      ] };
    expect(serializeNativeRule(rule, [classA], new NativeIdentityRegistry())).toBe(
      `@media (min-width: 10px){@supports (display: grid){@media (max-width: 30px){@layer components{.${classA}{color:red;}}}}}`,
    );
  });

  it('retains meaningful whitespace, escapes, and declaration fallback order', () => {
    const rule: NativeStyleRule = { selector: SUBJECT_SELECTOR, wrappers: [], dependencies: [], declarations: [
      value('display', '-webkit-box'), value('display', 'flex'), value('content', '"a  b\\26 c"'),
      value('--custom', 'a  b'),
    ] };
    expect(serializeNativeRule(rule, [classA], new NativeIdentityRegistry())).toBe(
      `.${classA}{display:-webkit-box;display:flex;content:"a  b\\26 c";--custom:a  b;}`,
    );
  });

  it('groups applying selectors without repeating declaration text', () => {
    const css = serializeDeclarationDefinition(definition('padding', '8px'), [classB, classA, classA], new NativeIdentityRegistry());
    expect(css).toBe(`.${classA},.${classB}{padding:8px;}`);
    expect(css.match(/padding:/g)).toHaveLength(1);
  });

  it('substitutes parsed subjects rather than ampersands inside attribute values', () => {
    const d: DeclarationDefinition = { ...definition('color', 'red'), selector: { alternatives: [[
      { kind: 'subject' }, { kind: 'text', text: '[data-value="&"] + ' }, { kind: 'subject' },
    ]] } };
    expect(serializeDeclarationDefinition(d, [classA, classB], new NativeIdentityRegistry())).toBe(
      `:is(.${classA},.${classB})[data-value="&"] + :is(.${classA},.${classB}){color:red;}`,
    );
  });
});

describe('static and runtime value parity', () => {
  it.each([
    ['width', 'length', 100, '100px'], ['width', 'length', 101, '101px'],
    ['width', 'length', 0, '0px'], ['margin-left', 'length', -2, '-2px'],
    ['opacity', 'unitless', 0.5, '0.5'], ['--user', 'raw', 5, '5'],
    ['width', 'length', '50%', '50%'], ['width', 'length', 'calc(100% - 2px)', 'calc(100% - 2px)'],
  ] as const)('formats %s %s %s consistently', (property, unit, input, expected) => {
    expect(nativeStaticValue(property, input)).toEqual({ kind: 'static', css: expected });
    expect(evaluateNativeSlot(unit, input)).toBe(expected);
  });

  it('removes nullish, boolean and invalid runtime values and rejects invalid static numbers', () => {
    for (const input of [null, undefined, true, false, NaN, Infinity, {}, []]) {
      expect(evaluateNativeSlot('length', input)).toBeUndefined();
    }
    expect(() => nativeStaticValue('width', NaN)).toThrow('QS1102');
    expect(nativeStaticValue('content', '"a  b"')).toEqual({ kind: 'static', css: '"a  b"' });
  });

  it('rejects reserved and malformed custom properties', () => {
    for (const name of ['--a;b', '--a}', '--qstyle-user', '--']) {
      expect(() => nativeProperty(name)).toThrow('QS1201');
    }
    expect(nativeProperty('--brand-color')).toBe('--brand-color');
    expect(nativeProperty('marginLeft')).toBe('margin-left');
  });
});

describe('whole-site declaration ownership', () => {
  it('cannot change registered content after its identity has been fixed', () => {
    const dictionary = new DeclarationDictionary();
    const input = { ...definition('color', 'red'), dependencies: ['original'] };
    dictionary.add(input, site('a'));
    input.dependencies.push('later mutation');
    expect(dictionary.entries()[0]!.definition.dependencies).toEqual(['original']);
    expect(Object.isFrozen(dictionary.entries()[0]!.definition.declaration.value)).toBe(true);
  });

  it('unions delivery dependencies without duplicating the same declaration or changing its slot', () => {
    const dictionary = new DeclarationDictionary();
    const a = { ...definition('color', 'red'), dependencies: ['font-a'] };
    const b = { ...a, dependencies: ['font-b'] };
    expect(dictionary.add(a, site('a'))).toBe(dictionary.add(b, site('b')));
    expect(dictionary.entries()).toHaveLength(1);
    expect(dictionary.entries()[0]!.definition.dependencies).toEqual(['font-a', 'font-b']);
  });

  it('shares common CSS but keeps opposite style branches in distinct packs', () => {
    const dictionary = new DeclarationDictionary();
    const a = site('active', 'active'); const b = site('inactive', '!active');
    const padding = dictionary.add(definition('padding', '8px'), a);
    expect(dictionary.add(definition('padding', '8px'), b)).toBe(padding);
    const red = dictionary.add(definition('color', 'red'), a);
    const blue = dictionary.add(definition('color', 'blue'), b);
    const packs = createNativePacks(dictionary, new Map([
      [padding, [classA, classB]], [red, [classA]], [blue, [classB]],
    ]), [padding, red, blue]);
    expect(packs).toHaveLength(3);
    const shared = packs.find((pack) => pack.declarationIds.includes(padding))!;
    expect(shared.demandIds).toEqual(['active', 'inactive']);
    expect(shared.css).toBe(`.${classA},.${classB}{padding:8px;}`);
    expect(packs.filter((pack) => pack.demandIds.includes('active')).map((pack) => pack.css).join('')).not.toContain('blue');
    expect(packs.flatMap((pack) => pack.declarationIds).sort()).toEqual([padding, red, blue].sort());
  });

  it('refuses order-dependent rules across independently loaded demands', () => {
    const dictionary = new DeclarationDictionary();
    const a = dictionary.add(definition('padding', '8px'), site('a'));
    const b = dictionary.add(definition('padding-left', '2px'), site('b'));
    expect(() => createNativePacks(dictionary, new Map([[a, [classA]], [b, [classB]]]), [a, b], [[a, b]]))
      .toThrow('QS1601');
  });

  it('fails when a declaration is missing or repeated in the emission order', () => {
    const dictionary = new DeclarationDictionary();
    const a = dictionary.add(definition('color', 'red'), site('a'));
    const mapping = new Map([[a, [classA]]]);
    expect(() => createNativePacks(dictionary, mapping, [])).toThrow('QS1601');
    expect(() => createNativePacks(dictionary, mapping, [a, a])).toThrow('QS1601');
  });
});
