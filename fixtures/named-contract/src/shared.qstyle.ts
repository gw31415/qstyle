import { css } from '@qstyle/qwik';

/** A single generated pack consumed by both route components. */
export const shared = css({ color: 'rgb(12, 34, 56)' });

/** Two lazy owners intentionally consume this same generated pack. */
export const lazy = css({
  backgroundColor: 'rgb(224, 240, 255)',
  border: '2px solid rgb(36, 96, 160)',
});
