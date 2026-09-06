// QWK-015 (nested lazy) 用。lazy-panel.tsx からも lazy に読まれる別 chunk。
import { component$ } from '@qwik.dev/core';

export const LazyInner = component$(() => (
  <div
    data-testid="lazy-inner"
    css={{ outline: '3px dashed tomato', fontSize: 13, marginTop: 4 }}
  >
    lazy inner
  </div>
));
