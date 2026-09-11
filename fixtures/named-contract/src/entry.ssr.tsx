import { renderToStream, type RenderToStreamOptions } from '@qwik.dev/core/server';
import Root from './root';

/** Pass Router's renderer options through the named server runtime when enabled. */
export default function render(options: RenderToStreamOptions) {
  return renderToStream(<Root />, { ...options, preloader: false });
}
