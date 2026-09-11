import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(dist, `.${pathname}${pathname.endsWith('/') ? 'index.html' : ''}`);
    if (!file.startsWith(dist)) { response.writeHead(403).end(); return; }
    const data = await readFile(file);
    response.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    if (pathname.startsWith('/build/')) response.setHeader('cache-control', 'public,max-age=31536000,immutable');
    response.end(data);
  } catch { response.writeHead(404).end(); }
}).listen(Number(process.env.PORT ?? 4181), '127.0.0.1');
