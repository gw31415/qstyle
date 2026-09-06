import { describe, expect, it } from 'vitest';
import { qstyle as qstyleFactory } from './index.js';
import type { QstyleSourceMap } from './index.js';

/**
 * plan.md B-2 の vite transform level test ギャップ埋め (transform 挙動・security /
 * fallback・determinism/dedup 系。PERF 系は b2-perf.test.ts)。
 * 期待結果は旧 plan.md の定義に基づくが、現行実装と異なるものは「現状固定」
 * (現行挙動を固定する test) にして file header に列挙している:
 * - OBJ-020: `as const` object は untouched (両 scanner の対象外)
 * - OBJ-021: module-scope plain object alias は untouched
 * - DYN-009: object 構文の media 内 dynamic は untouched (template 形は受理)
 * - DYN-018: object spread は untouched
 * - SEL-018: prod の unit 直列化順は unit id sort (source 順は dev のみ)
 * - DED-005: `#ffffff` / `white` は別 identity (色 canonicalize 未実装)
 */

interface Transformable {
  transform: (code: string, id: string) => { code: string; map: QstyleSourceMap } | null;
  load: (id: string) => string | null;
}

interface ResidualPlugin extends Transformable {
  readonly __residuals: readonly { readonly reason: string; readonly cssText: string }[];
}

/** qstyle() の戻り配列から main plugin を取り出す。 */
const qstyle = (options: Parameters<typeof qstyleFactory>[0]): Transformable =>
  qstyleFactory(options)[0] as unknown as Transformable;

const plugin = (): Transformable =>
  qstyle({ diagnostics: 'silent' }) as unknown as Transformable;

const parametricPlugin = (): Transformable =>
  qstyle({
    diagnostics: 'silent',
    runtimeStyles: { promotion: 'always' },
  }) as unknown as Transformable;

const withImport = (body: string): string => `import { css } from '@qstyle/qwik';\n${body}`;

/** 出力 code の pack import から pack css を取る。 */
function packCssOf(p: { load: (id: string) => string | null }, code: string): string {
  const m: RegExpMatchArray | null = /import "virtual:qstyle\/pack\/(q_[0-9a-f]+)\.css"/.exec(code);
  return m === null ? '' : (p.load(`virtual:qstyle/pack/${m[1]}.css`) ?? '');
}

/** 出力 code 内の class 属性から class id 一覧を取る。 */
function classIdsOf(code: string): string[] {
  const m: RegExpMatchArray | null = /class="([^"]*)"/.exec(code);
  return m === null ? [] : (m[1] ?? '').split(/\s+/).filter(Boolean);
}

/** registry の unit 数 (q_ を含む行数)。 */
function unitCount(p: { load: (id: string) => string | null }): number {
  return (p.load('virtual:qstyle/registry') ?? '').split('\n').filter((l) => l.includes('q_'))
    .length;
}

