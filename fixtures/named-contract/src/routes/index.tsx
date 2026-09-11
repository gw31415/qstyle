import { component$, useSignal, useStyles$ as useNamedStyles$ } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';
import { ScopedControl } from '../components/scoped-control';
import { LazyOwner } from '../components/lazy-owner';
import { shared } from '../shared.qstyle';

const routeAStyles = `
.named-route-outside {
  color: rgb(0, 0, 0);
}
`;

const RouteAControl = component$(() => {
  const showLazy = useSignal(false);
  useNamedStyles$(routeAStyles);

  return (
    <main data-testid="route-a">
      <h1>route A</h1>
      <nav>
        <Link href="/route-b" data-testid="to-b">
          route B
        </Link>
      </nav>

      <p css={shared} data-testid="shared-a">
        shared on A
      </p>

      <ScopedControl />
      <div class="named-route-scoped named-route-outside" data-testid="scoped-outside">
        outside
      </div>

      <button
        data-testid="lazy-toggle"
        aria-expanded={showLazy.value}
        onClick$={() => {
          showLazy.value = !showLazy.value;
        }}
      >
        toggle lazy owners
      </button>
      {showLazy.value ? (
        <>
          <LazyOwner />
          <LazyOwner />
        </>
      ) : null}
    </main>
  );
});

export default RouteAControl;
