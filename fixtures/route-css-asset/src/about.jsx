import { Shared } from './shared.jsx';

// route `/about` のみで使われる component (route-local)。home.jsx と宣言が重複
// しないよう別の property 構成にする (同一 atom set だと unit が共有される)。
export function About() {
  return (
    <section css={{ display: 'grid', gap: 4, margin: 8 }}>
      <Shared />
      <span css={{ color: 'teal', fontWeight: 600 }}>about</span>
    </section>
  );
}
