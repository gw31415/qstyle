import { describe, expect, it } from 'vitest';
import { groupDuplicateCss } from './dedup.js';

const TAGS = (record: Record<string, string[]>): ReadonlyMap<string, ReadonlySet<string>> => {
  const out = new Map<string, Set<string>>();
  for (const [k, v] of Object.entries(record)) out.set(k, new Set(v));
  return out;
};

describe('groupDuplicateCss (§39 dedup v1)', () => {
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