describe('qstyle B-2 transform 挙動系 (OBJ/SEL)', () => {
  it('JSX-001: comments inside handler braces do not break the transform', () => {
    const p = plugin();
    // handler 内の `//` / `/* */` (brace・quote 混じり) があっても css prop は
    // 正常に rewrite される (findMatching の comment bail 実バグの回帰)。
    const out = p.transform(
      `export const A = () => <div css={{ display: 'flex' }} onClick={() => {\n// hello { } "quoted"\n doIt();\n/* multi\nline } brace */\n }} />;`,
      '/src/jsx001.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).toContain('class="q_');
    expect(out?.code).not.toContain('css={{');
    expect(packCssOf(p, out?.code ?? '')).toContain('display:flex');
  });

  it('OBJ-019: css={false}/null/undefined are untouched with no CSS side effects', () => {
    const p = plugin();
    expect(p.transform(`export const A = () => <div css={false} />;`, '/src/obj19-f.tsx')).toBeNull();
    expect(p.transform(`export const A = () => <div css={null} />;`, '/src/obj19-n.tsx')).toBeNull();
    expect(
      p.transform(`export const A = () => <div css={undefined} />;`, '/src/obj19-u.tsx'),
    ).toBeNull();
    // falsy だけでは unit が 1 つも収集されない (DOM/CSS 影響なし)。
    expect(unitCount(p)).toBe(0);
  });

  it('OBJ-020: `as const` object stays untouched (現状固定)', () => {
    const p = plugin();
    // `css={{ ... } as const}` は object scanner (a) の `}}` 隣接判定から外れ、
    // expression scanner (b) も `css={{` を skip するため現行実装では非対象。
    expect(
      p.transform(
        `export const A = () => <div css={{ display: 'flex' } as const} />;`,
        '/src/obj20.tsx',
      ),
    ).toBeNull();
    expect(unitCount(p)).toBe(0);
  });

  it('OBJ-021: module-scope plain object alias stays untouched (現状固定)', () => {
    const p = plugin();
    // css() handle でなければ alias 先の object は解決しない (CMP-017 系の
    // css({...}) handle 経由は既存 test でカバー済み。alias のみここで固定)。
    expect(
      p.transform(
        withImport(
          `const s = { display: 'flex' };\nexport const A = () => <div css={s} />;`,
        ),
        '/src/obj21.tsx',
      ),
    ).toBeNull();
  });

  it('SEL-004: `& > child` combinator selector is untouched with residual reason', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as ResidualPlugin;
    expect(
      p.transform(
        `export const A = () => <div css={{ '& > svg': { width: 16 } }} />;`,
        '/src/sel004.tsx',
      ),
    ).toBeNull();
    expect(p.__residuals.some((r) => r.reason === 'unsupported-selector')).toBe(true);
  });

  it('SEL-005: `& + sibling` / `& ~ sibling` combinator selectors are untouched', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as ResidualPlugin;
    expect(
      p.transform(
        `export const A = () => <div css={{ '& + sibling': { color: 'red' } }} />;`,
        '/src/sel005a.tsx',
      ),
    ).toBeNull();
    expect(
      p.transform(
        `export const A = () => <div css={{ '& ~ sibling': { color: 'red' } }} />;`,
        '/src/sel005b.tsx',
      ),
    ).toBeNull();
    expect(p.__residuals.filter((r) => r.reason === 'unsupported-selector').length).toBe(2);
  });

  it('SEL-006: multi-word descendant selector (`& div span`) is untouched (現状固定)', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as ResidualPlugin;
    // 単語 descendant (`& svg`) は受理済み (SEL-021)。2 語形は residual。
    expect(
      p.transform(
        `export const A = () => <div css={{ '& div span': { display: 'block' } }} />;`,
        '/src/sel006.tsx',
      ),
    ).toBeNull();
    expect(p.__residuals.some((r) => r.reason === 'unsupported-selector')).toBe(true);
  });

  it('SEL-007: attribute selector (`& [data-x]`) is untouched (現状固定)', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as ResidualPlugin;
    expect(
      p.transform(
        `export const A = () => <div css={{ '& [data-x]': { color: 'red' } }} />;`,
        '/src/sel007.tsx',
      ),
    ).toBeNull();
    expect(p.__residuals.some((r) => r.reason === 'unsupported-selector')).toBe(true);
  });

  it('SEL-017: solo class rule is declaration-equivalent to handwritten CSS at (0,1,0)', () => {
    const p = plugin();
    const out = p.transform(
      `export const A = () => <div css={{ color: 'red' }} />;`,
      '/src/sel017.tsx',
    );
    expect(out).not.toBeNull();
    const pack: string = packCssOf(p, out?.code ?? '');
    // plugin OFF 時に手書きする等価 CSS `.manual{color:red}` と宣言を比較する。
    const generated: RegExpMatchArray | null = /(\.q_[0-9a-f]{8})\{([^}]*)\}/.exec(pack);
    const handwritten: RegExpMatchArray | null = /(\.manual)\{([^}]*)\}/.exec('.manual{color:red}');
    expect(generated).not.toBeNull();
    expect(handwritten).not.toBeNull();
    expect(generated?.[2]).toBe(handwritten?.[2]);
    // 構造検証: selector は class 1 つのみ (id 0 / class 1 / type 0 = specificity (0,1,0))。
    const selector: string = generated?.[1] ?? '';
    expect((selector.match(/\./g) ?? []).length).toBe(1);
    expect(/[# ]/.test(selector)).toBe(false);
    expect(/^[a-z]/.test(selector)).toBe(false);
  });

  it('SEL-018: serialization order of equal-specificity units is deterministic (現状固定)', () => {
    const code = `export const A = () => (<><div css={{ color: 'red' }} /><div css={{ color: 'blue' }} /></>);`;
    // prod (qwik-native pack): unit 直列化は unit id の sort 順 (source 順ではない)。
    // 同一入力からは常に同一 css text になる決定性を固定する。
    const runProd = (): string => {
      const p = plugin();
      const out = p.transform(code, '/src/sel018.tsx');
      return packCssOf(p, out?.code ?? '');
    };
    const first: string = runProd();
    const second: string = runProd();
    expect(first).toBe(second);
    expect(first).toContain('color:red');
    expect(first).toContain('color:blue');
    // unit 内の宣言順も決定的 (canonical sort。source 順ではない)。
    const p2 = plugin();
    const out2 = p2.transform(
      `export const A = () => <div css={{ zIndex: 1, color: 'red' }} />;`,
      '/src/sel018b.tsx',
    );
    expect(packCssOf(p2, out2?.code ?? '')).toMatch(/\.q_[0-9a-f]{8}\{color:red;z-index:1\}/);
    // dev は source 順 (既存 test と同じ pipeline で対比を固定)。
    const dev = qstyle({ diagnostics: 'silent' }) as unknown as Transformable & {
      configResolved: (config: { command: string; mode: string }) => void;
    };
    dev.configResolved({ command: 'serve', mode: 'development' });
    const out3 = dev.transform(code, '/src/sel018c.tsx');
    expect(out3).not.toBeNull();
    const key: string = (out3?.code.match(/virtual:qstyle\/dev\/([\w.]+)/) ?? [])[1] ?? '';
    const devCss: string = dev.load(`virtual:qstyle/dev/${key}`) ?? '';
    expect(devCss.indexOf('color:red')).toBeLessThan(devCss.indexOf('color:blue'));
  });
});

