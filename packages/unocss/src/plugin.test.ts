import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import presetWind4 from '@unocss/preset-wind4';
import defaultExport, { aliasForUtilityToken, defineConfig, UnoCSS } from './index.js';
import type { QstyleUnoOptions } from './index.js';

const FIXTURE_DIR = fileURLToPath(new URL('./uno-fixture/', import.meta.url));

type TestPlugin = {
  configResolved: (config: unknown) => void;
  configureServer: (server: {
    middlewares: { use(handler: (req: unknown, res: unknown, next: () => void) => void): void };
  }) => void;
  transform: (code: string, id: string) => Promise<{ code: string; map: null } | null>;
  resolveId: (id: string) => string | null;
  load: (id: string) => string | null;
};

function setup(): TestPlugin {
  return setupWith(undefined);
}

function setupWith(options: QstyleUnoOptions | undefined): TestPlugin {
  const plugin = UnoCSS(options) as unknown as TestPlugin;
  plugin.configResolved({ root: FIXTURE_DIR });
  return plugin;
}

/** transform 出力中の virtual CSS import の本文を集める。 */
function cssBodies(p: TestPlugin, out: { code: string } | null): (string | null)[] {
  const specs: string[] = [
    ...((out?.code ?? '').matchAll(/import "(virtual:qstyle-uno\/c\/[0-9a-f]+\.css)";/g) ?? []),
  ].map((m) => m[1] as string);
  return specs.map((spec) => {
    const id: string | null = p.resolveId(spec);
    return id === null ? null : p.load(id);
  });
}

