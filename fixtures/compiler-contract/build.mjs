import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { prepareQwik } from './prepare-qwik.mjs';

const root = dirname(fileURLToPath(import.meta.url));
process.env.NODE_ENV = 'production';
const mode = await prepareQwik(root);
await build({ root, mode: 'production', logLevel: 'warn' });
await build({ root, mode: 'production', logLevel: 'warn', build: {
  ssr: resolve(root, 'src/entry.ssr.tsx'), outDir: 'server', emptyOutDir: true,
  rolldownOptions: { output: { entryFileNames: 'render.mjs' } },
} });
const manifest = JSON.parse(readFileSync(resolve(root, 'dist/q-manifest.json'), 'utf8'));
const { default: render } = await import(pathToFileURL(resolve(root, 'server/render.mjs')).href);
const result = await render({ manifest, url: 'http://127.0.0.1:4182/' });
writeFileSync(resolve(root, 'dist/index.html'), result.html);
console.log(JSON.stringify({ mode, htmlBytes: Buffer.byteLength(result.html),
  sharedPresent: result.html.includes('12, 34, 56'), lazyPresent: result.html.includes('230, 240, 255') }));
// The one-shot fixture has awaited every build/write; end Qwik's renderer workers.
process.exit(0);
