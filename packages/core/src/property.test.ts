// Property-based invariants (plan.md B-4): fast-check による不変性の固定。
//
// 対象は core の純関数経路 (createStaticAtom / hashStaticAtom / DedupRegistry /
// createParametricAtom / hashParametricAtom / assignOrderingGroups)。
// object syntax の lowering 自体 (lowerStyleObject) は @qstyle/qwik 側にあり
// core からは import できないため、同一の canonicalization 経路
// (createStaticAtom = property の kebab-case 化 + 値の serialize) を直接通す。
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DedupRegistry,
  assignOrderingGroups,
  createParametricAtom,
  createStaticAtom,
  hashParametricAtom,
  hashStaticAtom,
  serializeParametricDecl,
} from './index.js';
import type { ParametricAtom, RuntimeValueType, StaticAtom } from './index.js';

/** 相互に独立な property 8 種 (shorthand 祖先 / logical axis を共有しない)。 */
interface PropertySpec {
  readonly property: string;
  readonly value: string | number;
}

const INDEPENDENT_SPECS: readonly PropertySpec[] = [
  { property: 'color', value: 'crimson' },
  { property: 'width', value: '120px' },
  { property: 'display', value: 'flex' },
  { property: 'opacity', value: '0.5' },
  { property: 'z-index', value: 10 },
  { property: 'gap', value: 4 },
  { property: 'border-radius', value: '4px' },
  { property: 'flex-direction', value: 'column' },
];

const specArb: fc.Arbitrary<PropertySpec> = fc.constantFrom(...INDEPENDENT_SPECS);

/** fallback / template text に安全な文字のみ (hasInvalidDeclarationChars に掛からない)。 */
const SAFE_CHARS: readonly string[] = [
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '.', '-', '%', 'a', 'b', 'c', 'd', 'e', 'f', '#',
];

const safeTextArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SAFE_CHARS), { minLength: 1, maxLength: 12 })
  .map((chars: readonly string[]): string => chars.join(''));

