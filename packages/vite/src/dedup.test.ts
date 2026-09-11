import { describe, expect, it } from 'vitest';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { groupDuplicateCss, optimizeDuplicateCss } from './dedup.js';

const TAGS = (record: Record<string, string[]>): ReadonlyMap<string, ReadonlySet<string>> => {
  const out = new Map<string, Set<string>>();
  for (const [k, v] of Object.entries(record)) out.set(k, new Set(v));
  return out;
};

describe('groupDuplicateCss (byte-cost declaration sharing)', () => {
  const meta = { unitTags: TAGS({}), condUnitIds: new Set<string>() };

  it('shares one declaration among three or more rules', () => {
    const css = '.q_aaaaaaaa{color:red}.q_bbbbbbbb{color:red}.q_cccccccc{color:red}';
    expect(groupDuplicateCss(css, meta)).toBe('.q_aaaaaaaa,.q_bbbbbbbb,.q_cccccccc{color:red}');
  });

  it('keeps a repeated short declaration when the selector overhead costs more', () => {
    const css = '.q_aaaaaaaa{color:red;margin:0}.q_bbbbbbbb{color:red;padding:0}';
    expect(groupDuplicateCss(css, meta)).toBe(css);
  });

  it('chooses byte savings over the number of shared declarations', () => {
    const long = 'font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace';
    const css = `.q_aaaaaaaa{${long};color:red;opacity:1}.q_bbbbbbbb{${long}}.q_cccccccc{color:red;opacity:1}`;
    const candidates: string[] = [];
    groupDuplicateCss(css, meta, (candidate) => candidates.push(candidate));
    expect(candidates[0]).toContain(`.q_aaaaaaaa,.q_bbbbbbbb{${long}}`);
    expect(candidates[0]).toContain('.q_cccccccc{color:red;opacity:1}');
  });

  it('counts UTF-8 bytes when deciding whether extraction pays for selectors', () => {
    const decl = 'font-family:"あいうえおかきくけこ"';
    const css = `.q_aaaaaaaa{${decl};color:red}.q_bbbbbbbb{${decl};color:blue}`;
    const out = groupDuplicateCss(css, meta);
    expect(out).toContain(`.q_aaaaaaaa,.q_bbbbbbbb{${decl}}`);
    expect(Buffer.byteLength(out)).toBeLessThan(Buffer.byteLength(css));
  });

  it('keeps separate occurrences of identical at-rule wrappers', () => {
    const css = '@media (width>1px){.q_aaaaaaaa{color:red}}.x{color:blue}' +
      '@media (width>1px){.q_bbbbbbbb{color:red}.q_cccccccc{color:red}}';
    const out = groupDuplicateCss(css, meta);
    expect(out).toContain('@media (width>1px){.q_aaaaaaaa{color:red}}.x{color:blue}');
    expect(out).toContain('@media (width>1px){.q_bbbbbbbb,.q_cccccccc{color:red}}');
  });

  it('forms safe groups on either side of an unknown cascade blocker', () => {
    const css = '.q_aaaaaaaa{color:red}.q_bbbbbbbb{color:red}.x{color:blue}' +
      '.q_cccccccc{color:red}.q_dddddddd{color:red}.q_eeeeeeee{color:red}';
    expect(groupDuplicateCss(css, meta)).toBe(
      '.q_aaaaaaaa,.q_bbbbbbbb{color:red}.x{color:blue}' +
      '.q_cccccccc,.q_dddddddd,.q_eeeeeeee{color:red}',
    );
  });

  it.each([
    '.q_aaaaaaaa{margin-left:1px;margin:0}.q_bbbbbbbb{margin:0;margin-left:1px}',
    '.q_aaaaaaaa{display:-webkit-box;display:flex}.q_bbbbbbbb{display:flex}',
    '.q_aaaaaaaa{color:red}.x{all:unset}.q_bbbbbbbb{color:red}',
    '.q_aaaaaaaa{color:red}.q_bbbbbbbb{color:red}.broken{',
  ])('preserves fallback declarations, shorthand conflicts, resets and invalid CSS: %s', (css) => {
    expect(groupDuplicateCss(css, meta)).toBe(css);
  });

  it('keeps semicolons inside strings and functions intact', () => {
    const decl = 'content:"a;b";background-image:url("data:image/png;base64,abcd")';
    const css = `.q_aaaaaaaa{${decl}}.q_bbbbbbbb{${decl}}.q_cccccccc{${decl}}`;
    const out = groupDuplicateCss(css, meta);
    expect(out).toContain('content:"a;b"');
    expect(out).toContain('background-image:url("data:image/png;base64,abcd")');
    expect(out.match(/content:/g)).toHaveLength(1);
  });

  it('accepts compression wins while rejecting raw-only wins', () => {
    const short = Array.from({ length: 8 }, (_, i) =>
      `.q_${(((i + 1) * 2654435761) >>> 0).toString(16).padStart(8, '0')}{font-weight:700;opacity:${i / 10}}`,
    ).join('');
    expect(groupDuplicateCss(short, meta).length).toBeLessThan(short.length);
    expect(optimizeDuplicateCss(short, meta)).toBe(short);
    const css = Array.from({ length: 8 }, (_, i) =>
      `.q_${i.toString(16).padStart(8, '0')}{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:rebeccapurple;font-weight:700}`,
    ).join('');
    const out = optimizeDuplicateCss(css, meta);
    expect(out).not.toBe(css);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(Buffer.byteLength(css));
    expect(gzipSync(out).length).toBeLessThanOrEqual(gzipSync(css).length);
    expect(brotliCompressSync(out).length).toBeLessThanOrEqual(brotliCompressSync(css).length);
    expect(optimizeDuplicateCss(css, meta)).toBe(out);
  });

  it('preserves every selector/property value across heterogeneous groups', () => {
    const values = ['color:rebeccapurple', 'color:blue', 'font-weight:700',
      'font-weight:400', 'display:block', 'display:flex', 'opacity:1', 'opacity:.5'];
    const declarations = (css: string): Map<string, Record<string, string>> => {
      const result = new Map<string, Record<string, string>>();
      for (const match of css.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
        for (const selector of match[1]!.split(',')) {
          const properties = result.get(selector) ?? {};
          for (const decl of match[2]!.split(';')) {
            const colon = decl.indexOf(':');
            properties[decl.slice(0, colon)] = decl.slice(colon + 1);
          }
          result.set(selector, properties);
        }
      }
      return result;
    };
    let state = 12345;
    for (let example = 0; example < 20; example++) {
      const css = Array.from({ length: 12 }, (_, i) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const decls = [0, 2, 4, 6].map((offset) => values[offset + ((state >>> offset) & 1)]);
        return `.q_${i.toString(16).padStart(8, '0')}{${decls.join(';')}}`;
      }).join('');
      const out = groupDuplicateCss(css, meta);
      expect(declarations(out)).toEqual(declarations(css));
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(Buffer.byteLength(css));
    }
  });

  it.each(['', ';margin:0'])('extracts multiple profitable groups from one rule with remainder %j', (remainder) => {
    const css =
      `.q_aaaaaaaa{color:rebeccapurple;text-align:justify${remainder}}` +
      '.q_bbbbbbbb{color:rebeccapurple}.q_cccccccc{text-align:justify}';
    const meta = { unitTags: TAGS({}), condUnitIds: new Set<string>() };
    const out = groupDuplicateCss(css, meta);
    expect(out).toBe(
      '.q_aaaaaaaa,.q_cccccccc{text-align:justify}' +
      '.q_aaaaaaaa,.q_bbbbbbbb{color:rebeccapurple}' +
      (remainder === '' ? '' : '.q_aaaaaaaa{margin:0}'),
    );
    expect(groupDuplicateCss(out, meta)).toBe(out);
  });

  it('rewrites a shared member once when profitable groups are inserted at different rules', () => {
    const css =
      '@media (min-width:100px){' +
      '.q_aaaaaaaa{background-color:rebeccapurple;margin:0}' +
      '.q_bbbbbbbb{font-family:ui-monospace,Consolas,monospace;padding:0}' +
      '.q_cccccccc{background-color:rebeccapurple;font-family:ui-monospace,Consolas,monospace;display:block}}';
    expect(groupDuplicateCss(css, { unitTags: TAGS({}), condUnitIds: new Set() })).toBe(
      '@media (min-width:100px){' +
      '.q_aaaaaaaa,.q_cccccccc{background-color:rebeccapurple}.q_aaaaaaaa{margin:0}' +
      '.q_bbbbbbbb,.q_cccccccc{font-family:ui-monospace,Consolas,monospace}.q_bbbbbbbb{padding:0}' +
      '.q_cccccccc{display:block}}',
    );
  });

  it('groups the icon svg rule with the halo rule and keeps remainders', () => {
    const css =
      '.q_86ea7cd0 svg{width:100%;height:100%;display:block}' +
      '.q_86ea7cd0{color:currentColor;height:calc(var(--spacing) * 4);width:calc(var(--spacing) * 4);flex-shrink:0}' +
      '.q_8e4b2a0b{animation:ping-halo 1.2s var(--ease-snap) infinite;width:100%;height:100%;display:block}';
    const out = groupDuplicateCss(css, {
      unitTags: TAGS({ q_86ea7cd0: ['span'], q_8e4b2a0b: ['span'] }),
      condUnitIds: new Set(),
    });
    // svg ルールは全宣言が共有されたため消え、グループ rule は先頭位置に入る。
    // decl は正規化 (sort 済み) 順で出力される。
    expect(out).toBe(
      '.q_86ea7cd0 svg,.q_8e4b2a0b{display:block;height:100%;width:100%}' +
        '.q_86ea7cd0{color:currentColor;height:calc(var(--spacing) * 4);width:calc(var(--spacing) * 4);flex-shrink:0}' +
        '.q_8e4b2a0b{animation:ping-halo 1.2s var(--ease-snap) infinite}',
    );
  });

  it('merges two identical base rules', () => {
    const css = '.q_aaaabbbb{color:red}.q_aaaabbbb:hover{color:blue}.q_ccccdddd{color:red}';
    const out = groupDuplicateCss(css, {
      unitTags: TAGS({ q_aaaabbbb: ['div'], q_ccccdddd: ['span'] }),
      condUnitIds: new Set(),
    });
    // base 同士をグループ化し、:hover ルールは独立のまま
    expect(out).toBe('.q_aaaabbbb,.q_ccccdddd{color:red}.q_aaaabbbb:hover{color:blue}');
  });

  it('does not group across different at-rule scopes', () => {
    const css =
      '@media (min-width:100px){.q_aaaabbbb{color:red}}.q_ccccdddd{color:red}';
    const out = groupDuplicateCss(css, {
      unitTags: TAGS({ q_aaaabbbb: ['div'], q_ccccdddd: ['span'] }),
      condUnitIds: new Set(),
    });
    expect(out).toBe(css);
  });

  it('does not group when an unprovable equal-specificity rule sits between', () => {
    // 非 qstyle ルール (.foo) は非共存を証明できない
    const css = '.q_aaaabbbb{color:red}.foo{color:blue}.q_ccccdddd{color:red}';
    const out = groupDuplicateCss(css, {
      unitTags: TAGS({ q_aaaabbbb: ['div'], q_ccccdddd: ['span'] }),
      condUnitIds: new Set(),
    });
    expect(out).toBe(css);
  });

  it('does not group when the blocker is a conditional unit', () => {
    const css = '.q_aaaabbbb{color:red}.q_cond0001{color:blue}.q_ccccdddd{color:red}';
    const out = groupDuplicateCss(css, {
      unitTags: TAGS({ q_aaaabbbb: ['div'], q_ccccdddd: ['span'], q_cond0001: ['div'] }),
      condUnitIds: new Set(['q_cond0001']),
    });
    expect(out).toBe(css);
  });

  it('does not group when the descendant tag matches the blocker tag', () => {
    // `.q_aaaabbbb span` の要素は blocker (.q_aaaabbbb の width 宣言) のタグ (span) と
    // 重なりうるため、詳細度一致 + 宣言共有の blocker がいる場合はグループ化しない
    const css =
      '.q_aaaabbbb span{width:100%}.q_aaaabbbb{width:50%}.q_ccccdddd{width:100%}';
    const out = groupDuplicateCss(css, {
      unitTags: TAGS({ q_aaaabbbb: ['span'], q_ccccdddd: ['span'] }),
      condUnitIds: new Set(),
    });
    expect(out).toBe(css);
  });

  it('does not use a descendant class name as evidence about HTML tags', () => {
    const css = '.q_aaaaaaaa{color:red}.q_cccccccc{color:blue}.q_bbbbbbbb .foo{color:red}';
    expect(groupDuplicateCss(css, {
      unitTags: TAGS({ q_cccccccc: ['div'] }), condUnitIds: new Set(),
    })).toBe(css);
  });

  it('is idempotent', () => {
    const css =
      '.q_86ea7cd0 svg{width:100%;height:100%;display:block}' +
      '.q_8e4b2a0b{animation:ping-halo 1.2s var(--ease-snap) infinite;width:100%;height:100%;display:block}';
    const once = groupDuplicateCss(css, {
      unitTags: TAGS({ q_86ea7cd0: ['span'], q_8e4b2a0b: ['span'] }),
      condUnitIds: new Set(),
    });
    const twice = groupDuplicateCss(once, {
      unitTags: TAGS({ q_86ea7cd0: ['span'], q_8e4b2a0b: ['span'] }),
      condUnitIds: new Set(),
    });
    expect(twice).toBe(once);
  });
});
