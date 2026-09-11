import { component$, useStyles$ } from '@qwik.dev/core';

export const SharedStylePack = component$(() => {
  useStyles$('.native-shared { color: rgb(12, 34, 56); }');
  return null;
});

// Equal CSS text in separate components intentionally keeps separate Qwik
// style identities. The native contract must observe both definitions.
export const InlineLiteralA = component$(() => {
  useStyles$(
    `
    .native-identical { color: rgb(78, 90, 12); }
  `,
  );
  return <p class="native-identical">identical A</p>;
});

export const InlineLiteralB = component$(() => {
  useStyles$(
    `
    .native-identical { color: rgb(78, 90, 12); }
  `,
  );
  return <p class="native-identical">identical B</p>;
});

export const LazyNativePanel = component$(() => {
  useStyles$(
    `
    .native-lazy { background: rgb(230, 240, 255); border: 2px solid rgb(20, 80, 160); }
  `,
  );
  return (
    <section class="native-lazy" data-testid="lazy-panel">
      lazy panel
    </section>
  );
});
