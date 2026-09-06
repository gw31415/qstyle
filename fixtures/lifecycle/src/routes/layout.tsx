// root layout。全 route 共通の nav (client navigation 検証用の Link)。
// `<Slot />` が無いと route 内容の projection 先が無く、SSR 内容が q:template に
// 残って client で adopt されない (C0 基盤整備で実証済み)。
import { component$, Slot } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';

export default component$(() => (
  <>
    <nav data-testid="nav" css={{ display: 'flex', gap: 12, padding: 8 }}>
      <Link data-testid="nav-home" href="/">
        Home
      </Link>
      <Link data-testid="nav-about" href="/about">
        About
      </Link>
      <Link data-testid="nav-item" href="/item/42">
        Item 42
      </Link>
    </nav>
    <Slot />
  </>
));
