import { component$, useSignal } from '@qwik.dev/core';
import { QwikCityProvider, RouterOutlet } from '@qwik.dev/router';

/** The shell stays mounted while Qwik Router swaps the outlet. */
export default component$(() => {
  const input = useSignal('shell input');
  const status = useSignal('ready');

  return (
    <QwikCityProvider>
      <head>
        <meta charSet="utf-8" />
        <title>named routing contract</title>
      </head>
      <body>
        <header data-testid="persistent-shell" data-page-token="named-route-page">
          <input
            data-testid="shell-input"
            value={input.value}
            onInput$={(_event, target) => {
              input.value = target.value;
            }}
          />
          <button
            data-testid="shell-update"
            onClick$={() => {
              status.value = status.value === 'ready' ? 'updated' : 'ready';
            }}
          >
            update shell
          </button>
          <span data-testid="shell-status">{status.value}</span>
        </header>
        <RouterOutlet />
      </body>
    </QwikCityProvider>
  );
});
