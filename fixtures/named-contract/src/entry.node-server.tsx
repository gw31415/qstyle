import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQwikRouter } from '@qwik.dev/router/middleware/node';
import render from './entry.ssr';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', 'dist');
const { router, staticFile } = createQwikRouter({
  render,
  static: { root: distDir },
});

const port = Number(process.env.PORT ?? 4183);
createServer((request, response) => {
  void staticFile(request, response, () => {
    void router(request, response, () => {
      response.statusCode = 404;
      response.end('not found');
    });
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`[named-routing-contract] listening on http://127.0.0.1:${String(port)}`);
});
