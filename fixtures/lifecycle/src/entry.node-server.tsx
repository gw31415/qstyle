// 本番 SSR server (plan.md B-1 C0 Playwright 基盤用)。
//
// `adapters/node-server/vite.config.ts` の build input。manifest / city plan は
// build 時に server bundle へ解決されるため `createQwikRouter({ render })` だけで
// 足りる (haven-web の entry.cloudflare-pages.tsx と同じ形)。
// node:http 直書き (express 依存を増やさない)。
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createQwikRouter } from '@qwik.dev/router/middleware/node';
import render from './entry.ssr';

const here: string = dirname(fileURLToPath(import.meta.url));
const distDir: string = resolve(here, '..', 'dist');

const { router, staticFile } = createQwikRouter({
  render,
  static: {
    root: distDir,
    // 本番 hosting と同じく static asset は immutable にする (C0.3 の reload
    // cache-hit 検証用。qstyle.routes.json 等の非 hash file も含まれるが、
    // fixture では build 毎に browser context を作り直すため無害)。
    cacheControl: 'public, max-age=31536000, immutable',
  },
});

const port: number = Number(process.env.PORT ?? 4173);
createServer((req, res): void => {
  void staticFile(req, res, (): void => {
    void router(req, res, (): void => {
      res.statusCode = 404;
      res.end('not found');
    });
  });
}).listen(port, (): void => {
  // e2e が stdout を見て起動を検知する (C0 基盤)。
  console.log(`[lifecycle-ssr] listening on http://127.0.0.1:${String(port)}`);
});
