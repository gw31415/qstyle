import {
  component$,
  useSignal,
  useStyles$ as useNamedStyles$,
  useStylesScoped$ as useNamedStylesScoped$,
} from '@qwik.dev/core';
import type { Component } from '@qwik.dev/core';

/**
 * Authored global style. The hook is intentionally imported under an alias so
 * the fixture exercises the named-import rewrite rather than a call-site
 * replacement.
 */
const namedGlobalStyles = `
.named-hook-global {
  color: rgb(24, 88, 150);
}
`;

/**
 * The same class names are rendered inside and outside NamedScopedOwner. Only
 * the subtree owned by that component should receive these declarations.
 */
const namedScopedStyles = `
.named-hook-scoped {
  color: rgb(168, 20, 92);
}
.named-hook-scoped > .named-hook-scoped-child {
  background-color: rgb(246, 224, 236);
}
`;

const namedLazyStyles = `
.named-hook-lazy {
  background-color: rgb(224, 240, 255);
  border: 2px solid rgb(36, 96, 160);
}
`;

/**
 * An authored global hook with signals before it. This keeps the hook at a
 * nonzero sequential index while also giving the browser probe an input whose
 * value can be checked after resume and parent updates.
 */
const NamedGlobalOwner = component$(() => {
  const input = useSignal('named input');
  const status = useSignal('ready');
  const styles = useNamedStyles$(namedGlobalStyles);

  return (
    <div data-testid="named-global-owner" data-named-style-id={styles.styleId}>
      <p class="named-hook-global" data-testid="named-global-target">
        {status.value}
      </p>
      <input
        data-testid="named-retained-input"
        value={input.value}
        onInput$={(_event, target) => {
          input.value = target.value;
        }}
      />
      <button
        data-testid="named-global-update"
        onClick$={() => {
          status.value = status.value === 'ready' ? 'resumed' : 'ready';
        }}
      >
        update global owner
      </button>
    </div>
  );
});

/**
 * A scoped authored hook. The outside sentinel in NamedHookControls uses the
 * same selectors and proves that Qwik's scope marker remains local to this
 * owner after resume.
 */
const NamedScopedOwner = component$(() => {
  const marker = useSignal('scoped');
  const styles = useNamedStylesScoped$(namedScopedStyles);

  return (
    <div data-testid="named-scoped-owner" data-named-scope-id={styles.scopeId}>
      <div class="named-hook-scoped" data-testid="named-scoped-inside">
        {marker.value}
        <span class="named-hook-scoped-child" data-testid="named-scoped-child">
          inside
        </span>
      </div>
      <button data-testid="named-scoped-update" onClick$={() => { marker.value = 'scoped resumed'; }}>
        update scoped owner
      </button>
    </div>
  );
});

/**
 * A conditional owner that is created, removed, and created again. Its style
 * hook is also preceded by a signal to cover lazy/remount sequential scopes.
 */
const NamedLazyOwner = component$(() => {
  const renderCount = useSignal(1);
  const styles = useNamedStyles$(namedLazyStyles);

  return (
    <article class="named-hook-lazy" data-testid="named-lazy-owner" data-named-style-id={styles.styleId}>
      <span data-testid="named-lazy-render-count">{renderCount.value}</span>
      <span>lazy named hook owner</span>
    </article>
  );
});

/**
 * Mount this component from the compiler-contract root when testing authored
 * style hooks. The controls deliberately expose SSR, resume, and remount
 * boundaries without adding a second runtime or a Qwik patch.
 */
export const NamedHookControls: Component = component$(() => {
  const showLazy = useSignal(false);

  return (
    <section data-testid="named-hook-controls">
      <NamedGlobalOwner />
      <NamedScopedOwner />

      <div data-testid="named-scoped-outside" class="named-hook-scoped">
        outside
        <span class="named-hook-scoped-child" data-testid="named-scoped-outside-child">
          outside child
        </span>
      </div>

      <button
        data-testid="named-lazy-toggle"
        aria-expanded={showLazy.value}
        onClick$={() => {
          showLazy.value = !showLazy.value;
        }}
      >
        toggle named lazy owner
      </button>
      {showLazy.value ? <NamedLazyOwner /> : null}
    </section>
  );
});