describe('qstyle B-2 composition / template / dynamics', () => {
  it('CMP-006: falsy entries in css={[...]} are ignored', () => {
    const p = parametricPlugin();
    const out = p.transform(
      withImport(
        `const base = css({ display: 'flex' });\n` +
          `export const A = () => <div css={[base, false, null, undefined]} />;`,
      ),
      '/src/cmp006.tsx',
    );
    expect(out).not.toBeNull();
    expect(classIdsOf(out?.code ?? '')).toHaveLength(1);
    expect(packCssOf(p, out?.code ?? '')).toContain('display:flex');
    expect(out?.code).not.toContain('css={');
  });

  it('CMP-016: one handle across 1000 elements emits a single unit and class', () => {
    const p = plugin();
    const elements: string = Array.from(
      { length: 1000 },
      (_, i) => `<div class="c" css={base} key={i}>x</div>`,
    ).join('');
    const out = p.transform(
      withImport(
        `const base = css({ display: 'flex', gap: 8 });\n` +
          `export const A = () => (<section>${elements}</section>);`,
      ),
      '/src/cmp016.tsx',
    );
    expect(out).not.toBeNull();
    const classes: string[] = [...(out?.code.matchAll(/class="([^"]*)"/g) ?? [])].map(
      (m) => m[1] ?? '',
    );
    expect(classes).toHaveLength(1000);
    // pack css は 1 unit、class は全要素で同一。
    const unitClasses: string[] = classes.map(
      (c) => (c.match(/q_[0-9a-f]{8}/) ?? [])[0] ?? '',
    );
    expect(new Set(unitClasses)).toHaveLength(1);
    expect(unitCount(p)).toBe(1);
    const pack: string = packCssOf(p, out?.code ?? '');
    expect((pack.match(/display:flex/g) ?? []).length).toBe(1);
  });

  it('CMP-018: circular cross-module handle imports stay untouched in both modules', () => {
    const p = plugin();
    const moduleA = withImport(
      `import { bHandle } from './b';\n` +
        `const aHandle = css({ color: 'red' });\n` +
        `export const A = () => <div css={bHandle} />;`,
    );
    const moduleB = withImport(
      `import { aHandle } from './a';\n` +
        `const bHandle = css({ color: 'blue' });\n` +
        `export const B = () => <span css={aHandle} />;`,
    );
    // transform 単体では 2 module を順に transform し、両方 untouched。
    expect(p.transform(moduleA, '/src/cmp018-a.tsx')).toBeNull();
    expect(p.transform(moduleB, '/src/cmp018-b.tsx')).toBeNull();
    // diagnostic は actionable (error mode で cross-module 理由が出る)。
    const err = qstyle({ diagnostics: 'error' }) as unknown as Transformable;
    expect(() => err.transform(moduleA, '/src/cmp018-c.tsx')).toThrow(/across modules/);
    expect(() => err.transform(moduleB, '/src/cmp018-d.tsx')).toThrow(/across modules/);
  });

  it('TPL-016: tag template transform returns a map with real mappings for interpolations', () => {
    const p = plugin();
    const out = p.transform(
      withImport(
        'const card = css`display: flex; width: ${w}px;`;\n' +
          'export const A = () => <div css={card} />;',
      ),
      '/src/tpl016.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.map).toBeDefined();
    expect(out?.map.sources).toEqual(['/src/tpl016.tsx']);
    // mapping segment が実在する (全行分。interpolation を含む出力も追跡対象)。
    const segments: number = (out?.map.mappings ?? '')
      .split(/[;,]/)
      .filter((s) => s !== '').length;
    expect(segments).toBeGreaterThan(0);
  });

  it('TPL-018: minified single-line source transforms normally', () => {
    const p = plugin();
    const code =
      `import { css } from '@qstyle/qwik'; ` +
      `const card = css\`display:flex;gap:8px;\`; ` +
      `export const A = () => <div css={card} />;`;
    expect(code.includes('\n')).toBe(false);
    const out = p.transform(code, '/src/tpl018.tsx');
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={card}');
    expect(classIdsOf(out?.code ?? '')).toHaveLength(1);
    const pack: string = packCssOf(p, out?.code ?? '');
    expect(pack).toContain('display:flex');
    expect(pack).toContain('gap:8px');
  });

  it('DYN-009: object media-wrapped dynamic is untouched; template form gets media parametric (現状固定)', () => {
    const p = parametricPlugin();
    // object 構文: nested dynamic (propPath に '.' が入る) は untouched。
    expect(
      p.transform(
        `export const A = () => <div css={{ '@media (width >= 768px)': { width: props.w } }} />;`,
        '/src/dyn009a.tsx',
      ),
    ).toBeNull();
    // 同じ意図の template 構文は media context 付き parametric + style var になる。
    const out = p.transform(
      withImport(
        'const dyn = css`@media (width >= 768px) { width: ${w}px; }`;\n' +
          'export const A = () => <div css={dyn} />;',
      ),
      '/src/dyn009b.tsx',
    );
    expect(out).not.toBeNull();
    expect(packCssOf(p, out?.code ?? '')).toMatch(
      /@media \(width >= 768px\)\{\.q_[0-9a-f]{8}\{width:var\(--qstyle-[0-9a-f]{6}-0\)px\}\}/,
    );
    expect(out?.code).toMatch(/'--qstyle-[0-9a-f]{6}-0': w/);
  });

  it('DYN-011: parent and child share one parametric unit with element-local values', () => {
    const p = parametricPlugin();
    const out = p.transform(
      `export const A = () => (<><div css={{ width: props.parentW }} /><span css={{ width: props.childW }} /></>);`,
      '/src/dyn011.tsx',
    );
    expect(out).not.toBeNull();
    const code: string = out?.code ?? '';
    // 同一 unit class が親子で 1 つ。
    const classes: string[] = [...code.matchAll(/class="(q_[0-9a-f]{8})"/g)].map((m) => m[1] ?? '');
    expect(classes).toHaveLength(2);
    expect(new Set(classes)).toHaveLength(1);
    // 同一 slot 名で値だけが要素ごとに異なる (衝突しない)。
    const slots: string[] = [...code.matchAll(/'(--qstyle-[0-9a-f]{6}-0)'/g)].map((m) => m[1] ?? '');
    expect(new Set(slots)).toHaveLength(1);
    expect(code).toMatch(/'--qstyle-[0-9a-f]{6}-0': props\.parentW/);
    expect(code).toMatch(/'--qstyle-[0-9a-f]{6}-0': props\.childW/);
    // serialize される CSS は 1 つのみ。
    const pack: string = packCssOf(p, code);
    expect(pack.match(/width:var\(--qstyle-[0-9a-f]{6}-0\)/g)).toHaveLength(1);
  });

  it('DYN-018: object spread stays untouched (現状固定)', () => {
    const p = plugin();
    expect(
      p.transform(`export const A = () => <div css={{ ...base }} />;`, '/src/dyn018.tsx'),
    ).toBeNull();
  });

  it('DYN-022: identical dynamic structures across modules share unit/parametric ids', () => {
    const p = parametricPlugin();
    const code = `export const M = () => <div css={{ width: props.w }} />;`;
    const a = p.transform(code, '/src/dyn022-a.tsx');
    const b = p.transform(code, '/src/dyn022-b.tsx');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const idA: string = classIdsOf(a?.code ?? '')[0] ?? '';
    const idB: string = classIdsOf(b?.code ?? '')[0] ?? '';
    expect(idA).not.toBe('');
    expect(idA).toBe(idB);
    expect(unitCount(p)).toBe(1);
  });

  it('DYN-023: slot ids stay stable when unrelated declarations are added', () => {
    const p = parametricPlugin();
    const v1 = p.transform(
      `export const A = () => <div css={{ width: props.w }} />;`,
      '/src/dyn023a.tsx',
    );
    const v2 = p.transform(
      `export const B = () => <div css={{ width: props.w, color: 'red' }} />;`,
      '/src/dyn023b.tsx',
    );
    const slot1: string = (v1?.code.match(/'(--qstyle-[0-9a-f]{6}-0)'/) ?? [])[1] ?? '';
    const slot2: string = (v2?.code.match(/'(--qstyle-[0-9a-f]{6}-0)'/) ?? [])[1] ?? '';
    expect(slot1).not.toBe('');
    // 無関係な宣言を足しても style var 名 (slot id) は不変。
    expect(slot2).toBe(slot1);
  });

  it('CSS-014: transition values with var() references serialize verbatim', () => {
    const p = plugin();
    const out = p.transform(
      `export const A = () => <div css={{ transition: 'opacity var(--t)' }} />;`,
      '/src/css014a.tsx',
    );
    expect(out).not.toBeNull();
    // 誤変換なし: var 参照がそのまま保持される (px 付与等がない)。
    expect(packCssOf(p, out?.code ?? '')).toContain('transition:opacity var(--t)');
    const out2 = p.transform(
      `export const B = () => <div css={{ transition: 'opacity 0.2s var(--t, 0.5s)' }} />;`,
      '/src/css014b.tsx',
    );
    expect(packCssOf(p, out2?.code ?? '')).toContain('transition:opacity 0.2s var(--t, 0.5s)');
  });
});

describe('qstyle B-2 security / fallback 系 (SEC/FLB)', () => {
  it('SEC-001: statically hostile declaration values are rejected as residual', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as ResidualPlugin;
    // value 内の declaration/rule 境界を壊す文字列は classify で拒否される。
    expect(
      p.transform(
        `export const A = () => <div css={{ color: 'red; } body { background: teal' }} />;`,
        '/src/sec001a.tsx',
      ),
    ).toBeNull();
    expect(
      p.transform(
        `export const B = () => <div css={{ backgroundImage: 'url("x.png"); } * { color: red' }} />;`,
        '/src/sec001b.tsx',
      ),
    ).toBeNull();
    expect(p.__residuals.some((r) => r.reason === 'unsupported-syntax')).toBe(true);
  });

  it('SEC-002: values containing </style> are rejected', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as ResidualPlugin;
    expect(
      p.transform(
        `export const A = () => <div css={{ content: '</style><script>x</script>' }} />;`,
        '/src/sec002.tsx',
      ),
    ).toBeNull();
    expect(p.__residuals.some((r) => r.reason === 'unsupported-syntax')).toBe(true);
  });

  it('SEC-003: quoted/newline/backslash content values keep rule structure intact (現状固定)', () => {
    const p = plugin();
    // quote を含む値: そのまま serialize され rule は閉じる。
    const out1 = p.transform(
      `export const A = () => <div css={{ content: '"quoted"' }} />;`,
      '/src/sec003a.tsx',
    );
    expect(out1).not.toBeNull();
    expect(packCssOf(p, out1?.code ?? '')).toMatch(/\.q_[0-9a-f]{8}\{content:"quoted"\}/);
    // 改行を含む値: canonical 化 (内部空白の単一化) で空白に置き換わり rule 構造が保たれる。
    const out2 = p.transform(
      `export const B = () => <div css={{ content: 'line1\\nline2' }} />;`,
      '/src/sec003b.tsx',
    );
    expect(out2).not.toBeNull();
    expect(packCssOf(p, out2?.code ?? '')).toContain('content:line1 line2');
    // 値途中の backslash (JS escape `\b` 等) も rule 構造を壊さない。
    const out3 = p.transform(
      `export const C = () => <div css={{ content: 'a\\\\b' }} />;`,
      '/src/sec003c.tsx',
    );
    expect(out3).not.toBeNull();
    expect(packCssOf(p, out3?.code ?? '')).toMatch(/\.q_[0-9a-f]{8}\{content:a\\b\}/);
  });

  it('SEC-004: url(javascript:...) values are rejected', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as ResidualPlugin;
    expect(
      p.transform(
        `export const A = () => <div css={{ backgroundImage: 'url(javascript:alert(1))' }} />;`,
        '/src/sec004a.tsx',
      ),
    ).toBeNull();
    expect(
      p.transform(
        `export const B = () => <div css={{ width: 'expression(alert(1))' }} />;`,
        '/src/sec004b.tsx',
      ),
    ).toBeNull();
    expect(p.__residuals.some((r) => r.reason === 'unsupported-syntax')).toBe(true);
  });

  it('FLB-001: unknown-but-valid properties are accepted and serialized (現状固定)', () => {
    const p = plugin();
    const out = p.transform(
      `export const A = () => <div css={{ 'container-type': 'inline-size' }} />;`,
      '/src/flb001.tsx',
    );
    expect(out).not.toBeNull();
    // property 名検証は緩いため受理され、値はそのまま serialize される。
    expect(packCssOf(p, out?.code ?? '')).toContain('container-type:inline-size');
  });

  it('FLB-002: unparseable template CSS (unclosed block) stays untouched with diagnostic', () => {
    const p = plugin();
    // handle 形: registration が失敗し unresolved のまま。
    expect(
      p.transform(
        withImport(
          'const broken = css`&:hover { color: red;`;\n' +
            'export const A = () => <div css={broken} />;',
        ),
        '/src/flb002a.tsx',
      ),
    ).toBeNull();
    // inline 形も同様。
    expect(
      p.transform(
        withImport('export const A = () => <div css={css`&:hover { color: red;`} />;'),
        '/src/flb002b.tsx',
      ),
    ).toBeNull();
    // diagnostic は出る (error mode で観測)。
    const err = qstyle({ diagnostics: 'error' }) as unknown as Transformable;
    expect(() =>
      err.transform(
        withImport('export const A = () => <div css={css`&:hover { color: red;`} />;'),
        '/src/flb002c.tsx',
      ),
    ).toThrow(/\[qstyle\]/);
  });

  it('FLB-003: runtime-only structures inline into the style attribute under promotion never', () => {
    const p = qstyle({
      diagnostics: 'silent',
      runtimeStyles: { promotion: 'never' },
    }) as unknown as Transformable;
    const out = p.transform(
      `export const A = () => <div css={{ width: props.w, height: props.h }} />;`,
      '/src/flb003.tsx',
    );
    expect(out).not.toBeNull();
    // class も pack import も出さず inline style のみ (promotion never)。
    expect(out?.code).toContain(`style={{ 'width': props.w, 'height': props.h }}`);
    expect(out?.code).not.toContain('class=');
    expect(out?.code).not.toContain('virtual:qstyle');
  });

  it('FLB-004: runtime-composed selectors stay untouched', () => {
    const p = plugin();
    // template の selector interpolation。
    expect(
      p.transform(
        withImport(
          'const dyn = css`&:${mode} { color: red; }`;\n' +
            'export const A = () => <div css={dyn} />;',
        ),
        '/src/flb004a.tsx',
      ),
    ).toBeNull();
    // object の computed (連結) key。
    expect(
      p.transform(
        `export const A = () => <div css={{ ['&:' + dyn]: { color: 'red' } }} />;`,
        '/src/flb004b.tsx',
      ),
    ).toBeNull();
  });

  it('FLB-005: runtime property names stay untouched', () => {
    const p = plugin();
    expect(
      p.transform(
        `export const A = () => <div css={{ [props.p]: 1 }} />;`,
        '/src/flb005.tsx',
      ),
    ).toBeNull();
  });
});

