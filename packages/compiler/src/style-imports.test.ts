import { describe, expect, it } from 'vitest';
import { parseStyleModule } from './parse.js';
import { rewriteStyleImports } from './style-imports.js';

describe('named Qwik style import replacement', () => {
  it('preserves other bindings, aliases, type imports, and caller shadowing', () => {
    const source = `import Qwik,{useSignal,useStyles$ as css,useStylesScoped$,type QRL} from '@qwik.dev/core';
      import type {useStyles$} from '@qwik.dev/core';
      function demo(css:()=>void){css()} `;
    const result = rewriteStyleImports(source, 'input.ts', 'virtual:style-hooks')!;
    const parsed = parseStyleModule(result.code, 'input.ts');
    const imports = parsed.program.node.body.filter((node) => node.type === 'ImportDeclaration');
    expect(imports.map((node) => [node.source.value, node.specifiers.map((item) => item.local.name)])).toEqual([
      ['@qwik.dev/core', ['Qwik', 'useSignal', 'QRL']], ['virtual:style-hooks', ['css', 'useStylesScoped$']],
      ['@qwik.dev/core', ['useStyles$']],
    ]);
    expect(result.code).toContain('function demo(css:()=>void){css()}');
    expect(result.map.sourcesContent).toEqual([source]);
  });
  it('marks only the compiler-owned hook call, never text inside its CSS literal', () => {
    const source = `import {component$,useStyles$} from '@qwik.dev/core';
      export const StylePack=component$(()=>{useStyles$('.x{content:\" );return null;\"}');return null;});`;
    const result = rewriteStyleImports(source, 'pack.tsx', 'virtual:style-hooks', true)!;
    const parsed = parseStyleModule(result.code, 'pack.tsx');
    const args: unknown[] = [];
    parsed.program.traverse({ CallExpression(path) {
      if (path.node.callee.type === 'Identifier' && path.node.callee.name === 'useStyles$') {
        args.push(path.node.arguments.map((node) => 'value' in node ? node.value : undefined));
      }
    } });
    expect(args).toEqual([['.x{content:" );return null;"}', true]]);
    expect(result.map.sourcesContent).toEqual([source]);
  });
  it('optionally redirects only renderer bindings and keeps server types and other exports', () => {
    const code = `import {renderToString as render,renderToStream, type RenderToStringOptions, versions} from '@qwik.dev/core/server';`;
    const result = rewriteStyleImports(code, 'entry.tsx', 'style-runtime', false, 'server-runtime')!;
    const imports = parseStyleModule(result.code, 'entry.tsx').program.node.body
      .filter((node) => node.type === 'ImportDeclaration');
    expect(imports.map((node) => [node.source.value, node.specifiers.map((item) => item.local.name)])).toEqual([
      ['@qwik.dev/core/server', ['RenderToStringOptions', 'versions']], ['server-runtime', ['render', 'renderToStream']],
    ]);
    expect(rewriteStyleImports(code, 'entry.tsx', 'style-runtime')).toBeUndefined();
  });
  it('leaves namespaces, other modules, and side-effect imports untouched', () => {
    const code = `import * as q from '@qwik.dev/core';import '@qwik.dev/core';
      import {useStyles$} from 'other';q.useStyles$('a{}');`;
    expect(rewriteStyleImports(code, 'input.ts', 'virtual:style-hooks')).toBeUndefined();
  });
});