// determinism.test.ts と同一の決定的 shuffle (LCG seed 付き Fisher-Yates)。
function lcgRandom(seed: number): () => number {
  let state: number = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function fisherYatesShuffle<T>(input: readonly T[], seed: number): readonly T[] {
  const random: () => number = lcgRandom(seed);
  const result: T[] = [...input];
  for (let i: number = result.length - 1; i > 0; i -= 1) {
    const j: number = Math.floor(random() * (i + 1));
    const tmp: T = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }
  return result;
}

describe('property-based invariants (fast-check)', () => {
  it('順列不変: 独立 property set の宣言順序によらず atom id 集合が同一', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(specArb, { minLength: 2, maxLength: 5 }),
        fc.integer({ min: 1, max: 0x7fffffff }),
        (specs: readonly PropertySpec[], seed: number): void => {
          const canonical: readonly PropertySpec[] = [...specs].sort((a, b) =>
            a.property.localeCompare(b.property),
          );
          const baseline: readonly string[] = canonical.map((spec: PropertySpec): string =>
            hashStaticAtom(createStaticAtom(spec)),
          );
          const shuffled: readonly PropertySpec[] = fisherYatesShuffle(specs, seed);
          const ids: readonly string[] = shuffled.map((spec: PropertySpec): string =>
            hashStaticAtom(createStaticAtom(spec)),
          );
          // 集合として同一 (順序は問わない)。
          expect([...ids].sort()).toEqual([...baseline].sort());
          // atom 間で hash 衝突していない。
          expect(new Set<string>(ids).size).toBe(specs.length);
          // 独立 property は ordering group を持たない (= 順列で group 割当が変化しない)。
          const grouped: readonly StaticAtom[] = assignOrderingGroups(
            shuffled.map((spec: PropertySpec): StaticAtom => createStaticAtom(spec)),
          );
          for (const atom of grouped) {
            expect(atom.ordering.group).toBeUndefined();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('occurrence 不変: 同一宣言の重複回数によらず semantic atom set が同一', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(specArb, fc.integer({ min: 0, max: 4 })), {
          minLength: 1,
          maxLength: 10,
        }),
        (entries: readonly (readonly [PropertySpec, number])[]): void => {
          const registry: DedupRegistry = new DedupRegistry();
          for (const [spec, extra] of entries) {
            const atom: StaticAtom = createStaticAtom({
              property: spec.property,
              value: spec.value,
            });
            // 1 + extra 回 (1〜5 回) 同一宣言を add する。
            for (let i: number = 0; i <= extra; i += 1) registry.add(atom);
          }
          const byProperty: Map<string, PropertySpec> = new Map<string, PropertySpec>();
          for (const [spec] of entries) byProperty.set(spec.property, spec);
          const expected: readonly string[] = [...byProperty.values()]
            .map((spec: PropertySpec): string => hashStaticAtom(createStaticAtom(spec)))
            .sort();
          // 出現回数を変えても registry の semantic atom set は同一。
          expect([...registry.ids()].sort()).toEqual(expected);
          expect(registry.size()).toBe(byProperty.size);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('slot 値不変: ParametricAtom の hash は slot fallback 値を含まない', () => {
    fc.assert(
      fc.property(safeTextArb, safeTextArb, (fallbackA: string, fallbackB: string): void => {
        const make = (fallback: string | undefined): ParametricAtom =>
          createParametricAtom({
            property: 'width',
            parts: [
              { kind: 'slot', slotIndex: 0 },
              { kind: 'text', text: 'px' },
            ],
            slots: [
              {
                valueType: 'integer',
                ...(fallback === undefined ? {} : { fallback }),
              },
            ],
          });
        const a: ParametricAtom = make(fallbackA);
        const b: ParametricAtom = make(fallbackB);
        const none: ParametricAtom = make(undefined);
        // 値が違っても (fallback なしでも) 同一構造 = 同一 hash / 同一 slot id。
        expect(hashParametricAtom(a)).toBe(hashParametricAtom(b));
        expect(hashParametricAtom(a)).toBe(hashParametricAtom(none));
        expect(a.slots[0]?.id).toBe(b.slots[0]?.id);
        expect(a.slots[0]?.id).toBe(none.slots[0]?.id);
        // serialize された CSS text は値を除けば構造安定 (値は var() 第 2 引数側のみ)。
        const id: string | undefined = none.slots[0]?.id;
        expect(id).toBeDefined();
        const withoutValue: string = serializeParametricDecl(none);
        for (const atom of [a, b]) {
          const withValue: string = serializeParametricDecl(atom);
          const fallback: string | undefined = atom.slots[0]?.fallback;
          expect(fallback).toBeDefined();
          expect(withValue).toBe(
            withoutValue.replace(`var(${id})`, `var(${id}, ${fallback})`),
          );
        }
      }),
      { numRuns: 100 },
    );
  });

  it('traversal 順不変: atom 作成順を shuffle しても各 atom id は同一', () => {
    const valueTypeArb: fc.Arbitrary<RuntimeValueType> = fc.constantFrom(
      'integer',
      'length',
      'color',
      'percentage',
      'custom',
    );
    interface ParametricSpec {
      readonly valueType: RuntimeValueType;
      readonly text: string;
    }
    type MixedSpec = PropertySpec | ParametricSpec;

    const atomOf = (spec: MixedSpec): StaticAtom | ParametricAtom =>
      'property' in spec
        ? createStaticAtom(spec)
        : createParametricAtom({
            property: 'transform',
            parts: [
              { kind: 'text', text: spec.text },
              { kind: 'slot', slotIndex: 0 },
            ],
            slots: [{ valueType: spec.valueType }],
          });

    const idOf = (spec: MixedSpec): string => {
      const atom: StaticAtom | ParametricAtom = atomOf(spec);
      return atom.kind === 'parametric-atom' ? hashParametricAtom(atom) : hashStaticAtom(atom);
    };

    const mixedSpecArb: fc.Arbitrary<MixedSpec> = fc.oneof(
      specArb,
      fc.record({ valueType: valueTypeArb, text: safeTextArb }) as fc.Arbitrary<ParametricSpec>,
    );

    fc.assert(
      fc.property(
        fc.uniqueArray(mixedSpecArb, { minLength: 2, maxLength: 8 }),
        fc.integer({ min: 1, max: 0x7fffffff }),
        (specs: readonly MixedSpec[], seed: number): void => {
          const baseline: Map<string, string> = new Map<string, string>();
          for (const spec of specs) baseline.set(JSON.stringify(spec), idOf(spec));
          // 作成順を shuffle してから id を取っても spec 毎の id は不変。
          const shuffled: readonly MixedSpec[] = fisherYatesShuffle(specs, seed);
          for (const spec of shuffled) {
            expect(idOf(spec)).toBe(baseline.get(JSON.stringify(spec)));
          }
          // 集合としても同一。
          expect(
            shuffled.map((spec: MixedSpec): string => idOf(spec)).sort(),
          ).toEqual([...baseline.values()].sort());
        },
      ),
      { numRuns: 100 },
    );
  });
});