describe('qstyle B-2 determinism / dedup 系 (HASH/DED)', () => {
  interface Emitted {
    readonly fileName: string;
    readonly source: string;
  }

  /** qstyle() 戻り値から名前で plugin を取り出す (closure 状態共有のため同一 instance から)。 */
  const pluginsOf = (
    options: Parameters<typeof qstyleFactory>[0],
    ...names: readonly string[]
  ): Record<string, unknown>[] => {
    const plugins = qstyleFactory(options) as unknown as readonly Record<string, unknown>[];
    const found: Record<string, unknown>[] = [];
    for (const name of names) {
      const p: Record<string, unknown> | undefined = plugins.find((x) => x['name'] === name);
      if (p === undefined) throw new Error(`plugin ${name} not found`);
      found.push(p);
    }
    return found;
  };

  /** build 相当の配線: buildStart -> transforms -> main/cssAsset の generateBundle。 */
  const buildOnce = (
    options: Parameters<typeof qstyleFactory>[0],
    modules: readonly { readonly id: string; readonly code: string }[],
  ): { emitted: Emitted[]; codes: string[] } => {
    const [main, cssAsset] = pluginsOf(options, 'qstyle', 'qstyle:css-asset');
    if (main === undefined || cssAsset === undefined) throw new Error('plugin not found');
    const buildStart = main['buildStart'] as () => void;
    const transform = main['transform'] as (
      code: string,
      id: string,
    ) => { code: string } | null;
    const mainGenerate = main['generateBundle'] as (
      this: { emitFile: (f: Emitted) => void },
    ) => void;
    const cssGenerate = cssAsset['generateBundle'] as (
      this: { emitFile: (f: Emitted) => void },
    ) => void;
    buildStart();
    const emitted: Emitted[] = [];
    const emit = (f: Emitted): void => {
      emitted.push(f);
    };
    const codes: string[] = [];
    for (const mod of modules) {
      const out = transform(mod.code, mod.id);
      codes.push(out?.code ?? '');
    }
    mainGenerate.call({ emitFile: emit });
    cssGenerate.call({ emitFile: emit });
    return { emitted, codes };
  };

  const cssFileNamesOf = (run: { emitted: Emitted[] }): string[] =>
    run.emitted
      .filter((e) => /^assets\/qstyle\.q_[0-9a-f]+\.css$/.test(e.fileName))
      .map((e) => e.fileName)
      .sort();

  it('HASH-007: route A local change keeps route B chunk hash stable', () => {
    // 用法が重ならない 3 unit (home-local / about-local / shared) は merge されず
    // 3 chunk になる (similarity 0)。A の宣言変更は A の chunk のみ変える。
    const options = {
      backend: 'css-asset',
      routes: {
        '/': ['/src/home-a.tsx', '/src/home-b.tsx', '/src/home-c.tsx'],
        '/about': ['/src/about-a.tsx', '/src/about-b.tsx', '/src/about-c.tsx'],
      },
    } as const;
    const shared = `<div css={{ outline: '2px solid black' }} />;`;
    const modulesV1 = [
      { id: '/src/home-a.tsx', code: `export const A = () => <div css={{ color: 'red' }} />;` },
      { id: '/src/home-b.tsx', code: `export const B = () => ${shared}` },
      { id: '/src/home-c.tsx', code: `export const C = () => ${shared}` },
      { id: '/src/about-a.tsx', code: `export const D = () => <div css={{ color: 'green' }} />;` },
      { id: '/src/about-b.tsx', code: `export const E = () => ${shared}` },
      { id: '/src/about-c.tsx', code: `export const F = () => ${shared}` },
    ];
    const modulesV2 = modulesV1.map((mod) =>
      mod.id === '/src/home-a.tsx'
        ? { ...mod, code: `export const A = () => <div css={{ color: 'blue' }} />;` }
        : mod,
    );
    const first = buildOnce({ ...options }, modulesV1);
    const second = buildOnce({ ...options }, modulesV2);
    const namesOf = (run: { emitted: Emitted[] }): string[] => cssFileNamesOf(run);
    expect(namesOf(first)).toHaveLength(3);
    expect(namesOf(second)).toHaveLength(3);
    // 共有・about の chunk は不変、home-local のみ変わる。
    const same = (file: string): boolean => namesOf(second).includes(file);
    const homeV1: string[] = namesOf(first).filter((file) => !same(file));
    expect(homeV1).toHaveLength(1);
    for (const file of namesOf(first)) {
      if (file !== homeV1[0]) expect(namesOf(second)).toContain(file);
    }
    // 変わった chunk の中身は blue。
    const changed: Emitted | undefined = second.emitted.find(
      (e) => e.fileName === namesOf(second).find((f) => f !== homeV1[0] && !namesOf(first).includes(f)),
    );
    expect(changed?.source).toContain('color:blue');
  });

  it('HASH-008: shared atom change invalidates only the shared chunk', () => {
    const options = {
      backend: 'css-asset',
      routes: {
        '/': ['/src/home-a.tsx', '/src/home-b.tsx'],
        '/about': ['/src/about-a.tsx', '/src/about-b.tsx'],
      },
    } as const;
    const modulesV1 = [
      { id: '/src/home-a.tsx', code: `export const A = () => <div css={{ color: 'red' }} />;` },
      {
        id: '/src/home-b.tsx',
        code: `export const B = () => <div css={{ outline: '2px solid black' }} />;`,
      },
      { id: '/src/about-a.tsx', code: `export const D = () => <div css={{ color: 'green' }} />;` },
      {
        id: '/src/about-b.tsx',
        code: `export const E = () => <div css={{ outline: '2px solid black' }} />;`,
      },
    ];
    const modulesV2 = modulesV1.map((mod) =>
      mod.id.endsWith('-b.tsx')
        ? {
            ...mod,
            code: mod.code.replace('2px solid black', '3px dotted gray'),
          }
        : mod,
    );
    const first = buildOnce({ ...options }, modulesV1);
    const second = buildOnce({ ...options }, modulesV2);
    expect(cssFileNamesOf(first)).toHaveLength(3);
    expect(cssFileNamesOf(second)).toHaveLength(3);
    // route-local (red/green) の chunk は不変、shared のみ変わる。
    const kept: string[] = cssFileNamesOf(first).filter((file) =>
      cssFileNamesOf(second).includes(file),
    );
    expect(kept).toHaveLength(2);
    const changedFile: string | undefined = cssFileNamesOf(second).find(
      (file) => !cssFileNamesOf(first).includes(file),
    );
    const changed: Emitted | undefined = second.emitted.find(
      (e) => e.fileName === changedFile,
    );
    expect(changed?.source).toContain('dotted');
  });

  it('HASH-009: identical module content at different paths yields identical css asset names', () => {
    const code = `export const A = () => <div css={{ display: 'flex', gap: 8 }} />;`;
    // 同一内容を別 directory に置いた build どうしで css asset hash は同一。
    const first = buildOnce(
      { backend: 'css-asset', routes: { '/': ['/src/feature-a/card.tsx'] } },
      [{ id: '/src/feature-a/card.tsx', code }],
    );
    const second = buildOnce(
      { backend: 'css-asset', routes: { '/': ['/src/nested/deep/card.tsx'] } },
      [{ id: '/src/nested/deep/card.tsx', code }],
    );
    expect(cssFileNamesOf(second)).toEqual(cssFileNamesOf(first));
    expect(cssFileNamesOf(first)).toHaveLength(1);
    // moduleKey は basename 正規化: route path を basename 指定しても解決する。
    const third = buildOnce(
      { backend: 'css-asset', routes: { '/': ['card.tsx'] } },
      [{ id: '/src/ui/card.tsx', code }],
    );
    const routesAsset: Emitted | undefined = third.emitted.find(
      (e) => e.fileName === 'qstyle.routes.json',
    );
    const manifest = JSON.parse(routesAsset?.source ?? '{}') as {
      entries: { route: string; assets: string[] }[];
    };
    expect(manifest.entries[0]?.assets.length).toBeGreaterThan(0);
    for (const asset of manifest.entries[0]?.assets ?? []) {
      expect(cssFileNamesOf(third)).toContain(asset);
    }
  });

  it('R2: same-basename modules in different dirs resolve to distinct routes', () => {
    // Qwik City 規約 (`about/index.tsx`) では basename が衝突するため、route option
    // は root 相対 path で区別する (configResolved で root を渡すと moduleKey が
    // root 相対化される)。
    const [main, cssAsset] = pluginsOf(
      {
        backend: 'css-asset',
        routes: {
          '/': ['src/routes/index.tsx'],
          '/about': ['src/routes/about/index.tsx'],
        },
      },
      'qstyle',
      'qstyle:css-asset',
    );
    if (main === undefined || cssAsset === undefined) throw new Error('plugin not found');
    (
      main['configResolved'] as (config: { command: string; mode: string; root: string }) => void
    )({ command: 'build', mode: 'production', root: '/app' });
    (main['buildStart'] as () => void)();
    const transform = main['transform'] as (
      code: string,
      id: string,
    ) => { code: string } | null;
    transform(
      `export const A = () => <div css={{ color: 'red' }} />;`,
      '/app/src/routes/index.tsx',
    );
    transform(
      `export const A = () => <div css={{ color: 'blue' }} />;`,
      '/app/src/routes/about/index.tsx',
    );
    const emitted: Emitted[] = [];
    const emit = (f: Emitted): void => {
      emitted.push(f);
    };
    (main['generateBundle'] as (this: { emitFile: (f: Emitted) => void }) => void).call({
      emitFile: emit,
    });
    (cssAsset['generateBundle'] as (this: { emitFile: (f: Emitted) => void }) => void).call({
      emitFile: emit,
    });
    const routesAsset: Emitted | undefined = emitted.find(
      (e) => e.fileName === 'qstyle.routes.json',
    );
    const manifest = JSON.parse(routesAsset?.source ?? '{}') as {
      entries: { route: string; assets: string[] }[];
    };
    const byRoute = new Map<string, string[]>(
      manifest.entries.map((e) => [e.route, e.assets] as [string, string[]]),
    );
    // 混線なし: 各 route 1 asset、別 file、内容も対応する。
    expect(byRoute.get('/')?.length).toBe(1);
    expect(byRoute.get('/about')?.length).toBe(1);
    const homeAsset: string = byRoute.get('/')?.[0] ?? '';
    const aboutAsset: string = byRoute.get('/about')?.[0] ?? '';
    expect(homeAsset).not.toBe(aboutAsset);
    const cssOf = (fileName: string): string =>
      emitted.find((e) => e.fileName === fileName)?.source ?? '';
    expect(cssOf(homeAsset)).toContain('color:red');
    expect(cssOf(aboutAsset)).toContain('color:blue');
  });

  it('HASH-010: object literal formatting differences do not change unit identity', () => {
    const p = plugin();
    const a = p.transform(
      `export const A = () => <div css={{ display: 'flex', gap: 8 }} />;`,
      '/src/hash010a.tsx',
    );
    const b = p.transform(
      `export const B = () => (<div\n  css={{\n    display: 'flex',\n    gap: 8,\n  }}\n/>);`,
      '/src/hash010b.tsx',
    );
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(classIdsOf(a?.code ?? '')[0]).toBe(classIdsOf(b?.code ?? '')[0]);
    expect(unitCount(p)).toBe(1);
  });

  it('DED-005: #ffffff and white keep separate identities (現状固定)', () => {
    const p = plugin();
    const a = p.transform(
      `export const A = () => <div css={{ color: '#ffffff' }} />;`,
      '/src/ded005a.tsx',
    );
    const b = p.transform(
      `export const B = () => <div css={{ color: 'white' }} />;`,
      '/src/ded005b.tsx',
    );
    // 色の意味的 canonicalize は未実装のため別 identity のまま。
    expect(classIdsOf(a?.code ?? '')[0]).not.toBe(classIdsOf(b?.code ?? '')[0]);
    expect(unitCount(p)).toBe(2);
  });

  it('DED-009: @layer nest is residual/untouched', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as ResidualPlugin;
    expect(
      p.transform(
        `export const A = () => <div css={{ '@layer base': { color: 'red' } }} />;`,
        '/src/ded009.tsx',
      ),
    ).toBeNull();
    expect(p.__residuals.some((r) => r.reason === 'unsupported-at-rule')).toBe(true);
  });

  it('CSS-012: @layer order is residual, not miscompiled', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as ResidualPlugin;
    // layer 順序は transform が解釈せず untouched (+理由記録)。黙って書き換えない。
    expect(
      p.transform(
        `export const A = () => <div css={{ '@layer base': { color: 'red' } }} />;`,
        '/src/css012.tsx',
      ),
    ).toBeNull();
    expect(p.__residuals.some((r) => r.reason === 'unsupported-at-rule')).toBe(true);
    expect(unitCount(p)).toBe(0);
  });

