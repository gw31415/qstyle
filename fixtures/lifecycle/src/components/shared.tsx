// 全 route で共有する component + module scope の css() handle。
// chunk planner は module 単位の usage clustering で shared chunk に分離する
// (route-css-asset fixture と同じ挙動)。QWK-008 は同一 component を 3 回描いて
// asset fetch が 1 回であることを確認する。
import { component$ } from '@qwik.dev/core';
import { css } from '@qstyle/qwik';

export const sharedBox = css({
  border: '2px solid cornflowerblue',
  padding: 8,
  borderRadius: 4,
});

interface SharedProps {
  label: string;
}

export const Shared = component$((props: SharedProps) => (
  <div css={sharedBox} data-testid={`shared-${props.label}`}>
    shared {props.label}
  </div>
));
