import { createRenderer } from '@qwik.dev/router';
import Root from './root';

export default createRenderer((opts) => ({
  jsx: <Root />,
  // Keep route and style QRL requests attributable to the interaction that
  // needs them. The browser probe separately measures prefetch behavior.
  options: { ...opts, preloader: false },
}));
