import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import presetWind4 from '@unocss/preset-wind4';
import defaultExport, { defineConfig, UnoCSS } from './index.js';

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
  const plugin = UnoCSS() as unknown as TestPlugin;
  plugin.configResolved({ root: FIXTURE_DIR });
  return plugin;
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

  it('emits verbatim CSS for class arrays without rewriting', async () => {
    const p = setup();
    const code = `export const A = (props: { c?: string }) => <div class={["flex w-full", props.c]}>x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}arr.tsx`);
    expect(out).not.toBeNull();
    // class 配列は触らない。rules は virtual CSS に出る。
    expect(out?.code).toContain('class={["flex w-full", props.c]}');
    const specs: string[] = [
      ...((out?.code ?? '').matchAll(/import "(virtual:qstyle-uno\/c\/[0-9a-f]+\.css)";/g) ?? []),
    ].map((m) => m[1] as string);
    const bodies: (string | null)[] = specs.map((spec) => {
      const id: string | null = p.resolveId(spec);
      return id === null ? null : p.load(id);
    });
    expect(bodies.some((css) => css !== null && css.includes('.flex'))).toBe(true);
  });

  it('picks up literals outside class attributes (Record style)', async () => {
    const p = setup();
    const code = `const m: Record<string, string> = { a: "font-sans flex" };\nexport const A = () => <div class={m.a}>x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}rec.tsx`);
    expect(out).not.toBeNull();
    expect(out?.code).toContain('class={m.a}');
    const specs: string[] = [
      ...((out?.code ?? '').matchAll(/import "(virtual:qstyle-uno\/c\/[0-9a-f]+\.css)";/g) ?? []),
    ].map((m) => m[1] as string);
    const bodies: (string | null)[] = specs.map((spec) => {
      const id: string | null = p.resolveId(spec);
      return id === null ? null : p.load(id);
    });
    expect(
      bodies.some((css) => css !== null && css.includes('font-family')),
    ).toBe(true);
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
    const p = setup();
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

  it('emits verbatim CSS without touching the class', async () => {
    const p = setup();
    const code = `export const A = () => <div class="m-4 mt-2">x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}e.tsx`);
    expect(out).not.toBeNull();
    expect(out?.code).toContain('class="m-4 mt-2"');
    const specs: string[] = [
      ...((out?.code ?? '').matchAll(/import "(virtual:qstyle-uno\/c\/[0-9a-f]+\.css)";/g) ?? []),
    ].map((m) => m[1] as string);
    expect(specs.length).toBeGreaterThan(0);
    const bodies: (string | null)[] = specs.map((spec) => {
      const id: string | null = p.resolveId(spec);
      return id === null ? null : p.load(id);
    });
    expect(bodies.some((css) => css !== null && css.includes('.m-4'))).toBe(true);
  });

  it('emits :is() instead of :where() for selector utilities', async () => {
    // ponytail: `:where()` (specificity 0) は preflight の `*` と同点になり、
    // dev の遅延注入順で勝敗が変わってちらつく。`:is()` は matching が同一で
    // 順序に依らず utility が勝つ。
    const p = setup();
    const code = `export const A = () => <div class="flex divide-y divide-border">x</div>;`;
    const out = await p.transform(code, `${FIXTURE_DIR}div.tsx`);
    expect(out).not.toBeNull();
    const specs: string[] = [
      ...((out?.code ?? '').matchAll(/import "(virtual:qstyle-uno\/c\/[0-9a-f]+\.css)";/g) ?? []),
    ].map((m) => m[1] as string);
    const bodies: (string | null)[] = specs.map((spec) => {
      const id: string | null = p.resolveId(spec);
      return id === null ? null : p.load(id);
    });
    const css: string = bodies.filter((b) => b !== null).join('\n');
    expect(css).toContain('.divide-y');
    expect(css).toContain(':is(');
    expect(css).not.toContain(':where(');
  });

  it('emits verbatim for dynamic uses even when statically converted elsewhere', async () => {
    const p = setup();
    // bg-red-500 は静的 class では翻訳されるが、三項内の同名も
    // verbatim で出す (条件付き要素との両立。重複分は同一宣言で無害)。
    const code = [
      'export const A = (props: { on: boolean }) => (<>',
      '  <div class="absolute inset-0 rounded-full bg-red-500" />',
      '  <div class={[props.on ? "bg-red-500" : "bg-blue-500"]} />',
      '</>);',
    ].join('\n');
    const out = await p.transform(code, `${FIXTURE_DIR}both.tsx`);
    expect(out).not.toBeNull();
    expect(out?.code).toContain('css={{');
    const specs: string[] = [
      ...((out?.code ?? '').matchAll(/import "(virtual:qstyle-uno\/c\/[0-9a-f]+\.css)";/g) ?? []),
    ].map((m) => m[1] as string);
    const bodies: (string | null)[] = specs.map((spec) => {
      const id: string | null = p.resolveId(spec);
      return id === null ? null : p.load(id);
    });
    expect(bodies.some((css) => css !== null && css.includes('.bg-red-500'))).toBe(true);
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
