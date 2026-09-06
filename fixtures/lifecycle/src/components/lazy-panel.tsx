// QWK-005/006/007/015 用の lazy component。qwik は component$ ごとに chunk を
// 分割するため、この module は home の初期 JS に含まれず render された時点で
// 初めて fetch される (= この module に注入された ensureModuleStyles も直前に
// 動く)。内部にさらに別 module の lazy (LazyInner) を持つ (QWK-015 nested lazy)。
import { component$, useSignal } from '@qwik.dev/core';
import { LazyInner } from './lazy-inner';

export const LazyPanel = component$(() => {
  const showInner = useSignal(false);
  return (
    <section
      data-testid="lazy-panel"
      css={{ backgroundColor: 'lavender', padding: 12, minHeight: 24 }}
    >
      lazy panel
      <button
        data-testid="lazy-nested-toggle"
        onClick$={() => {
          showInner.value = !showInner.value;
        }}
      >
        toggle inner
      </button>
      {showInner.value ? <LazyInner /> : null}
    </section>
  );
});
