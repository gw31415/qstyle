import {
  component$,
  useSignal,
  useStylesScoped$ as useNamedStylesScoped$,
} from '@qwik.dev/core';

const scopedStyles = `
.named-route-scoped {
  color: rgb(168, 20, 92);
}
.named-route-scoped > .named-route-scoped-child {
  background-color: rgb(246, 224, 236);
}
`;

/** Keeps an authored scoped hook in the routed fixture. */
export const ScopedControl = component$(() => {
  const marker = useSignal('scoped');
  const styles = useNamedStylesScoped$(scopedStyles);

  return (
    <section data-testid="scoped-control" data-scope-id={styles.scopeId}>
      <div class="named-route-scoped" data-testid="scoped-inside">
        {marker.value}
        <span class="named-route-scoped-child" data-testid="scoped-child">
          inside
        </span>
      </div>
    </section>
  );
});
