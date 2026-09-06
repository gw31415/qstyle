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
      <h1 data-testid="home-title" class="qb-5">
        home
      </h1>

      <Shared label="one" />
      <Shared label="two" />
      <Shared label="three" />

      {/* QWK-009: 親子で同一宣言 (margin: 6px) */}
      <div data-testid="nested-parent" class="qb-6">
        <span data-testid="nested-child" class="qb-7">
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

      {/* CSS semantics gallery (CSS-004/005/011/015/016/017/018 differential 用)。
        baseline 生成器は flat static + 1 段 nested + 既存 class merge に対応する。 */}
      <div data-testid="g-inherit-p" class="qb-8">
        <span data-testid="g-inherit-c">inherit</span>
      </div>
      <div data-testid="g-noninh-p" class="qb-9">
        <span data-testid="g-noninh-c">no-inherit</span>
      </div>
      <p data-testid="g-where" className="g-on qb-10" >
        where
      </p>
      <div style={{ color: 'orange' }}>
        <p data-testid="g-current" class="qb-11">
          current
        </p>
      </div>
      <p data-testid="g-var" class="qb-12">
        var
      </p>
      <p data-testid="g-logical" class="qb-13">
        logical
      </p>
      <p data-testid="g-direction" class="qb-14">
        direction
      </p>

      <LegacyGlobal />
      <LegacyScopedA />
      <LegacyScopedB />
    </main>
  );
});
