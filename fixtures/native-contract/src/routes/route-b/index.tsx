import { component$ } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';
import { SharedStylePack } from '../../components/native-styles';

export default component$(() => (
  <main data-testid="route-b" class="adapter-route-only">
    <h1>route B</h1>
    <Link href="/" data-testid="to-a">
      route A
    </Link>
    <SharedStylePack />
    <p class="native-shared" data-testid="shared-b-route">
      shared on B
    </p>
  </main>
));
