import { describe, expect, it } from 'vitest';
import { composeCssProp, flattenCssProp } from './compose.js';
import { css } from './index.js';

describe('flattenCssProp', () => {
  it('flattens nested arrays and drops falsy (CMP-005/006)', () => {
    const a = { display: 'flex' };
    const b = { color: 'red' };
    const flat = flattenCssProp([a, [b, false, null, undefined, [a]]]);
    expect(flat).toEqual([a, b, a]);
  });
});

describe('composeCssProp', () => {
  it('single handle equals inline object (CMP-001)', () => {
    const handle = css({ display: 'flex' });
    const fromHandle = composeCssProp([handle]);
    const fromInline = composeCssProp([{ display: 'flex' }]);
    expect(fromHandle.atoms.map((a) => [a.property, a.value])).toEqual(
      fromInline.atoms.map((a) => [a.property, a.value]),
    );
  });

  it('applies non-conflicting handles (CMP-002)', () => {
    const out = composeCssProp([css({ display: 'flex' }), css({ color: 'red' })]);
    expect(out.atoms).toHaveLength(2);
  });

  it('later handle wins on same property (CMP-003)', () => {
    const out = composeCssProp([css({ color: 'red' }), css({ color: 'blue' })]);
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]?.value).toBe('blue');
  });

  it('keeps left-to-right semantics across three (CMP-004)', () => {
    const out = composeCssProp([
      css({ color: 'red', display: 'flex' }),
      css({ color: 'green' }),
      css({ color: 'blue' }),
    ]);
    const color = out.atoms.filter((a) => a.property === 'color');
    expect(color).toHaveLength(1);
    expect(color[0]?.value).toBe('blue');
    expect(out.atoms.some((a) => a.property === 'display')).toBe(true);
  });

  it('supports conditional handles (CMP-007)', () => {
    const active = css({ color: 'red' });
    const out = composeCssProp([css({ display: 'flex' }), false && active]);
    expect(out.atoms).toHaveLength(1);
    const out2 = composeCssProp([css({ display: 'flex' }), true && active]);
    expect(out2.atoms).toHaveLength(2);
  });

  it('mixes handles and inline objects (CMP-008)', () => {
    const out = composeCssProp([css({ display: 'flex' }), { gap: 8 }]);
    expect(out.atoms).toHaveLength(2);
  });

  it('dedupes repeated handles without CSS duplication (CMP-010)', () => {
    const h = css({ display: 'flex' });
    const out = composeCssProp([h, h, h]);
    expect(out.atoms).toHaveLength(1);
  });

  it('dedupes semantically identical handles (CMP-011)', () => {
    const out = composeCssProp([css({ display: 'flex' }), css({ display: 'flex' })]);
    expect(out.atoms).toHaveLength(1);
  });

  it('keeps !important separate from normal priority (CMP-014)', () => {
    const out = composeCssProp([{ color: 'red' }, { color: 'blue !important' }]);
    // important flag が立つため conflict key が分かれ、両方保持される。
    expect(out.atoms).toHaveLength(2);
    const important = out.atoms.find((a) => a.important);
    expect(important?.value).toBe('blue');
    expect(out.atoms.find((a) => !a.important)?.value).toBe('red');
  });

  it('later !important wins over earlier !important', () => {
    const out = composeCssProp([
      { color: 'red !important' },
      { color: 'blue !important' },
    ]);
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]?.value).toBe('blue');
  });
});
