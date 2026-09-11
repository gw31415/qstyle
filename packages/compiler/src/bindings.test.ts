import { describe, expect, it } from 'vitest';
import { collectCssPropSites, isCssMacro, validateAuthoringUses } from './bindings.js';
import { parseStyleModule } from './parse.js';

describe('lexical authoring bindings', () => {
  it('accepts imported component aliases and rejects a shadowed spelling', () => {
    const source = parseStyleModule(`import { component$ as view } from '@qwik.dev/core';
      export const Card = view(() => <div css={{ color: 'red' }} />);`, 'card.tsx');
    expect(collectCssPropSites(source)).toHaveLength(1);
    const fake = parseStyleModule(`const component$ = (x: unknown) => x;
      export const Card = component$(() => <div css={{ color: 'red' }} />);`, 'fake.tsx');
    expect(() => collectCssPropSites(fake)).toThrow('QS1103');
  });

  it('recognizes namespace macro imports but not an unrelated css function', () => {
    const source = parseStyleModule(`import * as styles from '@qstyle/qwik';
      styles.css({color:'red'}); function css(x: unknown) { return x; } css({color:'blue'});`, 'styles.ts');
    const results: boolean[] = [];
    source.program.traverse({ CallExpression(path) { results.push(isCssMacro(path.get('callee'))); } });
    expect(results).toEqual([true, false]);
  });

  it('retains synchronous inline map ownership and rejects an arbitrary render helper', () => {
    const module = parseStyleModule(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => <>{[1,2].map(n => <div key={n} css={{width:n}} />)}</>);`, 'map.tsx');
    expect(collectCssPropSites(module)).toHaveLength(1);
    const helper = parseStyleModule(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => { const helper = () => <div css={{width:2}} />; return helper(); });`, 'helper.tsx');
    expect(() => collectCssPropSites(helper)).toThrow('QS1103');
  });

  it('reports component css props and malformed syntax instead of leaving them behind', () => {
    const module = parseStyleModule(`import {component$} from '@qwik.dev/core';
      export const C = component$(() => <Other css={{width:2}} />);`, 'component.tsx');
    expect(() => collectCssPropSites(module)).toThrow('QS1103');
    expect(() => parseStyleModule('export const x = <div css={', 'broken.tsx')).toThrow('QS1101');
  });

  it('rejects runtime handle escapes but permits static alias composition', () => {
    const module = (body: string) => parseStyleModule(`import {css} from '@qstyle/qwik';
      import {component$} from '@qwik.dev/core'; const base=css({color:'red'}); ${body}`, 'uses.tsx');
    expect(() => validateAuthoringUses(module('send(base);'))).toThrow(/escapes/);
    expect(() => validateAuthoringUses(module('const holder={base};'))).toThrow(/escapes/);
    expect(() => validateAuthoringUses(module('console.log(base.atoms);'))).toThrow(/escapes/);
    expect(() => validateAuthoringUses(module('const both=[base]; export const C=component$(()=><div css={both}/>);'))).not.toThrow();
  });
});