describe('qstyle B-2 CSS semantics preservation (CSS-004/005/011/015/016/017/018)', () => {
  const check = (
    label: string,
    code: string,
    expectedInCss: readonly string[],
  ): void => {
    const p = plugin();
    const out = p.transform(code, `/src/${label}.tsx`);
    expect(out, label).not.toBeNull();
    const pack: string = packCssOf(p, out?.code ?? '');
    for (const snippet of expectedInCss) {
      expect(pack, `${label}: ${snippet}`).toContain(snippet);
    }
  };

  it('CSS-004/005: inherited and non-inherited values pass through', () => {
    check('css004', `export const A = () => <div css={{ color: 'olive' }} />;`, [
      'color:olive',
    ]);
    check('css005', `export const A = () => <div css={{ marginTop: '21px' }} />;`, [
      'margin-top:21px',
    ]);
  });

  it('CSS-011: :where() kept verbatim (zero-specificity semantics)', () => {
    check(
      'css011',
      `export const A = () => <div css={{ '&:where(.g-on)': { color: 'teal' } }} />;`,
      [':where(.g-on)', 'color:teal'],
    );
  });

  it('CSS-015: currentColor kept verbatim', () => {
    check('css015', `export const A = () => <div css={{ color: 'currentColor' }} />;`, [
      'color:currentColor',
    ]);
  });

  it('CSS-016: invalid-at-computed custom property kept verbatim', () => {
    check(
      'css016',
      `export const A = () => <div css={{ '--gsec': 'red', padding: 'var(--gsec, 9px)' }} />;`,
      ['--gsec:red', 'padding:var(--gsec, 9px)'],
    );
  });

  it('CSS-017/018: logical properties and direction kept', () => {
    check(
      'css017',
      `export const A = () => <div css={{ marginInlineStart: '13px', paddingBlockEnd: '7px' }} />;`,
      ['margin-inline-start:13px', 'padding-block-end:7px'],
    );
    check('css018', `export const A = () => <div css={{ direction: 'rtl' }} />;`, [
      'direction:rtl',
    ]);
  });
});

  it('DED-012: declaration order of independent properties does not change unit id', () => {
    const p = plugin();
    const a = p.transform(
      `export const A = () => <div css={{ display: 'flex', color: 'red' }} />;`,
      '/src/ded012a.tsx',
    );
    const b = p.transform(
      `export const B = () => <div css={{ color: 'red', display: 'flex' }} />;`,
      '/src/ded012b.tsx',
    );
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(classIdsOf(a?.code ?? '')[0]).toBe(classIdsOf(b?.code ?? '')[0]);
    // serialize 結果も同一 (canonical order)。
    expect(packCssOf(p, a?.code ?? '')).toBe(packCssOf(p, b?.code ?? ''));
    expect(unitCount(p)).toBe(1);
  });

  it('FLB-008/009: peer version guard (pure checker matrix)', async (): Promise<void> => {
    const { checkPeerVersions, peerMajor } = await import('./index.js');
    // 対応 version は問題なし。
    expect(checkPeerVersions({ qwik: '2.0.0-beta.43', vite: '8.2.2' })).toEqual([]);
    expect(checkPeerVersions({ qwik: 'v2.1.0', vite: 'v8.0.0' })).toEqual([]);
    // major 不一致は明示問題になる (silent miscompile にしない)。
    expect(checkPeerVersions({ qwik: '1.0.0', vite: '8.2.2' })).toHaveLength(1);
    expect(checkPeerVersions({ qwik: '2.0.0-beta.43', vite: '7.0.0' })).toHaveLength(1);
    expect(checkPeerVersions({ qwik: '3.0.0', vite: '9.0.0' })).toHaveLength(2);
    // 不正・欠落も問題になる。
    expect(checkPeerVersions({ qwik: 'bogus', vite: '8.2.2' })).toHaveLength(1);
    expect(checkPeerVersions({})).toHaveLength(2);
    expect(peerMajor('2.0.0-beta.43')).toBe(2);
    expect(peerMajor('v8.2.2')).toBe(8);
    expect(peerMajor('bogus')).toBeNull();
  });

  it('FLB-008/009: plugin constructs cleanly on supported peers', () => {
    // 実環境の version で問題がなければ何も起きない (warning も throw もなし)。
    expect(() => qstyleFactory({ diagnostics: 'error' })).not.toThrow();
  });
});
