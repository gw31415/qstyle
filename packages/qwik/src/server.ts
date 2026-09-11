import { renderToStringWithHeadStyles, renderToStreamWithHeadStyles } from './ssr-style-placement.js';
import type {
  RenderToStreamOptions,
  RenderToStreamResult,
  RenderToStringOptions,
  RenderToStringResult,
  renderToString as nativeRender,
} from '@qwik.dev/core/server';

type Input = Parameters<typeof nativeRender>[0];
export const renderToString = (jsx: Input, options: RenderToStringOptions = {}): Promise<RenderToStringResult> =>
  renderToStringWithHeadStyles(jsx, { ...options, stylePlacement: 'head' });
export const renderToStream = (jsx: Input, options: RenderToStreamOptions): Promise<RenderToStreamResult> =>
  renderToStreamWithHeadStyles(jsx, { ...options, stylePlacement: 'head' });
