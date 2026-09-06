// route `/about` (Qwik City 規約の index.tsx 形。同名 basename の区別は
// vite plugin の root 相対 moduleKey が行う)。
// QWK-003/004 の client navigation の行き先。scoped 衝突相手 B も置く。
import { component$ } from '@qwik.dev/core';
import { Shared } from '../../components/shared';
import { LegacyScopedB } from '../../components/legacy';

export default component$(() => (
  <main>
    <h1 data-testid="about-title" class="qb-4">
      about
    </h1>
    <Shared label="about" />
    <LegacyScopedB />
  </main>
));
