#!/usr/bin/env node
import { createServer } from 'node:http';
import { createReadStream, stat } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)), 'dist-ssg');
const contentTypes = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
};

function fileForPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === '/' ? 'index.html'
    : decoded.endsWith('/') ? `${decoded.slice(1)}index.html`
      : `${decoded.slice(1)}`;
  const direct = resolve(root, relative);
  if (direct.startsWith(`${root}/`)) return direct;
  return null;
}

createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  const file = fileForPath(pathname);
  if (file === null) {
    response.writeHead(403).end();
    return;
  }
  serve(file, response);
}).listen(Number(process.env.PORT ?? 4184), '127.0.0.1', () => {
  console.log(`[named-routing-contract-ssg] serving ${root}`);
});

function serve(file, response) {
  stat(file, (error, info) => {
    if (error) {
      response.writeHead(404).end();
      return;
    }
    if (info.isDirectory()) {
      serve(resolve(file, 'index.html'), response);
      return;
    }
    if (!info.isFile()) {
      response.writeHead(404).end();
      return;
    }
    send(file, response);
  });
}

function send(file, response) {
  response.setHeader('content-type', contentTypes[extname(file)] ?? 'application/octet-stream');
  if (file.startsWith(`${root}/build/`)) {
    response.setHeader('cache-control', 'public,max-age=31536000,immutable');
  }
  createReadStream(file).pipe(response);
}
