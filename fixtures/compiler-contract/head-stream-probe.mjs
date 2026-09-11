import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderStream } from './server/render.mjs';

const manifest = JSON.parse(await readFile(new URL('./dist/q-manifest.json', import.meta.url), 'utf8'));
const base = { manifest, stylePlacement: 'head' };
const events = [];
const chunks = [];
const result = await renderStream({
  ...base,
  // The native head mode must buffer even if the caller requested direct writes.
  streaming: { inOrder: { strategy: 'direct' } },
  onBeforeFirstFlush() { events.push('before'); },
  stream: { async write(chunk) {
    events.push('write');
    chunks.push(chunk);
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push('settled');
  } },
});
assert.deepEqual(events, ['before', 'write', 'settled']);
assert.equal(result.flushes, 1);
const html = chunks.join('');
const boundary = html.indexOf('</head>');
assert.ok(boundary > 0);
assert.match(html.slice(0, boundary), /<style q:style=/);
assert.doesNotMatch(html.slice(boundary), /<style q:style=/);
assert.doesNotMatch(html, /230, 240, 255/);
assert.ok(result.timing.firstFlush >= result.timing.render);
let invalidWrites = 0;
const invalidStream = { write() { invalidWrites++; } };
for (const invalid of [{ containerTagName: 'div' }, { streaming: { outOfOrder: true } }]) {
  await assert.rejects(renderStream({ ...base, ...invalid, stream: invalidStream }), /full HTML document without out-of-order streaming/);
}
assert.equal(invalidWrites, 0);
await assert.rejects(renderStream({ ...base, stream: { write() { return Promise.reject(new Error('sink failed')); } } }), /sink failed/);
console.log(JSON.stringify({ pass: true, checks: ['head-only rendered styles', 'one deferred flush', 'async sink awaited', 'unsupported modes rejected before writing', 'sink rejection propagated'], htmlBytes: Buffer.byteLength(html), timing: result.timing }));
process.exit(0);
