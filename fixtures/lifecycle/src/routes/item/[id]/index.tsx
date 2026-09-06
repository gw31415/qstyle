// dynamic route `/item/[id]`。onStaticGenerate で SSG 対象 param を列挙する
// (dynamic route は既定では SSG 対象外のため)。
import { component$ } from '@qwik.dev/core';
import { useLocation, type StaticGenerateHandler } from '@qwik.dev/router';
import { Shared } from '../../../components/shared';

export const onStaticGenerate: StaticGenerateHandler = async () => ({
  params: [{ id: '42' }, { id: '99' }],
});

export default component$(() => {
  const loc = useLocation();
  return (
    <main>
      <h1 data-testid="item-title" css={{ color: 'sienna', padding: 4 }}>
        item {loc.params.id}
      </h1>
      <Shared label={`item-${loc.params.id}`} />
    </main>
  );
});
