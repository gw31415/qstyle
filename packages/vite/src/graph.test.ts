import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { affectedStyleModules, buildStyleGraph, transformGraphModule, type SourceGraphOptions } from './graph.js';
import { createNativeModules } from './native.js';
import { parseStyleCss, type UtilityAdapter } from '@qstyle/compiler';

function options(files: Record<string, string>, entries = ['/app/src/root.tsx']): SourceGraphOptions {
  return {
    root: '/app', entries,
    read: async (id) => { if (!(id in files)) throw new Error(`Missing ${id}`); return files[id]!; },
    resolve: async (specifier, importer) => {
      if (specifier.startsWith('@qstyle/') || specifier.startsWith('@qwik.dev/')) return { id: specifier, external: true };
      const base = specifier.startsWith('~/') ? `/app/src/${specifier.slice(2)}`
        : specifier.startsWith('/') ? specifier : posix.resolve(posix.dirname(importer!), specifier);
      const id = [base, `${base}.ts`, `${base}.tsx`].find((candidate) => candidate in files);
      return id ? { id } : undefined;
    },
  };
}

describe('whole-source style graph', () => {
  const foundationOnly: UtilityAdapter = { async resolve() {
    return { foundation: [{ kind: 'layer-order', names: ['reset', 'utilities'] }], states: [] };
  } };

  it('discovers route styles without treating route modules as document entries', async () => {
    const files = {
      '/app/src/root.tsx': `export default function Root(){return <><head/><body/></>}`,
      '/app/src/routes.ts': `export const routes=[()=>import('./route')];`,
      '/app/src/route.tsx': `import {component$} from '@qwik.dev/core';
        export default component$(()=> <main css={{paddingTop:'23px'}}/>);`,
    };
    const graph = await buildStyleGraph({ ...options(files), discoveryEntries: ['/app/src/routes.ts'], utilities: {
      async resolve(requests) { return { foundation: [{ kind: 'layer-order', names: ['reset', 'utilities'] }],
        states: requests.map((request) => ({ id: request.id, nodes: [], consumedTokens: [], retainedTokens: request.tokens })) }; },
    } });
    expect(graph.analyses.get('/app/src/root.tsx')!.foundation).toBeDefined();
    expect(graph.analyses.get('/app/src/route.tsx')!.foundation).toBeUndefined();
    expect(graph.program.packs.some((pack) => pack.css.includes('padding-top:23px'))).toBe(true);
    await expect(buildStyleGraph({ ...options(files), discoveryEntries: ['/app/src/missing.ts'] })).rejects.toThrow('Cannot discover application source');
  });

  it('does not mistake an unused imported head for the application document', async () => {
    const files = {
      '/app/src/root.tsx': `import './unused'; export default function Root(){return <body/>}`,
      '/app/src/unused.tsx': `export default function Unused(){return <head/>}`,
    };
    await expect(buildStyleGraph({ ...options(files), utilities: foundationOnly })).rejects.toThrow('Cannot prove a document head');
  });

  it('does not interpret a returned component function as a rendered document', async () => {
    const files = {
      '/app/src/root.tsx': `function Hidden(){return <head/>} export default function Root(){return Hidden;}`,
    };
    await expect(buildStyleGraph({ ...options(files), utilities: foundationOnly })).rejects.toThrow('Cannot prove a document head');
  });

  it('ignores unused heads when the actual root has a document head', async () => {
    const files = {
      '/app/src/root.tsx': `import './unused'; export default function Root(){return <><head/><body/></>}`,
      '/app/src/unused.tsx': `export default function Unused(){return <head/>}`,
    };
    const graph = await buildStyleGraph({ ...options(files), utilities: foundationOnly });
    expect(graph.analyses.get('/app/src/root.tsx')!.foundation).toBeDefined();
    expect(graph.analyses.get('/app/src/unused.tsx')!.foundation).toBeUndefined();
  });

  it('follows the public SSR render argument through an exported root barrel', async () => {
    const files = {
      '/app/src/entry.ssr.tsx': `import {renderToString as render} from '@qwik.dev/core/server';
        import Document from './barrel'; export default function entry(options){return render(<Document/>,options)}`,
      '/app/src/barrel.ts': `export {default} from './root';`,
      '/app/src/root.tsx': `export default function Root(){return <><head/><body/></>}`,
    };
    const graph = await buildStyleGraph({ ...options(files, ['/app/src/entry.ssr.tsx']), utilities: foundationOnly });
    expect(graph.analyses.get('/app/src/root.tsx')!.foundation).toBeDefined();
    expect(graph.analyses.get('/app/src/entry.ssr.tsx')!.foundation).toBeUndefined();
  });

  it('does not trust a local function named renderToString', async () => {
    const files = {
      '/app/src/entry.ssr.tsx': `import Root from './root'; const renderToString=()=>null;
        export default function entry(){return renderToString(<Root/>);}`,
      '/app/src/root.tsx': `export default function Root(){return <><head/><body/></>}`,
    };
    await expect(buildStyleGraph({ ...options(files, ['/app/src/entry.ssr.tsx']), utilities: foundationOnly })).rejects.toThrow('Cannot prove a document head');
  });

  it('deduplicates client and SSR entry references to the same document root', async () => {
    const files = {
      '/app/src/entry.ssr.tsx': `import * as server from '@qwik.dev/core/server'; import Root from './root';
        export default async function entry(options){return server.renderToStream(<Root/>,options)}`,
      '/app/src/root.tsx': `export default function Root(){return <><head/><body/></>}`,
    };
    const graph = await buildStyleGraph({ ...options(files, ['/app/src/entry.ssr.tsx', '/app/src/root.tsx']), utilities: foundationOnly });
    expect([...graph.analyses.values()].filter((analysis) => analysis.foundation)).toHaveLength(1);
    expect(graph.program.packs).toHaveLength(1);
  });

  it('follows the Qwik Router createRenderer document callback', async () => {
    const files = {
      '/app/src/entry.ssr.tsx': `import {createRenderer} from '@qwik.dev/router'; import Root from './root';
        export default createRenderer((options)=>({jsx:<Root/>,options}));`,
      '/app/src/root.tsx': `export default function Root(){return <><head/><body/></>}`,
    };
    const graph = await buildStyleGraph({ ...options(files, ['/app/src/entry.ssr.tsx']), utilities: foundationOnly });
    expect(graph.analyses.get('/app/src/root.tsx')!.foundation).toBeDefined();
  });

  it('follows a Node server adapter entry through its middleware render option', async () => {
    const files = {
      '/app/src/entry.node-server.tsx': `import {createQwikRouter} from '@qwik.dev/router/middleware/node';
        import render from './entry.ssr'; const {router}=createQwikRouter({render,static:{root:'dist'}});`,
      '/app/src/entry.ssr.tsx': `import {createRenderer} from '@qwik.dev/router'; import Root from './root';
        export default createRenderer((options)=>({jsx:<Root/>,options}));`,
      '/app/src/root.tsx': `export default function Root(){return <><head/><body/></>}`,
    };
    const graph = await buildStyleGraph({ ...options(files, ['/app/src/entry.node-server.tsx']), utilities: foundationOnly });
    expect(graph.analyses.get('/app/src/root.tsx')!.foundation).toBeDefined();
    expect([...graph.analyses.values()].filter((analysis) => analysis.foundation)).toHaveLength(1);
  });

  it('rejects distinct document roots rather than choosing one by input order', async () => {
    const files = {
      '/app/src/root.tsx': `export default function Root(){return <><head/><body/></>}`,
      '/app/src/other.tsx': `export default function Other(){return <><head/><body/></>}`,
    };
    await expect(buildStyleGraph({ ...options(files, ['/app/src/other.tsx', '/app/src/root.tsx']), utilities: foundationOnly }))
      .rejects.toThrow('one document head across application render entries');
  });

  it('rejects an unproven input even when a different input has a valid root', async () => {
    const files = {
      '/app/src/root.tsx': `export default function Root(){return <><head/><body/></>}`,
      '/app/src/other.ts': `export default function Other(){return null}`,
    };
    await expect(buildStyleGraph({ ...options(files, ['/app/src/root.tsx', '/app/src/other.ts']), utilities: foundationOnly }))
      .rejects.toThrow('src/other.ts');
  });

  it('terminates cyclic root reexports without finding an unrelated head', async () => {
    const files = {
      '/app/src/root.tsx': `import './unused'; export { default } from './other';`,
      '/app/src/other.ts': `export { default } from './root';`,
      '/app/src/unused.tsx': `export default function Unused(){return <head/>}`,
    };
    await expect(buildStyleGraph({ ...options(files), utilities: foundationOnly })).rejects.toThrow('Cannot prove a document head');
  });

  it('follows a loader-provided virtual entry reexport to the source document', async () => {
    const files = { '/app/src/root.tsx': `export default function Root(){return <><head/><body/></>}` };
    const source = options(files);
    const graph = await buildStyleGraph({ ...source, entries: ['virtual:document'], utilities: foundationOnly,
      resolve: async (specifier, importer) => specifier === 'virtual:document' ? { id: specifier } : source.resolve(specifier, importer),
      loadVirtual: async () => `export {default} from '/app/src/root.tsx';`,
    });
    expect(graph.analyses.get('/app/src/root.tsx')!.foundation).toBeDefined();
  });

  it('preserves font-face order inside one payload even when source order reverses hash order', async () => {
    for (const faces of [['first', 'second'], ['second', 'first']]) {
      const parsed = parseStyleCss(faces.map((name) => `@font-face{font-family:Contract;src:url(${name}.woff2);}`).join(''));
      const files = { '/app/src/root.tsx': 'export default function Root(){return <><head/><body/></>}' };
      const graph = await buildStyleGraph({ ...options(files), utilities: { async resolve() {
        return { foundation: parsed.globals.map((value) => ({ kind: 'global' as const, value, wrappers: [] })), states: [] };
      } } });
      expect(graph.program.packs).toHaveLength(1);
      const css = graph.program.packs[0]!.css;
      expect(css.indexOf(`${faces[0]}.woff2`)).toBeLessThan(css.indexOf(`${faces[1]}.woff2`));
    }
  });

  it('retains an empty foundation owner in dev and omits it in production', async () => {
    const files = { '/app/src/root.tsx': 'export default function Root(){return <><head/><body/></>}' };
    const utilities: UtilityAdapter = { async resolve() { return { foundation: [], states: [] }; } };
    const development = await buildStyleGraph({ ...options(files), utilities, development: true });
    expect(development.program.packs).toHaveLength(1);
    expect(development.program.packs[0]!.css).toBe('');
    expect(transformGraphModule(development, '/app/src/root.tsx', files['/app/src/root.tsx'])!.code).toContain('StylePack');
    const production = await buildStyleGraph({ ...options(files), utilities });
    expect(production.program.packs).toHaveLength(0);
    expect(transformGraphModule(production, '/app/src/root.tsx', files['/app/src/root.tsx'])).toBeUndefined();
  });

  it('ignores per-specifier type-only imports and reexports during runtime discovery', async () => {
    const files = { '/app/src/root.tsx': `import { type Missing } from './types'; export { type Other } from './other';
      import {component$} from '@qwik.dev/core'; export const Root=component$(()=><div css={{color:'red'}}/>);` };
    const graph = await buildStyleGraph(options(files));
    expect(graph.modules.size).toBe(1);
    expect(graph.program.declarations).toHaveLength(1);
  });

  it('integrates utility class choices, root foundation and lazy keyframes in one graph', async () => {
    const files = {
      '/app/src/root.tsx': `import {component$} from '@qwik.dev/core';
        export const App=component$(({active})=><div class={active?'red group':'blue group'} css={{padding:8}}/>);
        export default function Root(){return <><head/><body><App/></body></>}
        export const load=()=>import('./lazy.tsx');`,
      '/app/src/lazy.tsx': `import {component$} from '@qwik.dev/core';
        export const Lazy=component$(()=><aside class="animate"/>);`,
    };
    const utilities: UtilityAdapter = { async resolve(requests) {
      const foundationRule = { ...parseStyleCss('&{--brand:red;}').rules[0]!,
        selector: { alternatives: [[{ kind: 'text' as const, text: ':root' }]] } };
      return { foundation: [{ kind: 'layer-order', names: ['reset', 'utilities'] }, { kind: 'global-rule', rule: foundationRule }],
        states: requests.map((request) => {
          const parsed = parseStyleCss(request.tokens.includes('animate')
            ? '@keyframes spin{to{opacity:0;}}&{animation:spin 1s;}'
            : `&{color:${request.tokens.includes('red') ? 'red' : 'blue'};}`);
          return { id: request.id, nodes: [...parsed.rules.map((rule) => ({ kind: 'local' as const, token: request.tokens[0]!, rule })),
            ...parsed.globals.map((value) => ({ kind: 'global' as const, value, wrappers: [] }))],
          consumedTokens: request.tokens.filter((token) => token !== 'group'), retainedTokens: request.tokens.filter((token) => token === 'group') };
        }) };
    } };
    const graph = await buildStyleGraph({ ...options(files), utilities });
    const root = graph.analyses.get('/app/src/root.tsx')!;
    const lazy = graph.analyses.get('/app/src/lazy.tsx')!;
    const cssFor = (demand: string) => graph.program.packsByDemand.get(demand)!.map((id) => graph.program.packs.find((pack) => pack.id === id)!.css).join('');
    expect(cssFor(root.foundation!.demandId)).toContain(':root{--brand:red;}');
    expect(cssFor(root.foundation!.demandId)).toMatch(/^@layer reset,utilities;/);
    expect(cssFor(root.foundation!.demandId)).not.toContain('@keyframes');
    expect(cssFor(root.sites[0]!.plan.states[0]!.demand.id)).not.toContain('@keyframes');
    expect(cssFor(lazy.sites[0]!.plan.states[0]!.demand.id)).toMatch(/@keyframes qk1_[a-f0-9]{32}/);
    expect(graph.program.fixedDeclarations).toHaveLength(1);
    expect(graph.program.declarations.filter((item) => item.definition.declaration.property === 'padding')).toHaveLength(1);
    const emitted = transformGraphModule(graph, '/app/src/root.tsx', files['/app/src/root.tsx'])!;
    expect(emitted.code).toMatch(/<head><__qstyle_Pack\d+\/>/);
  });

  it('discovers aliases, static reexports and lazy imports before global optimization', async () => {
    const files = {
      '/app/src/root.tsx': `import {component$} from '@qwik.dev/core';import {shared} from '~/barrel.qstyle';
        export const Root=component$(()=> <div css={[shared,{padding:8}]}/>);
        export const load=()=>import('./lazy.tsx');`,
      '/app/src/barrel.qstyle.ts': `export {base as shared} from './base.qstyle';`,
      '/app/src/base.qstyle.ts': `import {css} from '@qstyle/qwik';export const base=css({color:'red'});`,
      '/app/src/lazy.tsx': `import {component$} from '@qwik.dev/core';import {base} from './base.qstyle';
        export const Lazy=component$(()=> <aside css={[base,{margin:12}]}/>);`,
    };
    const graph = await buildStyleGraph(options(files));
    expect(graph.modules.size).toBe(4);
    expect(graph.program.declarations).toHaveLength(3);
    const red = graph.program.packs.filter((pack) => pack.css.includes('color:red;'));
    expect(red).toHaveLength(1);
    expect(red[0]!.demandIds).toHaveLength(2);
    expect(graph.program.cover.optimality.status).toBe('optimal');
    expect([...affectedStyleModules(graph, ['/app/src/base.qstyle.ts'])].sort()).toEqual(Object.keys(files).sort());
    const emitted = transformGraphModule(graph, '/app/src/root.tsx', files['/app/src/root.tsx']);
    expect(emitted?.code).not.toContain(' css=');
    expect(emitted?.code).not.toContain('margin:12');
  });

  it('resolves chained export-star style reexports', async () => {
    const files = {
      '/app/src/root.tsx': `import {component$} from '@qwik.dev/core';import {card} from './barrel.qstyle';
        export const Root=component$(()=> <div css={card}/>);`,
      '/app/src/barrel.qstyle.ts': `export * from './middle.qstyle';`,
      '/app/src/middle.qstyle.ts': `export * from './base.qstyle';`,
      '/app/src/base.qstyle.ts': `import {css} from '@qstyle/qwik';export const card=css({color:'red'});`,
    };
    const graph = await buildStyleGraph(options(files));
    expect(graph.program.declarations).toHaveLength(1);
    expect(graph.program.packs.some((pack) => pack.css.includes('color:red;'))).toBe(true);
  });

  it('resolves concrete bindings through a finite export-star cycle', async () => {
    const files = {
      '/app/src/root.tsx': `import {component$} from '@qwik.dev/core';import {card} from './a.qstyle';export const C=component$(()=> <div css={card}/>);`,
      '/app/src/a.qstyle.ts': `export * from './b.qstyle';`,
      '/app/src/b.qstyle.ts': `export * from './a.qstyle';export * from './base.qstyle';`,
      '/app/src/base.qstyle.ts': `import {css} from '@qstyle/qwik';export const card=css({color:'red'});`,
    };
    const graph = await buildStyleGraph(options(files));
    expect(graph.program.packs.map((pack) => pack.css).join('')).toContain('color:red;');
  });

  it('lets an explicit named export override a colliding export-star name', async () => {
    const files = {
      '/app/src/root.tsx': `import {component$} from '@qwik.dev/core';import {card} from './barrel.qstyle';
        export const Root=component$(()=> <div css={card}/>);`,
      '/app/src/barrel.qstyle.ts': `import {css} from '@qstyle/qwik';export * from './star.qstyle';export const card=css({color:'blue'});`,
      '/app/src/star.qstyle.ts': `import {css} from '@qstyle/qwik';export const card=css({color:'red'});`,
    };
    const graph = await buildStyleGraph(options(files));
    expect(graph.program.declarations).toHaveLength(1);
    expect(graph.program.packs.some((pack) => pack.css.includes('color:blue;'))).toBe(true);
    expect(graph.program.packs.some((pack) => pack.css.includes('color:red;'))).toBe(false);
  });

  it('excludes default from export-star reexports', async () => {
    const files = {
      '/app/src/root.tsx': `import {component$} from '@qwik.dev/core';import {default as card} from './barrel.qstyle';
        export const Root=component$(()=> <div css={card}/>);`,
      '/app/src/barrel.qstyle.ts': `export * from './base.qstyle';`,
      '/app/src/base.qstyle.ts': `export default {color:'red'};`,
    };
    await expect(buildStyleGraph(options(files))).rejects.toThrow('Unknown .qstyle export default');
  });

  it('rejects ambiguous export-star reexports', async () => {
    const files = {
      '/app/src/root.tsx': `import {component$} from '@qwik.dev/core';import {card} from './barrel.qstyle';
        export const Root=component$(()=> <div css={card}/>);`,
      '/app/src/barrel.qstyle.ts': `export * from './a.qstyle';export * from './b.qstyle';`,
      '/app/src/a.qstyle.ts': `import {css} from '@qstyle/qwik';export const card=css({color:'red'});`,
      '/app/src/b.qstyle.ts': `import {css} from '@qstyle/qwik';export const card=css({color:'blue'});`,
    };
    await expect(buildStyleGraph(options(files))).rejects.toThrow('Ambiguous .qstyle export card');
  });

  it('retains the prior frozen generation when a new generation fails', async () => {
    const files = { '/app/src/root.tsx': `import {component$} from '@qwik.dev/core';export const C=component$(()=> <div css={{color:'red'}}/>);` };
    const first = await buildStyleGraph(options(files), 1);
    const original = files['/app/src/root.tsx'];
    files['/app/src/root.tsx'] = original.replace("{color:'red'}", 'unknownStyles()');
    await expect(buildStyleGraph(options(files), 2)).rejects.toThrow('QS1102');
    expect(first.generation).toBe(1);
    expect(first.program.packs[0]!.css).toContain('color:red;');
    expect(() => transformGraphModule(first, '/app/src/root.tsx', files['/app/src/root.tsx'])).toThrow('QS1401');
    expect(() => transformGraphModule(first, '/app/src/new.tsx', original)).toThrow('QS1401');
  });

  it('emits shared keyframes once and rewrites their actual declaration references', async () => {
    const files = {
      '/app/src/root.tsx': `import {component$} from '@qwik.dev/core';import {css} from '@qstyle/qwik';
        const animation=css\`@keyframes pulse{from{opacity:0}to{opacity:1}}animation:pulse 1s;\`;
        export const C=component$(()=> <><div css={animation}/><aside css={animation}/></>);`,
    };
    const graph = await buildStyleGraph(options(files));
    const packs = graph.program.packs;
    const global = packs.filter((pack) => pack.css.includes('@keyframes'));
    expect(global).toHaveLength(1);
    expect(global[0]!.demandIds).toHaveLength(2);
    expect(global[0]!.globalIds).toHaveLength(1);
    const name = global[0]!.globalIds![0]!;
    expect(global[0]!.css).toContain(`@keyframes ${name}`);
    expect(packs.filter((pack) => pack.css.includes(`animation:${name} 1s;`))).toHaveLength(1);
    const modules = createNativeModules(packs, true);
    expect(new Set(modules.map((module) => module.id)).size).toBe(packs.length);
  });

  it('tracks unmanaged CSS instead of claiming whole-site coverage', async () => {
    const files = { '/app/src/root.tsx': `import './external.css';`, '/app/src/external.css': '.external{color:red}' };
    const graph = await buildStyleGraph(options(files));
    expect(graph.unmanagedStylesheets).toEqual(['src/external.css']);
    expect(graph.program.packs).toHaveLength(0);
  });

  it('keeps native dev module identity stable when only CSS values change', async () => {
    const files = { '/app/src/root.tsx': `import {component$} from '@qwik.dev/core';export const C=component$(()=> <div css={{color:'red'}}/>);` };
    const first = await buildStyleGraph(options(files));
    files['/app/src/root.tsx'] = files['/app/src/root.tsx'].replace("'red'", "'blue'");
    const second = await buildStyleGraph(options(files));
    const before = createNativeModules(first.program.packs, true)[0]!;
    const after = createNativeModules(second.program.packs, true)[0]!;
    expect(before.id).toBe(after.id);
    expect(before.source).not.toBe(after.source);
    expect(createNativeModules(first.program.packs, false)[0]!.id)
      .not.toBe(createNativeModules(second.program.packs, false)[0]!.id);
    expect(after.source).toContain('useStyles$(');
    expect(after.source).not.toContain('@qwik.dev/core/internal');
  });

  it('keeps development owner ordering and classes stable across shared CSS edits', async () => {
    const id = '/app/src/root.tsx';
    const files = { [id]: `import {component$} from '@qwik.dev/core';
      export const C=component$(()=> <><div css={{color:'red',width:100}}/><aside css={{color:'red',padding:8}}/></>);` };
    const first = await buildStyleGraph({ ...options(files), development: true });
    files[id] = files[id].replaceAll("'red'", "'blue'");
    const second = await buildStyleGraph({ ...options(files), development: true });
    const emitted = (graph: typeof first) => {
      const modules = new Map(createNativeModules(graph.program.packs, true).map((module) => [module.packId, module.id]));
      return transformGraphModule(graph, id, graph.modules.get(id)!.code, { dev: true, packModule: (pack) => modules.get(pack)! })!.code;
    };
    expect(emitted(second)).toBe(emitted(first));
  });
});
