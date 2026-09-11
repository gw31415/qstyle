import { renderToString, renderToStream, type RenderToStringOptions, type RenderToStreamOptions } from '@qwik.dev/core/server';
import Root from './root';

export default function render(options: RenderToStringOptions) {
  const renderOptions = { ...options, preloader: false,
    ...(process.env.QSTYLE_CONTRACT_HEAD ? { stylePlacement: 'head' } : {}),
  };
  return renderToString(<Root />, renderOptions);
}

export function renderStream(options: RenderToStreamOptions) {
  return renderToStream(<Root />, { ...options, preloader: false });
}
