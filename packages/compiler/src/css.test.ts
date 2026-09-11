import { describe, expect, it } from 'vitest';
import { parseStyleCss, selectorClassNames, type ParsedNativeGlobal } from './css.js';

function withoutSources<T extends { source?: unknown }>(value: T): Omit<T, 'source'> {
  const { source: _source, ...rest } = value;
  return rest;
}

describe('lossless native CSS frontend', () => {
  it('counts decoded fixed class names without counting attribute text or repeated uses', () => {
    const names = selectorClassNames({ alternatives: [[{ kind: 'text',
      text: '.group .hover\\:active:is(.shared,.group)[data-label=".not-a-class"],.shared' }]] });
    expect(names).toEqual(['group', 'hover:active', 'shared']);
  });

  it('uses an implicit subject and preserves declaration order, fallback whitespace, and important', () => {
    const parsed = parseStyleCss('color: red; color: blue !important; content: "a  b";');
    expect(parsed.globals).toEqual([]);
    expect(parsed.rules).toHaveLength(1);
    expect(withoutSources(parsed.rules[0]!)).toEqual({
      selector: { alternatives: [[{ kind: 'subject' }]] },
      wrappers: [],
      declarations: [
        { property: 'color', value: { kind: 'static', css: 'red' }, important: false },
        { property: 'color', value: { kind: 'static', css: 'blue' }, important: true },
        { property: 'content', value: { kind: 'static', css: '"a  b"' }, important: false },
      ],
      dependencies: [],
    });
  });

  it('preserves raw comments in custom values and escaped ampersands in selectors', () => {
    const parsed = parseStyleCss(String.raw`
      --token: alpha /* keep */ beta;
      width: calc(100% /* keep */ - 1px);
      background-image: url( "/assets/a.svg" /* keep */ );
      @media (min-width: 1px /* keep */) {
        &.foo\&bar { --nested: left /* keep */ right; }
      }
    `);
    expect(parsed.rules.map((rule) => ({ selector: rule.selector, wrappers: rule.wrappers, declarations: rule.declarations }))).toEqual([
      {
        selector: { alternatives: [[{ kind: 'subject' }]] },
        wrappers: [],
        declarations: [
          { property: '--token', value: { kind: 'static', css: 'alpha /* keep */ beta' }, important: false },
          { property: 'width', value: { kind: 'static', css: 'calc(100% /* keep */ - 1px)' }, important: false },
          { property: 'background-image', value: { kind: 'static', css: 'url( "/assets/a.svg" /* keep */ )' }, important: false },
        ],
      },
      {
        selector: { alternatives: [[{ kind: 'subject' }, { kind: 'text', text: '.foo\\&bar' }]] },
        wrappers: [{ kind: 'media', params: '(min-width: 1px /* keep */)' }],
        declarations: [
          { property: '--nested', value: { kind: 'static', css: 'left /* keep */ right' }, important: false },
        ],
      },
    ]);
  });

  it('flattens structural nested selector alternatives without changing quoted or escaped ampersands', () => {
    const parsed = parseStyleCss(
      '&:hover, &[data-marker="&"] { color: red; &:focus { color: blue; } }',
    );
    expect(parsed.rules.map((rule) => ({
      selector: rule.selector,
      declarations: rule.declarations,
    }))).toEqual([
      {
        selector: {
          alternatives: [
            [{ kind: 'subject' }, { kind: 'text', text: ':hover' }],
            [
              { kind: 'text', text: ' ' },
              { kind: 'subject' },
              { kind: 'text', text: '[data-marker="&"]' },
            ],
          ],
        },
        declarations: [{ property: 'color', value: { kind: 'static', css: 'red' }, important: false }],
      },
      {
        selector: {
          alternatives: [
            [{ kind: 'subject' }, { kind: 'text', text: ':hover' }, { kind: 'text', text: ':focus' }],
            [
              { kind: 'text', text: ' ' },
              { kind: 'subject' },
              { kind: 'text', text: '[data-marker="&"]' },
              { kind: 'text', text: ':focus' },
            ],
          ],
        },
        declarations: [{ property: 'color', value: { kind: 'static', css: 'blue' }, important: false }],
      },
    ]);
  });

  it('keeps repeated wrappers in source order and leaves :where unchanged', () => {
    const parsed = parseStyleCss(
      '@media (min-width: 1px) { @media (orientation: landscape) { &:where(:hover) { color: red; } } }',
    );
    expect(parsed.rules).toHaveLength(1);
    expect(withoutSources(parsed.rules[0]!)).toEqual({
      selector: { alternatives: [[{ kind: 'subject' }, { kind: 'text', text: ':where(:hover)' }]] },
      wrappers: [
        { kind: 'media', params: '(min-width: 1px)' },
        { kind: 'media', params: '(orientation: landscape)' },
      ],
      declarations: [{ property: 'color', value: { kind: 'static', css: 'red' }, important: false }],
      dependencies: [],
    });
  });

  it('returns named static globals for font-face, property, and keyframes', () => {
    const parsed = parseStyleCss(`
      @font-face { font-family: "Demo"; src: url("/demo.woff2"); }
      @property --accent { syntax: "<color>"; inherits: false; initial-value: red; }
      @keyframes fade { from { opacity: 0; } 100% { opacity: 1; } }
    `);
    expect(parsed.rules).toEqual([]);
    expect(parsed.globals).toHaveLength(3);
    expect(withoutSources(parsed.globals[0]!)).toEqual({
      kind: 'font-face',
      name: '',
      declarations: [
        { property: 'font-family', value: { kind: 'static', css: '"Demo"' }, important: false },
        { property: 'src', value: { kind: 'static', css: 'url("/demo.woff2")' }, important: false },
      ],
    });
    expect(withoutSources(parsed.globals[1]!)).toEqual({
      kind: 'property',
      name: '--accent',
      declarations: [
        { property: 'syntax', value: { kind: 'static', css: '"<color>"' }, important: false },
        { property: 'inherits', value: { kind: 'static', css: 'false' }, important: false },
        { property: 'initial-value', value: { kind: 'static', css: 'red' }, important: false },
      ],
    });
    const keyframes = parsed.globals[2] as ParsedNativeGlobal & { sourceName?: string };
    expect(withoutSources(keyframes)).toMatchObject({
      kind: 'keyframes',
      sourceName: 'fade',
      frames: [
        { selector: 'from', declarations: [{ property: 'opacity', value: { kind: 'static', css: '0' }, important: false }] },
        { selector: '100%', declarations: [{ property: 'opacity', value: { kind: 'static', css: '1' }, important: false }] },
      ],
    });
  });

  it('retains stylesheet wrappers on globals and rejects globals under selectors', () => {
    const parsed = parseStyleCss(`
      @layer base {
        @supports (display: grid) {
          @font-face { font-family: "Demo"; src: url("/demo.woff2"); }
        }
        @media (prefers-reduced-motion: no-preference) {
          @property --accent { syntax: "<color>"; inherits: false; initial-value: red; }
          @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
        }
      }
    `);
    expect(parsed.globals.map((global) => global.wrappers)).toEqual([
      [
        { kind: 'layer', name: 'base' },
        { kind: 'supports', params: '(display: grid)' },
      ],
      [
        { kind: 'layer', name: 'base' },
        { kind: 'media', params: '(prefers-reduced-motion: no-preference)' },
      ],
      [
        { kind: 'layer', name: 'base' },
        { kind: 'media', params: '(prefers-reduced-motion: no-preference)' },
      ],
    ]);
    expect(() => parseStyleCss(`
      & {
        @media (min-width: 1px) {
          @keyframes nested { from { opacity: 0; } }
        }
      }
    `)).toThrow(/QS1101/);
  });

  it('rejects plain nested selectors and unsupported or malformed at-rules with source spans', () => {
    for (const css of ['.child { color: red; }', '@import "theme.css";', '@scope (.root) { &:hover { color: red; } }', '@layer { &:hover { color: red; } }', '@unknown x { &:hover { color: red; } }', 'color: var(--missing']) {
      expect(() => parseStyleCss(css, { file: 'style.css', offset: 10 })).toThrow(/QS1101/);
      try {
        parseStyleCss(css, { file: 'style.css', offset: 10 });
      } catch (error) {
        expect((error as { diagnostic?: { source?: { file: string; start: number; end: number } } }).diagnostic?.source).toMatchObject({ file: 'style.css' });
      }
    }
  });
});
