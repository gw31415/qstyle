import { describe, expect, it } from 'vitest';
import { createStaticAtom } from './atom.js';
import type { ParametricAtom } from './ir.js';
import {
  createParametricAtom,
  hashParametricAtom,
  inferSlotType,
  serializeParametricCss,
  serializeParametricDecl,
} from './parametric.js';

describe('parametric atom', () => {
  it('shares identity across different variable names (DYN-010/029)', () => {
    // width: `${a}px` と width: `${b}px` は同一構造。
    const a = createParametricAtom({
      property: 'width',
      parts: [{ kind: 'slot', slotIndex: 0 }, { kind: 'text', text: 'px' }],
      slots: [{ valueType: 'length' }],
    });
    const b = createParametricAtom({
      property: 'width',
      parts: [{ kind: 'slot', slotIndex: 0 }, { kind: 'text', text: 'px' }],
      slots: [{ valueType: 'length' }],
    });
    expect(hashParametricAtom(a)).toBe(hashParametricAtom(b));
    expect(a.slots[0]?.id).toBe(b.slots[0]?.id);
  });

  it('does not share across different properties (DED-011)', () => {
    const w = createParametricAtom({
      property: 'width',
      parts: [{ kind: 'slot', slotIndex: 0 }],
      slots: [{ valueType: 'length' }],
    });
    const h = createParametricAtom({
      property: 'height',
      parts: [{ kind: 'slot', slotIndex: 0 }],
      slots: [{ valueType: 'length' }],
    });
    expect(hashParametricAtom(w)).not.toBe(hashParametricAtom(h));
  });

  it('dedupes to one ParametricAtom across different runtime slot values (DED-010)', () => {
    // runtime 構造が同じで値だけ違う宣言群 (width: 1px / 42px) は同一
    // ParametricAtom になる。slot 値 (fallback) は semantic hash に含まれず、
    // serialize された要素側 (var() 参照) にのみ現れる。
    const make = (fallback: string | undefined): ParametricAtom =>
      createParametricAtom({
        property: 'width',
        parts: [{ kind: 'slot', slotIndex: 0 }, { kind: 'text', text: 'px' }],
        slots: [
          {
            valueType: 'integer',
            ...(fallback === undefined ? {} : { fallback }),
          },
        ],
      });
    const one: ParametricAtom = make('1');
    const two: ParametricAtom = make('42');
    const fallbackless: ParametricAtom = make(undefined);
    // 値違い (fallback の有無も含む) で hash は同一 = 単一 atom に dedup される。
    expect(hashParametricAtom(one)).toBe(hashParametricAtom(two));
    expect(hashParametricAtom(one)).toBe(hashParametricAtom(fallbackless));
    // slot id も構造 hash 由来のため同一。
    expect(one.slots[0]?.id).toBe(two.slots[0]?.id);
    expect(one.slots[0]?.id).toBe(fallbackless.slots[0]?.id);
    // 値は要素側: serialize された CSS text の var() 第 2 引数にのみ現れる。
    expect(serializeParametricDecl(one)).toBe(`width:var(${one.slots[0]?.id}, 1)px`);
    expect(serializeParametricDecl(two)).toBe(`width:var(${two.slots[0]?.id}, 42)px`);
    // 値を除いて比較すれば宣言構造は完全に同一。
    expect(serializeParametricDecl(one).replace(', 1)', ')')).toBe(
      serializeParametricDecl(fallbackless),
    );
  });

  it('serializes compound values with var() refs (DYN-006/007)', () => {
    const atom = createParametricAtom({
      property: 'transform',
      parts: [
        { kind: 'text', text: 'translate(' },
        { kind: 'slot', slotIndex: 0 },
        { kind: 'text', text: ', ' },
        { kind: 'slot', slotIndex: 1 },
        { kind: 'text', text: ') scale(' },
        { kind: 'slot', slotIndex: 2 },
        { kind: 'text', text: ')' },
      ],
      slots: [{ valueType: 'length' }, { valueType: 'length' }, { valueType: 'number' }],
    });
    const css: string = serializeParametricCss(atom, 'q_x');
    expect(css).toContain('var(--qstyle-');
    expect(css.match(/var\(--qstyle-[0-9a-f]{6}-\d\)/g)).toHaveLength(3);
    // 各 slot は独立更新可能 (DYN-007): id が slot ごとに異なる。
    const ids = new Set(atom.slots.map((s) => s.id));
    expect(ids.size).toBe(3);
  });

  it('supports pseudo context with slots (DYN-008)', () => {
    const atom = createParametricAtom({
      property: 'color',
      parts: [{ kind: 'slot', slotIndex: 0 }],
      slots: [{ valueType: 'color' }],
      context: { pseudo: [':hover'] },
    });
    expect(serializeParametricCss(atom, 'q_h')).toContain(':hover');
  });

  it('rejects slotIndex out of range with actionable message', () => {
    expect(() =>
      createParametricAtom({
        property: 'width',
        parts: [{ kind: 'slot', slotIndex: 2 }],
        slots: [{ valueType: 'length' }],
      }),
    ).toThrow(/slotIndex 2 out of range/);
  });
});

