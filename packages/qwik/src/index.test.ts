import { describe, expect, it } from 'vitest';
import { css } from './index.js';

describe('qwik css stub', () => {
  it('accepts object syntax', () => {
    const h = css({ display: 'flex' });
    expect(h.__qstyleBrand).toBe('StyleHandle');
  });

  it('accepts tagged template syntax', () => {
    const h = css`
      display: flex;
    `;
    expect(h.__qstyleBrand).toBe('StyleHandle');
  });
});
