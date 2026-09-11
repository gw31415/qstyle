import { describe, expect, it } from 'vitest';
import { canonicalRule, NativeIdentityRegistry, type NativeGlobal } from '@qstyle/core';
import { parseStyleCss } from './css.js';
import { resolveStyleGlobals } from './global.js';

describe('static global resolution', () => {
  it('shares canonical keyframe content and rewrites each local source name', () => {
    const parsed = parseStyleCss(`
      @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes alias { from { opacity: 0; } to { opacity: 1; } }
      & { animation: fade 200ms ease, alias 100ms linear; }
    `, { file: 'motion.css' });
    const resolved = resolveStyleGlobals(parsed.rules, parsed.globals);
    expect(resolved.globals).toHaveLength(1);
    expect(resolved.globals[0]!.id).toMatch(/^qk1_[a-f0-9]{32}$/);
    expect(resolved.globals[0]!.css).toContain(`@keyframes ${resolved.globals[0]!.id}{`);
    expect(resolved.rules[0]!.declarations[0]!.value).toEqual({
      kind: 'static',
      css: `${resolved.globals[0]!.id} 200ms ease, ${resolved.globals[0]!.id} 100ms linear`,
    });
    expect(resolved.rules[0]!.dependencies).toEqual([resolved.globals[0]!.id]);
  });

  it('keeps global order, source spans, quoted values, important flags, and actual variable/font dependencies', () => {
    const parsed = parseStyleCss(`
      @font-face { font-family: "Demo"; src: url("/demo.woff2"); }
      @property --accent { syntax: "<color>"; inherits: false; initial-value: red !important; }
      & { font-family: "Demo"; color: var(--accent); }
    `, { file: 'globals.css' });
    const resolved = resolveStyleGlobals(parsed.rules, parsed.globals);
    expect(resolved.globals).toHaveLength(2);
    expect(resolved.globals.map((global) => global.css)).toEqual([
      '@font-face{font-family:"Demo";src:url("/demo.woff2");}',
      '@property --accent{syntax:"<color>";inherits:false;initial-value:red!important;}',
    ]);
    expect(resolved.globals.map((global) => global.source?.file)).toEqual(['globals.css', 'globals.css']);
    expect(resolved.rules[0]!.dependencies).toEqual(resolved.globals.map((global) => global.id));
  });

  it('preserves global wrapper order through identity and serialized payloads', () => {
    const parsed = parseStyleCss(`
      @layer base {
        @supports (display: grid) {
          @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
        }
      }
      & { animation: fade 1s; }
    `);
    const resolved = resolveStyleGlobals(parsed.rules, parsed.globals);
    const global = resolved.globals[0]!;
    expect(global.css).toBe(
      `@layer base{@supports (display: grid){@keyframes ${global.id}{from{opacity:0;}to{opacity:1;}}}}`,
    );
    expect(resolved.rules[0]!.dependencies).toEqual([global.id]);
  });

  it('rewrites quoted local names while leaving nested function arguments untouched', () => {
    const parsed = parseStyleCss(`
      @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
      & {
        animation-name: "fade";
        animation: "fade" 1s, steps(fade, 1);
        transition: opacity 1s;
      }
    `);
    const resolved = resolveStyleGlobals(parsed.rules, parsed.globals);
    const keyframeId = resolved.globals[0]!.id;
    expect(resolved.rules[0]!.declarations.map((declaration) => declaration.value)).toEqual([
      { kind: 'static', css: `"${keyframeId}"` },
      { kind: 'static', css: `"${keyframeId}" 1s, steps(fade, 1)` },
      { kind: 'static', css: 'opacity 1s' },
    ]);
  });

  it('does not change a rule identity because an unused global is in another style handle', () => {
    const plain = parseStyleCss('& { color: red; }');
    const withUnusedKeyframe = parseStyleCss(`
      @keyframes unused { from { opacity: 0; } }
      & { color: red; }
    `);
    const plainRule = resolveStyleGlobals(plain.rules, plain.globals).rules[0]!;
    const unusedRule = resolveStyleGlobals(withUnusedKeyframe.rules, withUnusedKeyframe.globals).rules[0]!;
    expect(plainRule.dependencies).toEqual([]);
    expect(unusedRule.dependencies).toEqual([]);
    expect(canonicalRule(plainRule)).toBe(canonicalRule(unusedRule));
  });

  it('rejects conflicting definitions with the same keyframe source name and relates sources', () => {
    const parsed = parseStyleCss(`
      @keyframes fade { from { opacity: 0; } }
      @keyframes fade { from { opacity: 1; } }
    `, { file: 'conflict.css' });
    expect(() => resolveStyleGlobals(parsed.rules, parsed.globals)).toThrow(/QS1601/);
    try {
      resolveStyleGlobals(parsed.rules, parsed.globals);
    } catch (error) {
      expect(error).toMatchObject({ code: 'QS1601', diagnostic: {
        source: { file: 'conflict.css' }, related: [{ file: 'conflict.css' }],
      } });
    }
  });

  it('rejects dynamic global declarations with the global source span', () => {
    const global: NativeGlobal = {
      kind: 'font-face',
      name: '',
      declarations: [{
        property: 'font-family',
        value: { kind: 'slot', index: 0, unit: 'raw' },
        important: false,
      }],
      source: { file: 'dynamic.css', start: 7, end: 35 },
    };
    expect(() => resolveStyleGlobals([], [global])).toThrow(/QS1102/);
    try {
      resolveStyleGlobals([], [global]);
    } catch (error) {
      expect(error).toMatchObject({ code: 'QS1102', diagnostic: { source: global.source } });
    }
  });

  it('rejects an ambiguous animation shorthand with multiple defined names', () => {
    const parsed = parseStyleCss(`
      @keyframes fade { from { opacity: 0; } }
      @keyframes slide { from { transform: translateX(0); } }
      & { animation: fade slide; }
    `);
    expect(() => resolveStyleGlobals(parsed.rules, parsed.globals, new NativeIdentityRegistry())).toThrow(/QS1102/);
  });
});
