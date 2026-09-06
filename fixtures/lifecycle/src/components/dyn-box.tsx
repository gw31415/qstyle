// DYN 系 (DYN-012/013/014/015/021) 用。useSignal の数値を css prop の width に
// template literal (compound) で渡す。lowering は custom property 分離戦略:
// class (width: var(--qstyle-...)) は静的に確定し、signal 更新は style 属性の
// custom property のみを書き換える (stylesheet への追記は発生しない)。
// pointermove で高頻度更新も起こす (DYN-021)。
import { component$, useSignal } from '@qwik.dev/core';

export const DynBox = component$(() => {
  const width = useSignal(100);
  return (
    <div
      data-testid="dyn-box"
      css={{ width: `${width.value}px`, backgroundColor: 'honeydew', padding: 4 }}
      onPointerMove$={(ev) => {
        // 高頻度更新。10..400 に clamp する (viewport からはみ出させない)。
        const next = Math.round(ev.clientX / 2);
        width.value = Math.max(10, Math.min(400, next));
      }}
    >
      <span data-testid="dyn-value">{width.value}</span>
      <button
        data-testid="dyn-inc"
        onClick$={() => {
          width.value = width.value + 1;
        }}
      >
        +1
      </button>
    </div>
  );
});
