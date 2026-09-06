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

      {/* CSS semantics gallery (CSS-004/005/011/015/016/017/018 differential 用)。
        baseline 生成器は flat static + 1 段 nested + 既存 class merge に対応する。 */}
      <div data-testid="g-inherit-p" css={{ color: 'olive' }}>
        <span data-testid="g-inherit-c">inherit</span>
      </div>
      <div data-testid="g-noninh-p" css={{ marginTop: '21px' }}>
        <span data-testid="g-noninh-c">no-inherit</span>
      </div>
      <p data-testid="g-where" className="g-on" css={{ '&:where(.g-on)': { color: 'teal' } }}>
        where
      </p>
      <div style={{ color: 'orange' }}>
        <p data-testid="g-current" css={{ color: 'currentColor' }}>
          current
        </p>
      </div>
      <p data-testid="g-var" css={{ padding: 'var(--gsec-missing, 9px)' }}>
        var
      </p>
      <p data-testid="g-logical" css={{ marginInlineStart: '13px', paddingBlockEnd: '7px' }}>
        logical
      </p>
      <p data-testid="g-direction" css={{ direction: 'rtl' }}>
        direction
      </p>

      <LegacyGlobal />
      <LegacyScopedA />
      <LegacyScopedB />
    </main>
  );
});
