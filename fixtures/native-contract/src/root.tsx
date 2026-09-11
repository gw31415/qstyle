import { component$ } from '@qwik.dev/core';
import { QwikCityProvider, RouterOutlet } from '@qwik.dev/router';

export default component$(() => (
  <QwikCityProvider>
    <head>
      <meta charSet="utf-8" />
      <title>native style contract</title>
    </head>
    <body>
      <RouterOutlet />
    </body>
  </QwikCityProvider>
));
