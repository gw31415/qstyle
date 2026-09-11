import { describe, expect, it } from 'vitest';
import { orderableProperties, reorderCss } from './css-order.js';
import { analyzeCssOptimization, measureCss, mergeCssCandidates, groupDuplicateCss } from './dedup.js';
import type { DedupMeta } from './dedup.js';

const meta: DedupMeta = { unitTags: new Map(), condUnitIds: new Set() };

describe('compression ordering with hard cascade dependencies', () => {
  it('clusters independent rules instead of sorting by generated class hash', () => {
    const css = '.q_aaaaaaaa{color:red}.q_bbbbbbbb{color:blue}.q_cccccccc{color:green}';
    expect(reorderCss(css, meta, 'source', 'body')).toBe(
      '.q_bbbbbbbb{color:blue}.q_cccccccc{color:green}.q_aaaaaaaa{color:red}',
    );
  });

  it('retains source order when equal-specificity selectors may overlap', () => {
    const css = '.q_aaaaaaaa:hover{color:red}.q_aaaaaaaa:focus{color:blue}' +
      '.q_aaaaaaaa .foo{background:red}.q_bbbbbbbb .bar{background:blue}';
    for (const order of ['body', 'properties', 'similarity'] as const) {
      const out = reorderCss(css, meta, 'alphabetical', order);
      expect(out.indexOf(':hover')).toBeLessThan(out.indexOf(':focus'));
      expect(out.indexOf('.foo')).toBeLessThan(out.indexOf('.bar'));
    }
  });

  it('retains dependencies between overlapping selector lists', () => {
    const css = '.q_aaaaaaaa,.q_bbbbbbbb{color:red}.q_bbbbbbbb,.q_cccccccc{color:blue}';
    expect(reorderCss(css, meta, 'source', 'body')).toBe(css);
  });

  it('can reorder a base and pseudo rule when specificity already decides precedence', () => {
    const css = '.q_aaaaaaaa:hover{color:red}.q_aaaaaaaa{color:blue}';
    expect(reorderCss(css, meta, 'source', 'body')).toBe('.q_aaaaaaaa{color:blue}.q_aaaaaaaa:hover{color:red}');
  });

  it.each([
    '.q_aaaaaaaa{color:red}.legacy{color:green}.q_bbbbbbbb{color:blue}',
    '.q_aaaaaaaa DIV{color:red}.q_bbbbbbbb div{color:blue}',
    '.q_aaaaaaaa{color:red}/* preserve boundary */.q_bbbbbbbb{color:blue}',
    '@media (width>1px){.q_aaaaaaaa{color:red}}@media (width>1px){.q_bbbbbbbb{color:blue}}',
    '.q_aaaaaaaa{display:-webkit-box;display:flex}.q_bbbbbbbb{color:blue}',
    '.q_aaaaaaaa{color:red}.q_bbbbbbbb:where(.active){color:blue}',
  ])('preserves opaque boundaries and fallback chains: %s', (css) => {
    expect(reorderCss(css, meta, 'alphabetical', 'body')).toBe(css);
  });

  it('treats conditional units as barriers', () => {
    const css = '.q_aaaaaaaa{color:red}.q_bbbbbbbb{color:green}.q_cccccccc{color:blue}';
    expect(reorderCss(css, { ...meta, condUnitIds: new Set(['q_bbbbbbbb']) }, 'source', 'body')).toBe(css);
  });

  it('sorts only known independent longhands and preserves resets and logical aliases', () => {
    const css = '.q_aaaaaaaa{font-size:20px;font:12px monospace;margin-left:2px;margin-inline-start:3px;' +
      'width:4px;future-width:reset;height:5px;color:red}';
    const out = reorderCss(css, meta, 'alphabetical', 'source', [...orderableProperties(css)].reverse());
    expect(out.indexOf('font-size:')).toBeLessThan(out.indexOf('font:'));
    expect(out.indexOf('margin-left:')).toBeLessThan(out.indexOf('margin-inline-start:'));
    expect(out.indexOf('width:')).toBeLessThan(out.indexOf('future-width:'));
    expect(out.indexOf('future-width:')).toBeLessThan(out.indexOf('height:'));
    expect(out).toContain('color:red');
  });

  it('does not assume a new property is independent of a known reset', () => {
    const css = '.q_aaaaaaaa{z-index:1;new-font-width:2px;font:12px serif;color:red}';
    const out = reorderCss(css, meta, 'alphabetical', 'source');
    expect(out.indexOf('z-index')).toBeLessThan(out.indexOf('new-font-width'));
    expect(out.indexOf('new-font-width')).toBeLessThan(out.indexOf('font:'));
  });

  it.each([
    ['grid-template:"b" 100px / 100px', 'grid-template-areas:"a"'],
    ['columns:100px 2', 'column-width:200px'],
  ])('does not move shorthands across an overlapping reset: %s', (shared, blocker) => {
    const css = `.q_aaaaaaaa:hover{${shared}}.q_cccccccc .foo{${blocker}}.q_bbbbbbbb:hover{${shared}}`;
    expect(groupDuplicateCss(css, meta)).toBe(css);
  });

  it('offers local partial merges as well as one maximal selector list', () => {
    const long = 'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
    const css = Array.from({ length: 8 }, (_, i) => `.q_${i.toString(16).padStart(8, '0')}{${long};opacity:${i / 10}}`).join('');
    const candidates = mergeCssCandidates(css, meta, 64);
    expect(candidates.some((candidate) => candidate.includes(`.q_00000000,.q_00000001{${long}}`))).toBe(true);
    expect(candidates.some((candidate) => candidate.includes(`.q_00000006,.q_00000007{${long}}`))).toBe(true);
    for (const candidate of candidates) expect(candidate.length).toBeLessThan(css.length);
  });

  it('finds deterministic codec wins without requiring additional declaration sharing', () => {
    const css = Array.from({ length: 16 }, (_, i) => {
      const declarations = [`color:rgb(${i},${i},${i})`, `width:${i + 10}px`, 'display:flex', 'align-items:center'];
      if (i % 2 === 0) declarations.reverse();
      return `.q_${i.toString(16).padStart(8, '0')}{${declarations.join(';')}}`;
    }).join('');
    const report = analyzeCssOptimization(css, meta);
    const before = measureCss(css);
    expect(report.selected.gzip).toBeLessThan(before.gzip);
    expect(report.selected.brotli).toBeLessThan(before.brotli);
    expect(report.selected.raw).toBeLessThanOrEqual(before.raw);
    expect(analyzeCssOptimization(css, meta)).toEqual(report);
    expect(report.evaluatedCandidates).toBeLessThanOrEqual(512);
  });
});
