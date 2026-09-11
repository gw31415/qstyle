import { describe, expect, it } from 'vitest';
import { parseStyleModule } from './parse.js';
import { resolveDocumentEntry } from './document-root.js';

function resolve(source: string, exportName = 'default') {
  return resolveDocumentEntry(parseStyleModule(source, 'root.tsx'), exportName);
}

describe('document entry resolution', () => {
  it('follows the generated SSG worker renderer, including aliases and catch handlers', () => {
    const prefix = `import {startWorker as start} from '@qwik.dev/router/ssg'; import render from './entry.ssr';`;
    expect(resolve(`${prefix} start({render,qwikRouterConfig}).catch((error)=>{console.error(error)});`))
      .toEqual({kind: 'reference', source: './entry.ssr', imported: 'default'});
    expect(resolve(`import {startWorker} from 'other'; startWorker({render:()=> <head/>});`)).toBeUndefined();
    expect(resolve(`${prefix} function unused(){start({render})}`)).toBeUndefined();
    expect(() => resolve(`${prefix} if(enabled) start({render});`)).toThrow('constructed unconditionally');
    expect(() => resolve(`${prefix} start({render,...unknown});`)).toThrow('unknown spread after render');
    expect(() => resolve(`${prefix} start({render: enabled ? render : other});`)).toThrow('Cannot prove the static render binding');
  });

  it('resolves module-scope Qwik middleware render bindings used by server adapters', () => {
    const prefix = `import {createQwikRouter} from '@qwik.dev/router/middleware/node'; import render from './entry.ssr';`;
    const expected = {kind: 'reference', source: './entry.ssr', imported: 'default'};
    expect(resolve(`${prefix} const {router,staticFile}=createQwikRouter({render,static:{root:'dist'}});`)).toEqual(expected);
    expect(resolve(`${prefix} const options={render}; const handlers=createQwikRouter(options); export default {fetch:handlers.router};`)).toEqual(expected);
    expect(resolve(`${prefix} export default createQwikRouter({render});`)).toEqual(expected);
    expect(resolve(`const createQwikRouter=()=>null; const router=createQwikRouter({render:()=> <head/>});`)).toBeUndefined();
  });

  it('rejects conditional, overwritten and escaped middleware render options', () => {
    const prefix = `import {createQwikRouter} from '@qwik.dev/router/middleware/node'; import render from './entry.ssr';`;
    expect(() => resolve(`${prefix} if (enabled) createQwikRouter({render});`)).toThrow('constructed unconditionally');
    expect(() => resolve(`${prefix} createQwikRouter({render,...unknown});`)).toThrow('unknown spread after render');
    expect(() => resolve(`${prefix} createQwikRouter({render,[key]:other});`)).toThrow('unknown computed property after render');
    expect(() => resolve(`${prefix} const options={render}; options.render=other; createQwikRouter(options);`)).toThrow('cannot escape or be mutated');
    expect(() => resolve(`${prefix} export const options={render}; createQwikRouter(options);`)).toThrow('cannot escape or be mutated');
    expect(() => resolve(`${prefix} createQwikRouter({render:enabled?render:other});`)).toThrow('Cannot prove the static render binding');
    expect(resolve(`${prefix} function unused(){return createQwikRouter({render})}`)).toBeUndefined();
  });

  it('rejects conditional heads and conditional imported document roots', () => {
    expect(() => resolve(`export default function Root({enabled}){return <>{enabled && <head/>}<body/></>}`))
      .toThrow('head must be unconditional');
    expect(() => resolve(`import Document from './document'; export default function Root({enabled}){return <>{enabled && <Document/>}</>}`))
      .toThrow('root component must be unconditional');
    expect(() => resolve(`export default function Root({enabled}){if(!enabled)return null; return <><head/><body/></>}`))
      .toThrow('cannot return from a conditional');
  });

  it('ignores uncalled nested functions that contain a head', () => {
    expect(resolve(`export default function Root(){function Unused(){return <head/>} return <body/>}`)).toBeUndefined();
    expect(resolve(`export default function Root(){const unused=()=> <head/>; return <><head/><body/></>}`)?.kind).toBe('head');
  });

  it('follows immutable aliases of public SSR render APIs without trusting spelling', () => {
    expect(resolve(`import * as server from '@qwik.dev/core/server'; import Document from './document';
      const render=server.renderToStream; export default async function entry(options){return await render(<Document/>,options)}`))
      .toEqual({kind: 'reference', source: './document', imported: 'default'});
    expect(resolve(`const renderToString=(node)=>null; export default function entry(){return renderToString(<head/>)}`))
      .toBeUndefined();
  });

  it('preserves the final jsx property of a public Router renderer result', () => {
    const prefix = `import {createRenderer as renderer} from '@qwik.dev/router'; import Document from './document';`;
    expect(resolve(`${prefix} export default renderer((options)=>{return {jsx:<Document/>,options}})`))
      .toEqual({kind: 'reference', source: './document', imported: 'default'});
    expect(resolve(`${prefix} export default renderer((options)=>({...options, ['jsx']:<Document/>}))`))
      .toEqual({kind: 'reference', source: './document', imported: 'default'});
    expect(() => resolve(`${prefix} export default renderer((options)=>({jsx:<Document/>, ...options}))`))
      .toThrow('unknown spread after jsx');
    expect(() => resolve(`${prefix} export default renderer((options)=>({jsx:<Document/>, [options.key]:null}))`))
      .toThrow('unknown computed property after jsx');
    expect(resolve(`${prefix} export default renderer((options)=>({jsx:<Document/>, jsx:null}))`)).toBeUndefined();
  });

  it('accepts JSX aliases but does not call returned function definitions', () => {
    expect(resolve(`const document = <><head/><body/></>;
      export default function Root(){return document;}`)?.kind).toBe('head');
    expect(resolve(`function Hidden(){return <head/>}
      export default function Root(){return Hidden;}`)).toBeUndefined();
  });

  it('does not treat a returned component$ factory as rendered JSX', () => {
    expect(resolve(`import {component$} from '@qwik.dev/core';
      export default function Root(){return component$(() => <head/>);}`)).toBeUndefined();
  });

  it('still resolves an exported component$ definition', () => {
    expect(resolve(`import {component$} from '@qwik.dev/core';
      export default component$(() => <head/>);`)?.kind).toBe('head');
  });

  it('requires named export declarations to retain immutable bindings', () => {
    expect(() => resolve(`export let Root = <head/>;`, 'Root')).toThrow(/immutable local bindings/);
    expect(() => resolve(`export const Root = <head/>; Root = <body/>;`, 'Root')).toThrow(/immutable local bindings/);
    expect(() => resolve(`function Root(){return <head/>} Root = () => <body/>; export {Root};`, 'Root'))
      .toThrow(/immutable local bindings/);
  });

  it('does not discover heads below ordinary DOM elements', () => {
    expect(resolve(`export default function Root(){return <body><head/></body>}`)).toBeUndefined();
    expect(resolve(`export default function Root(){return <template><head/></template>}`)).toBeUndefined();
    expect(resolve(`const ImportedRoot = () => <head/>;
      export default function Root(){return <body><ImportedRoot/></body>}`)).toBeUndefined();
  });
});
