import { component$ } from '@qwik.dev/core';
import { lazy } from '../shared.qstyle';

/** Every instance uses the same generated style pack. */
export const LazyOwner = component$(() => (
  <article css={lazy} class="named-route-lazy" data-testid="lazy-owner">
    lazy owner
  </article>
));
