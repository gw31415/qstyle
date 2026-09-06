// Parser fuzz (plan.md B-4): fast-check による crash / hang / 非決定性の検出。
//
// lowerStyleObject / lowerTaggedTemplate / parseNestedKey は任意の (不正なものを
// 含む) 入力に対して例外を投げず、入力に対して決定的に atoms / parametrics /
// residuals へ分類することを保証する (correctness first: 不正入力は silent
// miscompile ではなく residual + diagnostic 側に落ちる。例外があれば fast-check
// が counterexample とともに fail する)。
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { css } from './index.js';
import type { LoweredStyle, StyleObject } from './index.js';
import type { LoweredTemplate } from './template.js';
import { lowerStyleObject, parseNestedKey } from './object.js';
import { lowerTaggedTemplate } from './template.js';

describe('fuzz: object syntax (lowerStyleObject)', () => {
  const attackValues: readonly unknown[] = [
    '',
    'red; } body { background: url(javascript:alert(1))',
    'expression(alert(1))',
    'url(javascript:x)',
    'url("unterminated',
    '<script>alert(1)</script>',
    'var(--a)',
    'calc(100% - 10px)',
    '4px 8px',
    '!important',
    'a"b\'c',
    '\\',
  ];

  const primitiveValueArb: fc.Arbitrary<unknown> = fc.oneof(
    fc.string({ maxLength: 24 }),
    fc.double({ min: -1e6, max: 1e6, noNaN: true }),
    fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }),
    fc.constantFrom(...attackValues),
    fc.constantFrom(true, false, null, undefined, () => {}, [], [1, 2], {}),
  );

  const keyArb: fc.Arbitrary<string> = fc.oneof(
    fc.string({ minLength: 0, maxLength: 12 }),
    fc.constantFrom(
      'color',
      'width',
      'displayy', // typo property
      '--q-x',
      'fontSize',
      '__proto__',
      'constructor',
      'prototype',
      'margin',
      'MARGIN',
      'a b',
      'a:b',
    ),
  );

  const nestedKeyArb: fc.Arbitrary<string> = fc.oneof(
    keyArb,
    fc.constantFrom(
      '&:hover',
      '& .tile',
      '& svg',
      '& > div',
      '&&',
      '@media (min-width: 600px)',
      '@supports (display: grid)',
      '@container card (width > 400px)',
      '@unknown',
      '@media',
    ),
  );

  // 1 段の nested object まで含めた style object を生成する。
  const styleArb: fc.Arbitrary<StyleObject> = fc
    .array(fc.tuple(nestedKeyArb, primitiveValueArb), { minLength: 0, maxLength: 8 })
    .chain((flat: readonly (readonly [string, unknown])[]): fc.Arbitrary<StyleObject> =>
      fc
        .array(fc.tuple(nestedKeyArb, primitiveValueArb), { minLength: 0, maxLength: 3 })
        .map((nested: readonly (readonly [string, unknown])[]): StyleObject => {
          const record: Record<string, unknown> = Object.fromEntries(flat);
          if (nested.length > 0) {
            record['&:hover'] = Object.fromEntries(nested);
          }
          return record as unknown as StyleObject;
        }),
    );

  it('任意の property / 値で例外なく決定的に atoms or residuals へ分類される', () => {
    fc.assert(
      fc.property(styleArb, (style: StyleObject): void => {
        // 例外そのものが fail (fast-check が counterexample を表示)。
        const first: LoweredStyle = lowerStyleObject(style);
        // 分類は決定的 (同一入力に冪等)。
        expect(lowerStyleObject(style)).toEqual(first);
        // 出力の shape 契約: atoms は static atom のみ、residual は residual-rule のみ。
        for (const atom of first.atoms) expect(atom.kind).toBe('static-atom');
        for (const residual of first.residuals) expect(residual.kind).toBe('residual-rule');
        for (const diagnostic of first.diagnostics) {
          expect(['warn', 'error']).toContain(diagnostic.severity);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('dangerous key (__proto__ 等) は atom 化せず diagnostic に落とす', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('__proto__', 'constructor', 'prototype'),
        (key: string): void => {
          const record: Record<string, unknown> = Object.fromEntries([[key, 'red']]);
          const lowered: LoweredStyle = lowerStyleObject(record as unknown as StyleObject);
          expect(lowered.atoms).toHaveLength(0);
          expect(lowered.diagnostics.length).toBeGreaterThan(0);
          // prototype 汚染なし (汚染される場合後続の任意の object が壊れる)。
          const canary: Record<string, unknown> = {};
          expect(({} as Record<string, unknown>).polluted).toBeUndefined();
          expect(Object.keys(canary)).toEqual([]);
          expect(Object.prototype.hasOwnProperty.call(record, key)).toBe(true);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('fuzz: tagged template (lowerTaggedTemplate)', () => {
  const textPieceArb: fc.Arbitrary<string> = fc.oneof(
    fc.string({ maxLength: 30 }),
    fc.constantFrom(
      'color:red;',
      'width:100px',
      '{',
      '}',
      '{}',
      ';',
      ':',
      'display:flex',
      '&:hover{color:blue}',
      '@media (min-width: 600px){.x{color:red}}',
      '/* comment */',
      '"unterminated',
      '\0H0\0', // sentinel 偽装 (handle 参照の偽装)
      '\0R\0', // runtime marker 偽装
      'a{b{c',
    ),
  );

  const interpValueArb: fc.Arbitrary<unknown> = fc.oneof(
    fc.integer({ min: -1000, max: 1000 }),
    fc.string({ maxLength: 12 }),
    fc.constantFrom(undefined, null, {}, [], () => {}),
    // 毎 case で新規に作られる handle / object (同一 case 内では同じ参照)。
    fc.nat().map((): StyleObject => ({ display: 'flex' })),
    fc.nat().map((): ReturnType<typeof css> => css`
      color: red;
    `),
    fc.nat().map((): ReturnType<typeof css> => css({ width: 10 })),
  );

  it('任意の CSS text + interpolation で crash / hang なく決定的に lowering される', () => {
    fc.assert(
      fc.property(
        // interpolation 数 n (0..6) に対し strings は n+1 片。
        fc
          .nat(6)
          .chain((n: number): fc.Arbitrary<readonly [readonly string[], readonly unknown[]]> =>
            fc.tuple(
              fc.array(textPieceArb, { minLength: n + 1, maxLength: n + 1 }),
              fc.array(interpValueArb, { minLength: n, maxLength: n }),
            ),
          ),
        (input: readonly [readonly string[], readonly unknown[]]): void => {
          const strings: readonly string[] = input[0];
          const values: readonly unknown[] = input[1];
          // 例外そのものが fail。hang は test timeout (10s) で検出。
          const first: LoweredTemplate = lowerTaggedTemplate(strings, values);
          // 決定性 (同一入力に冪等)。
          expect(lowerTaggedTemplate(strings, values)).toEqual(first);
          // shape 契約。
          for (const atom of first.atoms) expect(atom.kind).toBe('static-atom');
          for (const parametric of first.parametrics) {
            expect(parametric.kind).toBe('parametric-atom');
          }
          for (const residual of first.residuals) expect(residual.kind).toBe('residual-rule');
        },
      ),
      { numRuns: 100 },
    );
  }, 10_000);
});

describe('fuzz: nested key (parseNestedKey)', () => {
  const selectorArb: fc.Arbitrary<string> = fc.oneof(
    fc.string({ minLength: 0, maxLength: 16 }),
    fc.string({ minLength: 0, maxLength: 8 }).map((s: string): string => `&${s}`),
    fc.string({ minLength: 0, maxLength: 8 }).map((s: string): string => `@media ${s}`),
    fc.string({ minLength: 0, maxLength: 8 }).map((s: string): string => `&:hover${s}`),
    fc.constantFrom(
      '&:hover',
      '&::before',
      '&:focus-visible',
      '& .tile',
      '& svg',
      '& > div',
      '&&',
      '&.active',
      '@media (min-width: 600px)',
      '@supports (display: grid)',
      '@container card (width > 400px)',
      '@unknown x',
      ':hover',
      'media',
    ),
  );

  it('任意の selector 文字列で例外なく null か正当な RuleContext を返す', () => {
    fc.assert(
      fc.property(selectorArb, (key: string): void => {
        // 例外そのものが fail。
        const verdict: ReturnType<typeof parseNestedKey> = parseNestedKey(key);
        // 決定性。
        expect(parseNestedKey(key)).toEqual(verdict);
        // '&' / '@' 始まりでなければ必ず null。
        if (!key.startsWith('&') && !key.startsWith('@')) {
          expect(verdict).toBeNull();
          return;
        }
        if (verdict === null) return;
        // 正当 context: 値は string / string[] / undefined のみ。
        for (const value of Object.values(verdict)) {
          if (Array.isArray(value)) {
            for (const entry of value) expect(typeof entry).toBe('string');
          } else if (value !== undefined) {
            expect(typeof value).toBe('string');
          }
        }
        // pseudo は combinator や空白を含まない単純 pseudo のみ。
        if (verdict.pseudo !== undefined) {
          expect(verdict.pseudo.length).toBeGreaterThan(0);
          expect(verdict.pseudo.join('')).not.toMatch(/[\s>+~]/);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('既知 selector の分類は不変 (代表値の固定)', () => {
    expect(parseNestedKey('&:hover')).toEqual({ pseudo: [':hover'] });
    expect(parseNestedKey('& .tile')).toEqual({ descendant: '.tile' });
    expect(parseNestedKey('@media (min-width: 600px)')).toEqual({
      media: '(min-width: 600px)',
    });
    expect(parseNestedKey('@layer base')).toEqual({ layer: 'base' });
    expect(parseNestedKey('& > div')).toEqual({ suffix: ' > div' });
    expect(parseNestedKey('&--mod')).toEqual({ suffix: '--mod' });
    expect(parseNestedKey('&&')).toBeNull();
    expect(parseNestedKey('@unknown x')).toBeNull();
    expect(parseNestedKey(':hover')).toBeNull();
  });
});
