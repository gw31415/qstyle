// Run against the prepared candidate, with and without --conditions=development.
import assert from 'node:assert/strict';
globalThis.__EXPERIMENTAL__ = { suspense: true, errorBoundary: false };
const { jsx, Fragment } = await import('@qwik.dev/core');
const { renderToStream } = await import('@qwik.dev/core/server');

const manifest = { manifestHash: 'head-contract', mapping: {}, symbols: {}, bundles: {}, injections: [] };
// The normal optimizer injects these globals; this source-level boundary probe
// supplies the empty manifest explicitly and does not exercise QRL delivery.
globalThis.__QWIK_MANIFEST__ = manifest;
const render = (heads, stream) => renderToStream(jsx(Fragment, { children: [
  ...Array.from({ length: heads }, () => jsx('head', { children: jsx('title', { children: 'contract' }) })),
  jsx('body', { children: 'contract' }),
] }), { manifest, stream, preloader: false, stylePlacement: 'head' });
let writes = 0;
for (const count of [0, 2]) {
  await assert.rejects(render(count, { write() { writes++; } }), /exactly one head element/);
}
assert.equal(writes, 0);
const chunks = [];
await render(1, { write(chunk) { chunks.push(chunk); } });
assert.equal(chunks.length, 1);
assert.match(chunks[0], /<head[^>]*><title[^>]*>contract<\/title><\/head>/);
console.log(JSON.stringify({ pass: true, checks: ['missing and duplicate head rejected without output', 'one empty-style head accepted'] }));
process.exit(0);
