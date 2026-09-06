// route `/` (home)。検証要素:
// - css prop (inline object) / css() handle (shared.tsx) の混在
// - QWK-008: 同一 component (Shared) を 3 回描く
// - QWK-009: 親子で同じ宣言 (margin: 6px) → 同一 atom に dedup される
// - QWK-005..007/015: lazy component (LazyPanel, LazyInner)
// - DYN 系: DynBox
// - QWK-010..012: legacy hooks (useStyles$ / useStylesScoped$ x2)
import { component$, useSignal } from '@qwik.dev/core';
import { Shared } from '../components/shared';
import { DynBox } from '../components/dyn-box';
import { LazyPanel } from '../components/lazy-panel';
import { LegacyGlobal, LegacyScopedA, LegacyScopedB } from '../components/legacy';

export default component$(() => {
  const showLazy = useSignal(false);
  return (
    <main>
      <h1 data-testid="home-title" css={{ fontSize: 20, color: 'seagreen' }}>
        home
      </h1>

      <Shared label="one" />
      <Shared label="two" />
      <Shared label="three" />

      {/* QWK-009: 親子で同一宣言 (margin: 6px) */}
      <div data-testid="nested-parent" css={{ margin: '6px' }}>
        <span data-testid="nested-child" css={{ margin: '6px' }}>
          nested
        </span>
      </div>

      <button
        data-testid="lazy-toggle"
        onClick$={() => {
          showLazy.value = !showLazy.value;
        }}
      >
        toggle lazy
      </button>
      {showLazy.value ? <LazyPanel /> : null}

      <DynBox />

      <LegacyGlobal />
      <LegacyScopedA />
      <LegacyScopedB />
    </main>
  );
});
