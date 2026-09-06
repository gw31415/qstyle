// QWK-010/011/012 用の legacy hooks component 群 (§24: rewrite 対象外)。
// - LegacyGlobal: useStyles$ (global style)
// - LegacyScopedA / LegacyScopedB: useStylesScoped$。両者とも同じ class 名
//   `.clash` を使い、異なる宣言にする (QWK-012: scoped 衝突 leak なし)。
// css prop (qstyle) と同じ page 内で共存する (QWK-010/011)。
import { component$, useStyles$, useStylesScoped$ } from '@qwik.dev/core';
import globalCss from './legacy-global.css?inline';
import scopedACss from './legacy-a.css?inline';
import scopedBCss from './legacy-b.css?inline';

export const LegacyGlobal = component$(() => {
  useStyles$(globalCss);
  return (
    <p class="legacy-global" data-testid="legacy-global">
      legacy global
    </p>
  );
});

export const LegacyScopedA = component$(() => {
  useStylesScoped$(scopedACss);
  return (
    <p class="clash" data-testid="legacy-a">
      scoped A
    </p>
  );
});

export const LegacyScopedB = component$(() => {
  useStylesScoped$(scopedBCss);
  return (
    <p class="clash" data-testid="legacy-b">
      scoped B
    </p>
  );
});
