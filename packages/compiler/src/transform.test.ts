import { describe, expect, it } from 'vitest';
import { optimizeStyleProgram } from '@qstyle/core';
import { analyzeStyleModule, emitStyleModule, composeUtilityStates, utilityRequests } from './transform.js';
import { parseStyleModule } from './parse.js';
import { parseStyleCss } from './css.js';
import type { UtilityState } from './utility-contract.js';

function compile(code: string) {
  const analysis = analyzeStyleModule(code, 'transform.fixture.tsx');
  const states = analysis.sites.flatMap(({ plan }) => plan.states);
  const program = optimizeStyleProgram(states);
  return { analysis, emitted: emitStyleModule(analysis, program) };
}

it('keeps a literal styled child static without an extra Fragment or empty style prop', async () => {
  const { emitted } = compile(`import {component$} from '@qwik.dev/core';
    export const C=component$(()=><main><p id="static" title="a &amp; b" css={{color:'red'}}>text</p></main>);`);
  const { component } = await executeComponent(emitted.code, () => { throw new Error('Unexpected runtime evaluation'); });
  const root = component({}) as { type: string; props: { children: Array<{ type: string; props: Record<string, unknown> }> } };
  expect(root.type).toBe('main');
  expect(root.props.children).toHaveLength(2);
  expect(root.props.children[1]!.type).toBe('p');
  expect(root.props.children[1]!.props).toMatchObject({ id: 'static', title: 'a & b' });
  expect(root.props.children[1]!.props).not.toHaveProperty('style');
  expect(String(root.props.children[1]!.props.class)).toMatch(/^q1_/);
});

type RenderComponent = (props: Record<string, unknown>) => unknown;

async function executeComponent(
  code: string, read: (name: string) => unknown,
): Promise<{ readonly component: RenderComponent; readonly transformed: string }> {
  const { transformWithOxc } = await import('vite');
  const transformed = await transformWithOxc(code, 'generated.tsx', {
    lang: 'tsx', jsx: { runtime: 'classic', pragma: 'jsx', pragmaFrag: 'Fragment' },
  });
  const body = transformed.code.replace(/^import .*;\s*$/gm, '').replace(/export const C/, 'const C');
  const packs = [...new Set(body.match(/\b__qstyle_Pack\d+\b/g) ?? [])];
  const run = new Function('component$', 'jsx', 'Fragment', 'read', ...packs,
    `${body};return C;`) as (...args: unknown[]) => RenderComponent;
  const component$ = (render: unknown): unknown => render;
  const jsx = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
    type, props: { ...(props ?? {}), ...(children.length ? { children } : {}) },
  });
  return { component: run(component$, jsx, Symbol('Fragment'), read, ...packs.map(() => null)), transformed: transformed.code };
}

