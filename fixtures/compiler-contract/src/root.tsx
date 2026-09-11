import { component$, useSignal, useStyles$ } from '@qwik.dev/core';
import { css } from '@qstyle/qwik';
import { NamedHookControls } from './named-hook-controls';

const shared = css({ color: 'rgb(12, 34, 56)' });

const HeadStyle = component$(() => {
  useStyles$('#head-order{color:rgb(100,0,0)}');
  return null;
});

const Lazy = component$(() => <aside id="lazy" class="contract-lazy animate-spin underline" css={[shared, { backgroundColor: 'rgb(230, 240, 255)', borderWidth: 2 }]}>
  lazy panel
</aside>);

const App = component$(() => {
  const width = useSignal(100);
  const visible = useSignal(false);
  const rounded = useSignal(false);
  return <>
      <span id="head-order">head source order</span>
      <input id="input" value="retained" />
      <button id="grow" onClick$={() => width.value++}>grow</button>
      <div id="width" css={[shared, { width: width.value }]}>{width.value}</div>
      <button id="show" onClick$={() => visible.value = !visible.value}>toggle lazy</button>
      <button id="round" onClick$={() => rounded.value = !rounded.value}>toggle radius</button>
      <section id="utility" class={rounded.value ? 'contract-pad contract-round group' : 'contract-pad contract-square group'}
        css={{ color: 'var(--contract-foundation)' }}>utility state</section>
      <section id="utility-order" css={{ color: 'rgb(0, 100, 0)' }} class="contract-red external">CSS wins</section>
      <section id="wind4" class="flex items-center gap-2 group">
        <span id="wind4-child" class="group-hover:opacity-50 w-[123px]">preset utility</span>
      </section>
      <ol id="structure">
        <li id="structure-first" css={{ '&:first-child': { color: 'rgb(100, 0, 100)' } }}>first</li>
        <li id="structure-second" css={{ 'li + &': { color: 'rgb(0, 100, 100)' } }}>second</li>
      </ol>
      {visible.value && <Lazy />}
      <NamedHookControls />
  </>;
});

export default function Root() {
  return <><head><title>compiler contract</title><HeadStyle />
    <style dangerouslySetInnerHTML="#head-order{color:rgb(0,100,0)}" />
  </head><body><App /></body></>;
}
