import './baseline.css';
// app の root document。QstyleLinks は <head> 内 (QwikCityProvider の配下なら
// useLocation が使える)。SSG ではここで描画した <link> が静的 HTML に焼かれる。
import { component$ } from '@qwik.dev/core';
import { QwikCityProvider, RouterOutlet } from '@qwik.dev/router';
import { QstyleLinks } from '@qstyle/qwik/links';

export default component$(() => (
  <QwikCityProvider>
    <head>
      <meta charSet="utf-8" />
      <title>qstyle lifecycle fixture</title>
      <QstyleLinks prefetch="hover" />
    </head>
    <body lang="ja">
      <RouterOutlet />
    </body>
  </QwikCityProvider>
));
