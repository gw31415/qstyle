import { Shared } from './shared.jsx';

// route `/` のみで使われる component (route-local)。HASH-007: この style を変更して
// 再 build しても、`/about` 由来 chunk の file 名 (hash) は不変であること。
export function Home() {
  return (
    <section css={{ display: 'flex', flexDirection: 'column', padding: 16 }}>
      <Shared />
      <span css={{ color: 'crimson', fontSize: 14 }}>home</span>
    </section>
  );
}