describe('UnoCSS plugin', () => {
  it('exports the plugin as default (drop-in for @unocss/vite)', () => {
    expect(defaultExport).toBe(UnoCSS);
    expect(typeof UnoCSS({ presets: [presetWind4()] }).transform).toBe('function');
  });

  it('re-exports @unocss/vite values transparently', async () => {
    expect(typeof defineConfig).toBe('function');
    const vite = await import('@unocss/vite');
    expect(defineConfig).toBe(vite.defineConfig);
  });
  it('translates utilities to a css prop and removes the class', async () => {
    const p = setup();
    const out = await p.transform(
      `export const A = () => <div class="flex gap-4">x</div>;`,
      `${FIXTURE_DIR}a.tsx`,
    );
    expect(out).not.toBeNull();
    expect(out?.code).toContain('css={{');
    expect(out?.code).toContain('display: "flex"');
    expect(out?.code).not.toContain('class=');
    expect(out?.code).not.toContain('class="flex');
  });

  it('nests pseudo and media contexts', async () => {
    const p = setup();
    const out = await p.transform(
      `export const A = () => <div class="hover:bg-red-500 md:grid">x</div>;`,
      `${FIXTURE_DIR}b.tsx`,
    );
    expect(out?.code).toContain('"&:hover"');
    expect(out?.code).toContain('@media');
  });

  it('resolves conflicts by engine order', async () => {
    const p = setup();
    const out = await p.transform(
      `export const A = () => <div class="p-2 p-4">x</div>;`,
      `${FIXTURE_DIR}c.tsx`,
    );
    expect(out?.code).toContain('* 4');
    expect(out?.code).not.toContain('* 2');
  });

  it('keeps unmatched tokens in class', async () => {
    const p = setup();
    const out = await p.transform(
      `export const A = () => <div class="flex no-such-class">x</div>;`,
      `${FIXTURE_DIR}d.tsx`,
    );
    expect(out).not.toBeNull();
    expect(out?.code).toContain('display: "flex"');
    expect(out?.code).toContain('class="no-such-class"');
  });

  it('hoists static array elements to a css prop (strip by default)', async () => {
    const p = setup();
    const code = `export const A = (props: { c?: string }) => <div class={["flex w-full", props.c]}>x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}arr.tsx`);
    expect(out).not.toBeNull();
    // 静的要素は css へ hoist され、動的要素だけ class に残る。原文名は消える。
    expect(out?.code).toContain('css={{');
    expect(out?.code).toContain('display: "flex"');
    expect(out?.code).toContain('class={[props.c]}');
    expect(out?.code).not.toContain('"flex w-full"');
    const bodies = cssBodies(p, out);
    expect(bodies.some((css) => css !== null && css.includes('.flex'))).toBe(false);
  });

  it('aliases dynamic array elements that cannot hoist', async () => {
    const p = setup();
    // divide-y 混じりの union は verbatim のため alias に落ちる。
    const code = `export const A = (props: { c?: string }) => <div class={["flex divide-y", props.c]}>x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}arr-alias.tsx`);
    expect(out).not.toBeNull();
    const flexAlias: string = aliasForUtilityToken('flex');
    expect(out?.code).not.toContain('css={{');
    expect(out?.code).toContain(`"${flexAlias} ${aliasForUtilityToken('divide-y')}"`);
    expect(out?.code).not.toContain('"flex divide-y"');
    const bodies = cssBodies(p, out);
    expect(bodies.some((css) => css !== null && css.includes(`.${flexAlias}`))).toBe(true);
    expect(bodies.some((css) => css !== null && css.includes('.flex'))).toBe(false);
  });

  it('keeps dynamic class literals in compat mode (preserveClass)', async () => {
    const p = setupWith({ preserveClass: true });
    const code = `export const A = (props: { c?: string }) => <div class={["flex w-full", props.c]}>x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}arr-compat.tsx`);
    expect(out).not.toBeNull();
    // class 配列は触らない。rules は virtual CSS に出る。
    expect(out?.code).toContain('class={["flex w-full", props.c]}');
    const bodies = cssBodies(p, out);
    expect(bodies.some((css) => css !== null && css.includes('.flex'))).toBe(true);
  });

  it('rewrites class-fed Record values to aliases', async () => {
    const p = setup();
    const code = `const m: Record<string, string> = { a: "font-sans flex" };\nexport const A = () => <div class={m.a}>x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}rec.tsx`);
    expect(out).not.toBeNull();
    // 参照 (`m.a`) は残し、定義側の文字列だけ alias 化する。型は string のまま。
    expect(out?.code).toContain('class={m.a}');
    const sans: string = aliasForUtilityToken('font-sans');
    const flex: string = aliasForUtilityToken('flex');
    expect(out?.code).toContain(`"${sans} ${flex}"`);
    expect(out?.code).not.toContain('"font-sans flex"');
    const bodies = cssBodies(p, out);
    expect(
      bodies.some((css) => css !== null && css.includes('font-family')),
    ).toBe(true);
    expect(bodies.some((css) => css !== null && css.includes('.font-sans'))).toBe(false);
  });

  it('restricts Record rewriting to referenced props', async () => {
    const p = setup();
    // `label` は class 参照されないため原文のまま (aria 等の紛れ込み防止)。
    // 未書換の matched (`block`) には原文 selector の CSS が出る (黙って壊さない)。
    const code = [
      'const m = { a: "flex", label: "block" };',
      'export const A = () => (<>',
      '  <div class={m.a}>x</div>',
      '  <span>{m.label}</span>',
      '</>);',
    ].join('\n');
    const out = await p.transform(code, `${FIXTURE_DIR}rec-prop.tsx`);
    expect(out).not.toBeNull();
    const flex: string = aliasForUtilityToken('flex');
    expect(out?.code).toContain(`a: "${flex}"`);
    expect(out?.code).toContain('label: "block"');
    const bodies = cssBodies(p, out);
    expect(bodies.some((css) => css !== null && css.includes(`.${flex}`))).toBe(true);
    expect(bodies.some((css) => css !== null && css.includes('.block'))).toBe(true);
  });

  it('leaves non-class literals alone (aria-label)', async () => {
    const p = setup();
    const code = `export const A = () => <div aria-label="block user" class={["flex"]}>x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}aria.tsx`);
    expect(out).not.toBeNull();
    expect(out?.code).toContain('aria-label="block user"');
    // class 要素は css へ hoist される (値は css 宣言として残る。class 名ではない)。
    expect(out?.code).toContain('css={{ display: "flex" }}');
    expect(out?.code).not.toContain('class=');
  });

  it('falls back to aliases on static/dynamic property conflicts', async () => {
    const p = setup();
    // 静的 m-4 と動的 mt-2 は shorthand/longhand で競合するため hoist せず alias。
    const code = `export const A = (props: { t: boolean }) => <div class={["m-4", props.t ? "mt-2" : "mb-2"]}>x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}conflict.tsx`);
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={{');
    const m4: string = aliasForUtilityToken('m-4');
    expect(out?.code).toContain(`"${m4}"`);
    expect(out?.code).not.toContain('"m-4"');
    const bodies = cssBodies(p, out);
    expect(bodies.some((css) => css !== null && css.includes(`.${m4}`))).toBe(true);
  });

  it('hoists className arrays like class arrays', async () => {
    const p = setup();
    const code = `export const A = (props: { c?: string }) => <div className={["flex", props.c]}>x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}classname.tsx`);
    expect(out).not.toBeNull();
    expect(out?.code).toContain('css={{');
    expect(out?.code).toContain('className={[props.c]}');
    expect(out?.code).not.toContain('["flex"');
  });

  it('aliases template static chunks in dynamic class', async () => {
    const p = setup();
    // divide-y は verbatim 級のため template ごと alias に落ちる。
    const code = 'export const A = (props: { x: string }) => <div class={`divide-y ${props.x}`}>i</div>;';
    const out = await p.transform(code, `${FIXTURE_DIR}tpl-class.tsx`);
    expect(out).not.toBeNull();
    const alias: string = aliasForUtilityToken('divide-y');
    expect(out?.code).toContain(`\`${alias} \${props.x}\``);
    expect(out?.code).not.toContain('divide-y ');
    const bodies = cssBodies(p, out);
    expect(bodies.some((css) => css !== null && css.includes(`.${alias}`))).toBe(true);
  });

  it('is idempotent with aliases', async () => {
    const p = setup();
    const code = `export const A = (props: { on: boolean }) => <div class={["flex", props.on ? "grid" : "block"]}>x</div>;`;
    const once = await p.transform(code, `${FIXTURE_DIR}idem-alias.tsx`);
    expect(once).not.toBeNull();
    const twice = await p.transform(once?.code ?? '', `${FIXTURE_DIR}idem-alias.tsx`);
    // 2 回目は alias 済みのため何もしない。
    expect(twice).toBeNull();
  });

  it('derives stable distinct aliases per token', async () => {
    expect(aliasForUtilityToken('flex')).toBe(aliasForUtilityToken('flex'));
    expect(aliasForUtilityToken('flex')).not.toBe(aliasForUtilityToken('grid'));
    expect(aliasForUtilityToken('flex')).toMatch(/^qu_[0-9a-f]{8}$/);
  });

  it('never rewrites predicates (strict equality target)', async () => {
    const p = setup();
    // `=== "flex"` の比較対象は class 値ではないため原文維持。
    // 三項の枝 (grid/block) は値位置のため alias 化する。
    const code = `export const A = (props: { mode: string }) => <div class={[props.mode === "flex" ? "grid" : "block"]}>x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}pred.tsx`);
    expect(out).not.toBeNull();
    expect(out?.code).toContain('props.mode === "flex"');
    expect(out?.code).not.toContain('"grid"');
    expect(out?.code).not.toContain('"block"');
    const bodies = cssBodies(p, out);
    // predicate の flex には原文 selector の CSS が出る。
    expect(bodies.some((css) => css !== null && css.includes('.flex{'))).toBe(true);
    expect(bodies.some((css) => css !== null && css.includes(`.${aliasForUtilityToken('grid')}`))).toBe(true);
  });

  it('keeps commas when removing middle array elements', async () => {
    const p = setup();
    const code = `export const A = (props: { a: string; b: string }) => <div class={[props.a, "flex", props.b]}>x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}mid.tsx`);
    expect(out).not.toBeNull();
    // 静的 flex は hoist され、残りは `,` で区切られる。
    expect(out?.code).toContain('class={[props.a,props.b]}');
    expect(out?.code).toContain('css={{');
  });

  it('keeps ancestor markers original while aliasing the utility', async () => {
    const p = setup();
    const code = [
      'export const A = () => (<>',
      '  <div class="group">',
      '    <span class="group-hover:flex">x</span>',
      '  </div>',
      '</>);',
    ].join('\n');
    const out = await p.transform(code, `${FIXTURE_DIR}group.tsx`);
    expect(out).not.toBeNull();
    // marker の group は unmatched のため原文維持。対象 token のみ alias。
    expect(out?.code).toContain('class="group"');
    const child: string = aliasForUtilityToken('group-hover:flex');
    expect(out?.code).toContain(`class="${child}"`);
    const bodies = cssBodies(p, out);
    expect(bodies.some((css) => css !== null && css.includes('.group'))).toBe(true);
    expect(bodies.some((css) => css !== null && css.includes(`.${child}`))).toBe(true);
  });

  it('ignores shadowed locals when finding class-fed consts', async () => {
    const p = setup();
    const code = [
      'const m = { a: "flex" };',
      'export const A = () => <div class={m.a}>x</div>;',
      'export function B() {',
      '  const m = { label: "block" };',
      '  return m.label;',
      '}',
    ].join('\n');
    const out = await p.transform(code, `${FIXTURE_DIR}shadow.tsx`);
    expect(out).not.toBeNull();
    // top-level の class 供給 const のみ書換。shadow された local は不変。
    expect(out?.code).toContain(`"${aliasForUtilityToken('flex')}"`);
    expect(out?.code).toContain('label: "block"');
  });

  it('bails hoisting when a static element mixes matched and custom tokens', async () => {
    const p = setup();
    // "flex my-card" 要素が残るため union winner の hoist は危険。alias に落とす。
    const code = `export const A = (props: { c?: string }) => <div class={["grid", "flex my-card", props.c]}>x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}partial.tsx`);
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('css={{');
    const grid: string = aliasForUtilityToken('grid');
    const flex: string = aliasForUtilityToken('flex');
    expect(out?.code).toContain(`"${grid}"`);
    expect(out?.code).toContain(`"${flex} my-card"`);
  });

  it('keeps mixed tokens original when also used outside class', async () => {
    const p = setup();
    // aria 内の同名 token があるため divide-y は原文のまま + 原文 CSS。
    const code = `export const A = (props: { c?: string }) => <div aria-label="divide-y sections" class={["divide-y", props.c]}>x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}mixed.tsx`);
    expect(out).not.toBeNull();
    expect(out?.code).toContain('"divide-y"');
    const bodies = cssBodies(p, out);
    expect(bodies.some((css) => css !== null && css.includes('.divide-y'))).toBe(true);
  });

  it('supplies original CSS for object identifier keys without rewriting', async () => {
    const p = setup();
    // `{flex: cond}` の ident key は binding のため書換えない。原文 CSS を出す。
    const code = `export const A = (props: { on: boolean }) => <div class={[{ flex: props.on }]}>x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}objkey.tsx`);
    expect(out).not.toBeNull();
    expect(out?.code).toContain('{ flex: props.on }');
    const bodies = cssBodies(p, out);
    expect(bodies.some((css) => css !== null && css.includes('.flex{'))).toBe(true);
  });
  it('ignores declarations inside css templates', async () => {
    const p = setup();
    // css template 内の `display: block` が候補化されると dead な `.block` が出る。
    const code = [
      'import { css } from "@qstyle/qwik";',
      'const a = css`display: block;`;',
      'export const A = () => <div class="flex">x</div>;',
    ].join('\n');
    const out = await p.transform(code, `${FIXTURE_DIR}tpl.tsx`);
    expect(out).not.toBeNull();
    expect(out?.code).not.toContain('.block');
  });

  it('serves virtual CSS as text/css via middleware', async () => {
    // 互換モードで原文 selector のまま配信されることを固定する。
    const p = setupWith({ preserveClass: true });
    const code = `export const A = () => <div class="m-4 mt-2">x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}e.tsx`);
    expect(out).not.toBeNull();
    const specs: string[] = [
      ...((out?.code ?? '').matchAll(/import "(virtual:qstyle-uno\/c\/[0-9a-f]+\.css)";/g) ?? []),
    ].map((m) => m[1] as string);
    expect(specs.length).toBeGreaterThan(0);
    const handlers: ((req: unknown, res: unknown, next: () => void) => void)[] = [];
    p.configureServer({ middlewares: { use: (h) => handlers.push(h) } });
    expect(handlers).toHaveLength(1);
    const handler = handlers[0] as (req: unknown, res: unknown, next: () => void) => void;
    const bodies: string[] = [];
    for (const spec of specs) {
      let body = '';
      const headers: Record<string, string> = {};
      handler(
        { url: `/${spec}` },
        {
          statusCode: 200,
          setHeader: (name: string, value: string) => {
            headers[name] = value;
          },
          end: (chunk: string) => {
            body = chunk;
          },
        },
        () => {},
      );
      expect(headers['Content-Type']).toContain('text/css');
      bodies.push(body);
    }
    expect(bodies.some((body) => body.includes('.m-4'))).toBe(true);
    // 未知 path は next() に譲る
    let nextCalled = false;
    handler({ url: '/other.css' }, {}, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it('keeps verbatim classes in compat mode (preserveClass)', async () => {
    const p = setupWith({ preserveClass: true });
    const code = `export const A = () => <div class="m-4 mt-2">x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}e.tsx`);
    expect(out).not.toBeNull();
    expect(out?.code).toContain('class="m-4 mt-2"');
    const bodies = cssBodies(p, out);
    expect(bodies.some((css) => css !== null && css.includes('.m-4'))).toBe(true);
  });

  it('strips matched static tokens to aliases by default', async () => {
    const p = setup();
    const code = `export const A = () => <div class="m-4 mt-2">x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}e-strip.tsx`);
    expect(out).not.toBeNull();
    const m4: string = aliasForUtilityToken('m-4');
    const mt2: string = aliasForUtilityToken('mt-2');
    // 原文名は転送物 (JS) から消え、alias のみ残る。cascade は維持される。
    expect(out?.code).not.toContain('m-4');
    expect(out?.code).not.toContain('mt-2');
    expect(out?.code).toContain(`class="${m4} ${mt2}"`);
    const bodies = cssBodies(p, out);
    expect(bodies.some((css) => css !== null && css.includes(`.${m4}`))).toBe(true);
    expect(bodies.some((css) => css !== null && css.includes('.m-4'))).toBe(false);
  });

  it('emits :is() instead of :where() for selector utilities', async () => {
    // ponytail: `:where()` (specificity 0) は preflight の `*` と同点になり、
    // dev の遅延注入順で勝敗が変わってちらつく。`:is()` は matching が同一で
    // 順序に依らず utility が勝つ。
    const p = setup();
    const code = `export const A = () => <div class="flex divide-y divide-border">x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}div.tsx`);
    expect(out).not.toBeNull();
    const css: string = cssBodies(p, out).filter((b) => b !== null).join('\n');
    // 削減モードでは原文名が消え、alias + :is() になる。
    expect(css).not.toContain('.divide-y');
    expect(css).toContain(`.${aliasForUtilityToken('divide-y')}`);
    expect(css).toContain(':is(');
    expect(css).not.toContain(':where(');
  });

  it('keeps original selectors in compat mode (preserveClass)', async () => {
    const p = setupWith({ preserveClass: true });
    const code = `export const A = () => <div class="flex divide-y divide-border">x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}div-compat.tsx`);
    expect(out).not.toBeNull();
    expect(out?.code).toContain('class="flex divide-y divide-border"');
    const css: string = cssBodies(p, out).filter((b) => b !== null).join('\n');
    expect(css).toContain('.divide-y');
    expect(css).toContain(':is(');
    expect(css).not.toContain(':where(');
  });

  it('emits aliases for dynamic uses even when statically converted elsewhere', async () => {
    const p = setup();
    // bg-red-500 は静的 class では翻訳されるが、三項内の同名も
    // alias CSS で出す (条件付き要素との両立。重複分は同一宣言で無害)。
    // 原文名は転送物から消える。
    const code = [
      'export const A = (props: { on: boolean }) => (<>',
      '  <div class="absolute inset-0 rounded-full bg-red-500" />',
      '  <div class={[props.on ? "bg-red-500" : "bg-blue-500"]} />',
      '</>);',
    ].join('\n');
    const out = await p.transform(code, `${FIXTURE_DIR}both.tsx`);
    expect(out).not.toBeNull();
    expect(out?.code).toContain('css={{');
    const red: string = aliasForUtilityToken('bg-red-500');
    const blue: string = aliasForUtilityToken('bg-blue-500');
    expect(out?.code).toContain(`"${red}"`);
    expect(out?.code).toContain(`"${blue}"`);
    expect(out?.code).not.toContain('"bg-red-500"');
    expect(out?.code).not.toContain('"bg-blue-500"');
    const bodies = cssBodies(p, out);
    expect(bodies.some((css) => css !== null && css.includes(`.${red}`))).toBe(true);
    expect(bodies.some((css) => css !== null && css.includes('.bg-red-500'))).toBe(false);
  });

  it('merges into an existing css prop (author code wins)', async () => {
    const p = setup();
    const out = await p.transform(
      `export const A = () => <div css={{ display: 'block' }} class="flex">x</div>;`,
      `${FIXTURE_DIR}f.tsx`,
    );
    expect(out?.code).toContain('css={[');
    expect(out?.code).toContain(`'block'`);
    expect(out?.code).toContain('display: "flex"');
  });

  it('merges into an existing css prop containing a template (no duplicate css)', async () => {
    const p = setup();
    const code = [
      'import { css } from "@qstyle/qwik";',
      'const k = css`@keyframes spin { from { opacity: 0; } to { opacity: 1; } }`;',
      'export const A = () => <div css={[k, { animation: "spin 1s" }]} class="flex">x</div>;',
    ].join('\n');
    const out = await p.transform(code, `${FIXTURE_DIR}tmpl.tsx`);
    expect(out).not.toBeNull();
    // css 属性は1個に統合される (重複は不正な JSX になるため)。
    expect(out?.code?.match(/css=\{/g)?.length).toBe(1);
    expect(out?.code).toContain('display: "flex"');
  });

  it('skips dynamic class expressions', async () => {
    const p = setup();
    expect(
      await p.transform(
        `export const A = () => <div class={cls}>x</div>;`,
        `${FIXTURE_DIR}g.tsx`,
      ),
    ).toBeNull();
  });

  it('is idempotent', async () => {
    const p = setup();
    const code = `export const A = () => <div class="flex gap-4">x</div>;`;
    const once = await p.transform(code, `${FIXTURE_DIR}h.tsx`);
    const twice = await p.transform(once?.code ?? '', `${FIXTURE_DIR}h.tsx`);
    // 2 回目は変換対象が残っていないため何もしない。
    expect(twice).toBeNull();
  });

  it('disables itself without a config', async () => {
    const plugin = UnoCSS() as unknown as TestPlugin;
    plugin.configResolved({ root: '/nonexistent-dir-for-qstyle-test' });
    expect(
      await plugin.transform(
        `export const A = () => <div class="flex">x</div>;`,
        '/nonexistent-dir-for-qstyle-test/a.tsx',
      ),
    ).toBeNull();
  });

  it('accepts inline presets like @unocss/vite (no config file)', async () => {
    const plugin = UnoCSS({ presets: [presetWind4()] }) as unknown as TestPlugin;
    plugin.configResolved({ root: '/nonexistent-dir-for-qstyle-test' });
    const out = await plugin.transform(
      `export const A = () => <div class="flex">x</div>;`,
      '/nonexistent-dir-for-qstyle-test/b.tsx',
    );
    expect(out?.code).toContain('css={{');
    expect(out?.code).toContain('display: "flex"');
  });

  it('merges inline config over the file (like @unocss/vite)', async () => {
    const plugin = UnoCSS({
      presets: [presetWind4()],
      theme: { colors: { brand: '#123456' } },
    }) as unknown as TestPlugin;
    plugin.configResolved({ root: FIXTURE_DIR });
    const out = await plugin.transform(
      `export const A = () => <div class="bg-brand">x</div>;`,
      `${FIXTURE_DIR}merge.tsx`,
    );
    expect(out?.code).toContain('css={{');
    expect(out?.code).toContain('var(--colors-brand)');
  });

  it('accepts an explicit config path string', async () => {
    const plugin = UnoCSS(
      fileURLToPath(new URL('./uno-fixture/uno.config.ts', import.meta.url)),
    ) as unknown as TestPlugin;
    plugin.configResolved({ root: '/nonexistent-dir-for-qstyle-test' });
    const out = await plugin.transform(
      `export const A = () => <div class="flex">x</div>;`,
      '/nonexistent-dir-for-qstyle-test/c.tsx',
    );
    expect(out?.code).toContain('display: "flex"');
  });

  it('ignores vite-only output keys', async () => {
    const plugin = UnoCSS({
      presets: [presetWind4()],
      mode: 'global',
    }) as unknown as TestPlugin;
    plugin.configResolved({ root: '/nonexistent-dir-for-qstyle-test' });
    const out = await plugin.transform(
      `export const A = () => <div class="flex">x</div>;`,
      '/nonexistent-dir-for-qstyle-test/d.tsx',
    );
    expect(out?.code).toContain('display: "flex"');
  });
});