describe('TSX style transform', () => {
  function compileUtilities(code: string) {
    const initial = analyzeStyleModule(code, 'utility.fixture.tsx', { utilities: true });
    const definitions: Record<string, string> = { red: 'color:red;', blue: 'color:blue;', pad: 'padding:8px;' };
    const resolved = new Map(utilityRequests(initial).map((request) => [request.id, {
      id: request.id,
      nodes: request.tokens.flatMap((token) => definitions[token] ? parseStyleCss(`&{${definitions[token]}}`).rules
        .map((rule) => ({ kind: 'local' as const, token, rule })) : []),
      consumedTokens: request.tokens.filter((token) => !!definitions[token]),
      retainedTokens: request.tokens.filter((token) => !definitions[token]),
    } satisfies UtilityState]));
    const analysis = composeUtilityStates(initial, resolved);
    const program = optimizeStyleProgram(analysis.sites.flatMap((site) => site.plan.states));
    return { analysis, program, emitted: emitStyleModule(analysis, program) };
  }

  it('composes finite classes with CSS choices without replaying either predicate', async () => {
    const { emitted, program, analysis } = compileUtilities(`import {component$} from '@qwik.dev/core';
      export const C=component$(()=><div css={[read('css') ? {opacity:1} : {opacity:0}, {color:'green'}]}
        class={read('class') ? 'red pad group' : 'blue pad external'} style={{width:read('width')}}/>);`);
    expect(analysis.sites[0]!.plan.states).toHaveLength(4);
    expect(program.packs.map((pack) => pack.css).join('')).not.toMatch(/color:(red|blue);/);
    for (const classValue of [true, false]) for (const cssValue of [true, false]) {
      const calls: string[] = [];
      const { component } = await executeComponent(emitted.code, (name) => {
        calls.push(name); return name === 'class' ? classValue : name === 'css' ? cssValue : 101;
      });
      const rendered = JSON.stringify(component({}));
      const index = (classValue ? 0 : 2) + (cssValue ? 0 : 1);
      expect(calls).toEqual(['css', 'class', 'width']);
      expect(rendered).toContain(classValue ? 'group' : 'external');
      expect(rendered).not.toMatch(/"(?:red|blue|pad)"/);
      for (const name of program.classesByState.get(analysis.sites[0]!.plan.states[index]!.id)!) expect(rendered).toContain(name);
    }
  });

  it('handles class-only sites and stored class initializers once', async () => {
    const { emitted, analysis } = compileUtilities(`import {component$} from '@qwik.dev/core';
      export const C=component$(()=>{const attrs={class:read('choose')?'red group':'blue group'};
        return <div id={read('id')} {...attrs}/>;});`);
    expect(analysis.sites[0]!.source.occurrences).toHaveLength(0);
    const calls: string[] = [];
    const { component } = await executeComponent(emitted.code, (name) => { calls.push(name); return true; });
    const rendered = JSON.stringify(component({}));
    expect(calls).toEqual(['choose', 'id']);
    expect(rendered).toContain('group');
    expect(rendered).toMatch(/q1_[a-f0-9]{32}/);
    expect(rendered).not.toContain('red');
  });

  it('requires resolved utility states and enforces the combined state limit', () => {
    const initial = analyzeStyleModule(`import {component$} from '@qwik.dev/core';
      export const C=component$(({active})=><div class={active?'red':'blue'} css={active?{opacity:1}:{opacity:0}}/>);`,
    'limit.tsx', { utilities: true });
    expect(() => composeUtilityStates(initial, new Map())).toThrow('QS1401');
    const resolved = new Map(utilityRequests(initial).map((request) => [request.id,
      { id: request.id, nodes: [], retainedTokens: request.tokens, consumedTokens: [] }]));
    expect(() => composeUtilityStates(initial, resolved, 3)).toThrow('QS1602');
  });

  it('emits parseable TSX with no css props or live css macros', () => {
    const { analysis, emitted } = compile(`import {component$} from '@qwik.dev/core';
      import {css} from '@qstyle/qwik';
      const base = css({color:'red'});
      export const C = component$(() => <div css={[base, {padding:8}]} />);`);
    expect(analysis.macros).toHaveLength(1);
    expect(emitted.code).not.toMatch(/\bcss\s*=/);
    expect(emitted.code).not.toMatch(/\bcss\s*\(/);
    expect(() => parseStyleModule(emitted.code, 'generated.tsx')).not.toThrow();
  });

  it('keeps nested elements and conditional branches parseable', () => {
    const { emitted } = compile(`import {component$} from '@qwik.dev/core';
      export const C = component$(({show}: {show: boolean}) => <main css={{padding:8}}>
        {show ? <span css={{color:'red'}} /> : <em css={{color:'blue'}} />}
      </main>);`);
    expect(() => parseStyleModule(emitted.code, 'generated.tsx')).not.toThrow();
    expect((emitted.code.match(/\bcss\s*=/g) ?? [])).toHaveLength(0);
  });

  it('evaluates every source attribute once in source order and merges class/style', async () => {
    const { emitted } = compile(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => <button
        data-before={read('before')}
        css={{width:read('width')}}
        onClick$={read('event')}
        class={read('class')}
        style={{color:read('style')}}
      />);`);
    const before = emitted.code.indexOf(`read('before')`);
    const width = emitted.code.indexOf(`read('width')`);
    const event = emitted.code.indexOf(`read('event')`);
    const classValue = emitted.code.indexOf(`read('class')`);
    const style = emitted.code.indexOf(`read('style')`);
    expect([before, width, event, classValue, style]).toEqual([...new Set([before, width, event, classValue, style])]);
    expect(before).toBeLessThan(width);
    expect(width).toBeLessThan(event);
    expect(event).toBeLessThan(classValue);
    expect(classValue).toBeLessThan(style);
    expect(emitted.code).toMatch(/class=\{\[[^\]]+,\"q1_[a-f0-9]{32}\"\]\}/);
    expect(emitted.code).toMatch(/style=\{\(typeof [^ ]+===\"string\"\?/);
    expect(emitted.code).toMatch(/\.\.\.[^,}]+,\.\.\.[^)]+\}/);

    const calls: string[] = [];
    const { component: C } = await executeComponent(emitted.code, (name) => { calls.push(name); return name; });
    const rendered = C({});
    expect(calls).toEqual(['before', 'width', 'event', 'class', 'style']);
    const root = rendered as { readonly props: { readonly children: readonly [{}, { readonly props: Record<string, unknown> }] } };
    const props = root.props.children[1].props;
    expect(props.class).toEqual(['class', expect.stringMatching(/^q1_[a-f0-9]{32}$/)]);
    expect(props.style).toMatchObject({ color: 'style' });
    expect(Object.keys(props.style as object).some((key) => key.startsWith('--qstyle-1-'))).toBe(true);
  });

  it('emits only the selected branch inputs at runtime', async () => {
    const { emitted } = compile(`import {component$} from '@qwik.dev/core';
      export const C = component$(({flag}: {flag: boolean}) => <div css={flag
        ? {width:read('yes')} : {width:read('no')}} />);`);
    const first = await executeComponent(emitted.code, () => undefined);
    expect(first.transformed).toContain('jsx(');
    expect(first.transformed).toContain('read("yes")');
    expect(first.transformed).toContain('read("no")');
    const calls: string[] = [];
    const read = (name: string): number => { calls.push(name); return name === 'yes' ? 100 : 200; };
    const { component: C } = await executeComponent(emitted.code, read);
    C({ flag: true });
    expect(calls).toEqual(['yes']);
    calls.length = 0;
    C({ flag: false });
    expect(calls).toEqual(['no']);
  });

  it('diagnoses unknown spreads and reserved style namespaces', () => {
    expect(() => compile(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => <div {...props} css={{color:'red'}} />);`)).toThrow('QS1102');
    expect(() => compile(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => <div style={{'--qstyle-secret':'x'}} css={{color:'red'}} />);`)).toThrow('QS1102');
    expect(() => compile(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => <div style="--qstyle-secret:x" css={{color:'red'}} />);`)).toThrow('QS1102');
  });

  it('lowers css supplied by a static spread without leaking a css prop', () => {
    const { analysis, emitted } = compile(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => <div {...{css:{color:'red'}}} />);`);
    expect(analysis.sites).toHaveLength(1);
    expect(emitted.code).not.toMatch(/\bcss\s*=/);
    const declarations = analysis.sites[0]!.plan.states[0]!.rules.flatMap((rule) => rule.declarations);
    expect(declarations.filter((declaration) => declaration.property === 'color').map((declaration) =>
      declaration.value.kind === 'static' ? declaration.value.css : undefined))
      .toEqual(['red']);
  });

  it('merges static spread style/class values with an explicit css prop', async () => {
    const { emitted } = compile(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => <div {...{class:'from-spread', style:{color:'blue'}, css:{padding:8}}} />);`);
    expect(emitted.code).not.toMatch(/\bcss\s*=/);
    expect(emitted.code).not.toMatch(/\bstyle=\{\{color/);
    const { component: C } = await executeComponent(emitted.code, () => undefined);
    const rendered = C({}) as { readonly props: { readonly children: readonly [{}, { readonly props: Record<string, unknown> }] } };
    const props = rendered.props.children[1].props;
    expect(props.class).toEqual(['from-spread', expect.stringMatching(/^q1_[a-f0-9]{32}$/)]);
    expect(props.style).toMatchObject({ color: 'blue' });
  });

  it('uses the last static css write for duplicate spread/attribute declarations', () => {
    const { analysis } = compile(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => <div {...{css:{color:'red'}}} css={{color:'blue'}} />);`);
    const declarations = analysis.sites[0]!.plan.states[0]!.rules.flatMap((rule) => rule.declarations);
    expect(declarations.filter((declaration) => declaration.property === 'color').map((declaration) =>
      declaration.value.kind === 'static' ? declaration.value.css : undefined))
      .toEqual(['blue']);
  });

  it('evaluates overwritten css spread values once without applying them', async () => {
    const { analysis, emitted } = compile(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => <div {...{css:{color:read('old')}, css:{padding:8}}} />);`);
    const declarations = analysis.sites[0]!.plan.states[0]!.rules.flatMap((rule) => rule.declarations);
    expect(declarations.some((declaration) => declaration.property === 'color')).toBe(false);
    const calls: string[] = [];
    const { component: C } = await executeComponent(emitted.code, (name) => { calls.push(name); return name; });
    C({});
    expect(calls).toEqual(['old']);
  });

  it('evaluates a final dynamic css spread value once', async () => {
    const { emitted } = compile(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => <div {...{css:{color:read('color')}}} />);`);
    const calls: string[] = [];
    const { component: C } = await executeComponent(emitted.code, (name) => { calls.push(name); return 'red'; });
    C({});
    expect(calls).toEqual(['color']);
  });

  it('reads stored spread CSS values without replaying their initializers', async () => {
    const { emitted } = compile(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => {
        const attrs={css:{color:read('color'), width:read('width')}};
        return <div id={read('id')} {...attrs}/>;
      });`);
    const calls: string[] = [];
    const { component: C } = await executeComponent(emitted.code, (name) => { calls.push(name); return name === 'width' ? 101 : 'red'; });
    const rendered = JSON.stringify(C({}));
    expect(calls).toEqual(['color', 'width', 'id']);
    expect(rendered).toContain('101px');
  });

  it('rejects stored spread objects whose shape may be mutated or aliased', () => {
    for (const effect of ["attrs.css.color='blue';", 'mutate(attrs);', 'const alias=attrs;']) {
      expect(() => compile(`import {component$} from '@qwik.dev/core';
        export const C = component$(() => {
          const attrs={css:{color:read('color')}};
          ${effect}
          return <div {...attrs}/>;
        });`)).toThrow('QS1102');
    }
  });

  it('preserves evaluation order within a final css spread', async () => {
    const { emitted } = compile(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => <div {...{css:{color:read('css')}, id:read('id')}} />);`);
    const calls: string[] = [];
    const { component: C } = await executeComponent(emitted.code, (name) => { calls.push(name); return name; });
    C({});
    expect(calls).toEqual(['css', 'id']);
  });

  it('preserves evaluation of an overwritten explicit css attribute', async () => {
    const { analysis, emitted } = compile(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => <div css={{color:read('old')}} css={{padding:8}} />);`);
    const declarations = analysis.sites[0]!.plan.states[0]!.rules.flatMap((rule) => rule.declarations);
    expect(declarations.some((declaration) => declaration.property === 'color')).toBe(false);
    const calls: string[] = [];
    const { component: C } = await executeComponent(emitted.code, (name) => { calls.push(name); return name; });
    C({});
    expect(calls).toEqual(['old']);
  });

  it('rejects unknown spreads for spread-only css sites', () => {
    expect(() => compile(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => <div {...props} />);`)).toThrow('QS1102');
    expect(() => compile(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => <div {...props} css={{color:'red'}} />);`)).toThrow('QS1102');
  });

  it('rejects a bare css import captured by another runtime binding', () => {
    expect(() => analyzeStyleModule(`import {css} from '@qstyle/qwik';
      const factory = css;
      export const value = factory;`, 'escape.ts')).toThrow('QS1102');
    expect(() => analyzeStyleModule(`import * as styles from '@qstyle/qwik';
      const factory = styles.css;
      export const value = factory;`, 'namespace-escape.ts')).toThrow('QS1102');
  });

  it('retains original source content and mappings', () => {
    const source = `import {component$} from '@qwik.dev/core';
      export const C = component$(() => <div data-value={read()} css={{color:'red'}} />);`;
    const { emitted } = compile(source);
    expect(emitted.map.sources).toContain('transform.fixture.tsx');
    expect(emitted.map.sourcesContent).toContain(source);
    expect(emitted.map.mappings).toMatch(/[A-Za-z]/);
  });
});
