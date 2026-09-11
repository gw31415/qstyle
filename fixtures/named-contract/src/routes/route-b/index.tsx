import { component$ } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';
import { shared } from '../../shared.qstyle';
import { css } from '@qstyle/qwik';

const routeBOnly = css({
  backgroundColor: 'rgb(255, 226, 180)',
  border: '2px solid rgb(160, 96, 36)',
});

export default component$(() => (
  <main data-testid="route-b">
    <h1>route B</h1>
    <Link href="/" data-testid="to-a">
      route A
    </Link>
    <p css={shared} data-testid="shared-b">
      shared on B
    </p>
    <p css={routeBOnly} data-testid="route-b-only">
      route B only
    </p>
  </main>
));
