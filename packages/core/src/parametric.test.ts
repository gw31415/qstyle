import { describe, expect, it } from 'vitest';
import {
  createParametricAtom,
  hashParametricAtom,
  inferSlotType,
  serializeParametricCss,
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
