import { component$, useSignal } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';
import {
  InlineLiteralA,
  InlineLiteralB,
  LazyNativePanel,
  SharedStylePack,
} from '../components/native-styles';

export default component$(() => {
  const showShared = useSignal(false);
  const showLazy = useSignal(false);

  return (
    <main data-testid="route-a">
      <h1 data-testid="title">native style contract</h1>
      <nav>
        <Link href="/route-b" data-testid="to-b">
          route B
        </Link>
      </nav>

      {/* Two instances exercise Qwik's shared style identity. */}
      <SharedStylePack />
      <SharedStylePack />
      <p class="native-shared" data-testid="shared-a">
        shared A
      </p>
      <p class="native-shared" data-testid="shared-b">
        shared B
      </p>

      <InlineLiteralA />
      <InlineLiteralB />

      <button
        data-testid="show-shared"
        onClick$={() => {
          showShared.value = true;
        }}
      >
        show shared instance
      </button>
      {showShared.value ? (
        <>
          <SharedStylePack />
          <p class="native-shared" data-testid="shared-extra">
            shared extra
          </p>
        </>
      ) : null}

      <button
        data-testid="show-lazy"
        onClick$={() => {
          showLazy.value = true;
        }}
      >
        show lazy
      </button>
      {showLazy.value ? <LazyNativePanel /> : null}
    </main>
  );
});