describe('parametric serialize semantics', () => {
  it('keeps the unit text after the var() reference (DYN-002)', () => {
    // `width: ${n}px` 相当: 単位は静的 text 部分に残り、slot は値のみを受け持つ。
    const atom = createParametricAtom({
      property: 'width',
      parts: [{ kind: 'slot', slotIndex: 0 }, { kind: 'text', text: 'px' }],
      slots: [{ valueType: 'integer' }],
    });
    expect(serializeParametricDecl(atom)).toBe(`width:var(${atom.slots[0]?.id})px`);
  });

  it('types dynamic colors without inventing a unit (DYN-004)', () => {
    // hex / rgb / hsl 関数形式は color 型に推論できる。
    expect(inferSlotType('#00ff00')).toBe('color');
    expect(inferSlotType('rgb(1, 2, 3)')).toBe('color');
    expect(inferSlotType('hsl(120 50% 50%)')).toBe('color');
    expect(inferSlotType('rgba(0, 0, 0, 0.5)')).toBe('color');
    // named color は best-effort では推論しない (現状固定)。
    expect(inferSlotType('red')).toBe('custom');
    // `color: ${c}` 相当の slot は custom 型で、serialize は var() のみ。
    const atom = createParametricAtom({
      property: 'color',
      parts: [{ kind: 'slot', slotIndex: 0 }],
      slots: [{ valueType: 'color' }],
    });
    expect(serializeParametricDecl(atom)).toBe(`color:var(${atom.slots[0]?.id})`);
  });

  it('keeps angle and time unit semantics (DYN-005)', () => {
    expect(inferSlotType('90deg')).toBe('angle');
    expect(inferSlotType('0.5turn')).toBe('angle');
    expect(inferSlotType('1.5rad')).toBe('angle');
    expect(inferSlotType('250ms')).toBe('time');
    expect(inferSlotType('2s')).toBe('time');
    // `transform: rotate(${deg}deg)` 相当: 単位は静的 text 側に残る。
    const atom = createParametricAtom({
      property: 'transform',
      parts: [
        { kind: 'text', text: 'rotate(' },
        { kind: 'slot', slotIndex: 0 },
        { kind: 'text', text: 'deg)' },
      ],
      slots: [{ valueType: 'angle' }],
    });
    expect(serializeParametricDecl(atom)).toBe(
      `transform:rotate(var(${atom.slots[0]?.id})deg)`,
    );
    // `transition-duration: ${ms}ms` 相当も同様。
    const duration = createParametricAtom({
      property: 'transition-duration',
      parts: [{ kind: 'slot', slotIndex: 0 }, { kind: 'text', text: 'ms' }],
      slots: [{ valueType: 'time' }],
    });
    expect(serializeParametricDecl(duration)).toBe(
      `transition-duration:var(${duration.slots[0]?.id})ms`,
    );
  });

  it('turns arbitrary runtime values into shared ParametricAtoms (DYN-017)', () => {
    // 値が何であれ構造だけが identity になる: 同一構造は同一 hash。
    const a = createParametricAtom({
      property: 'background-image',
      parts: [{ kind: 'slot', slotIndex: 0 }],
      slots: [{ valueType: 'custom' }],
    });
    const b = createParametricAtom({
      property: 'background-image',
      parts: [{ kind: 'slot', slotIndex: 0 }],
      slots: [{ valueType: 'custom' }],
    });
    expect(a.kind).toBe('parametric-atom');
    expect(hashParametricAtom(a)).toBe(hashParametricAtom(b));
    expect(a.slots[0]?.id).toBe(b.slots[0]?.id);
  });

  it('keeps hostile runtime values inside the var() reference (DYN-019)', () => {
    // runtime 値は atom に載らないため、攻撃的文字列を含む値が
    // declaration 境界を脱出する経路は存在しない。serialize は var() 参照のみ。
    const atom = createParametricAtom({
      property: 'transform',
      parts: [{ kind: 'slot', slotIndex: 0 }],
      slots: [{ valueType: 'custom' }],
    });
    const decl: string = serializeParametricDecl(atom);
    const css: string = serializeParametricCss(atom, 'q_x');
    expect(decl).toBe(`transform:var(${atom.slots[0]?.id})`);
    expect(css).toBe(`.q_x{transform:var(${atom.slots[0]?.id})}`);
    // 攻撃 corpus (`; } body { background: red`) が流出しない。
    expect(decl).not.toContain(';');
    expect(decl).not.toContain('}');
    expect(css).not.toContain('body');
    expect(css).not.toContain(';');
    // rule を閉じる `}` は末尾の 1 個のみ。
    expect(css.match(/\}/g)).toHaveLength(1);
    // fallback 経由の注入も作れない (境界を壊す fallback は生成時に拒否)。
    expect(() =>
      createParametricAtom({
        property: 'color',
        parts: [{ kind: 'slot', slotIndex: 0 }],
        slots: [{ valueType: 'custom', fallback: "red); } body { background: red" }],
      }),
    ).toThrow(/fallback/);
  });

  it('serializes slot fallbacks for nullish runtime values (DYN-020)', () => {
    // fallback 付き: nullish 値は var() の第 2 引数で補完される。
    const withFallback = createParametricAtom({
      property: 'width',
      parts: [{ kind: 'slot', slotIndex: 0 }, { kind: 'text', text: 'px' }],
      slots: [{ valueType: 'integer', fallback: '0' }],
    });
    expect(serializeParametricDecl(withFallback)).toBe(
      `width:var(${withFallback.slots[0]?.id}, 0)px`,
    );
    // fallback なし: nullish 値は custom property 未設定となり、
    // var() は guaranteed-invalid → property は未設定として扱われる (CSS 仕様)。
    const withoutFallback = createParametricAtom({
      property: 'width',
      parts: [{ kind: 'slot', slotIndex: 0 }, { kind: 'text', text: 'px' }],
      slots: [{ valueType: 'integer' }],
    });
    expect(withoutFallback.slots[0]?.fallback).toBeUndefined();
    expect(serializeParametricDecl(withoutFallback)).toBe(
      `width:var(${withoutFallback.slots[0]?.id})px`,
    );
  });

  it('namespaces generated custom properties under the reserved --qstyle- prefix (DYN-024)', () => {
    const atom = createParametricAtom({
      property: 'padding',
      parts: [
        { kind: 'slot', slotIndex: 0 },
        { kind: 'text', text: 'px ' },
        { kind: 'slot', slotIndex: 1 },
        { kind: 'text', text: 'px' },
      ],
      slots: [{ valueType: 'length' }, { valueType: 'length' }],
    });
    // slot id は常に `--qstyle-<hash6>-<index>`。`--q-*` 等の user 変数と
    // 接頭辞が異なるため衝突しない。
    for (const slot of atom.slots) {
      expect(slot.id).toMatch(/^--qstyle-[0-9a-f]{6}-\d+$/);
    }
    // user 側 custom property は property として素通し (slot id への書き換えなし)。
    const user = createStaticAtom({ property: '--q-x', value: '1px' });
    expect(user.property).toBe('--q-x');
    expect(user.value).toBe('1px');
    // 同一構造からは常に同一 id (決定的。衝突policyの前提)。
    const rebuilt = createParametricAtom({
      property: 'padding',
      parts: [
        { kind: 'slot', slotIndex: 0 },
        { kind: 'text', text: 'px ' },
        { kind: 'slot', slotIndex: 1 },
        { kind: 'text', text: 'px' },
      ],
      slots: [{ valueType: 'length' }, { valueType: 'length' }],
    });
    expect(rebuilt.slots.map((s) => s.id)).toEqual(atom.slots.map((s) => s.id));
  });
});

describe('inferSlotType', () => {
  it('infers common types (DYN-001..005)', () => {
    expect(inferSlotType(42)).toBe('integer');
    expect(inferSlotType(1.5)).toBe('number');
    expect(inferSlotType('12px')).toBe('length');
    expect(inferSlotType('50%')).toBe('percentage');
    expect(inferSlotType('#f00')).toBe('color');
    expect(inferSlotType('90deg')).toBe('angle');
    expect(inferSlotType('200ms')).toBe('time');
    expect(inferSlotType({})).toBe('custom');
  });
});
