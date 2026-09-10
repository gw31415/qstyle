// app の root document。CSS 配信は vite/qwik 標準配管
// (pack css import -> vite bundle) のため、qstyle 固有の head 配線は不要。
import { component$ } from '@qwik.dev/core';
import { QwikCityProvider, RouterOutlet } from '@qwik.dev/router';

export default component$(() => (
  <QwikCityProvider>
    <head>
      <meta charSet="utf-8" />
      <title>qstyle lifecycle fixture</title>
    </head>
    <body lang="ja">
      <RouterOutlet />
    </body>
  </QwikCityProvider>
));
