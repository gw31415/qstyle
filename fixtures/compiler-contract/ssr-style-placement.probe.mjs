import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultTreeAdapter, parse as parseHtml, serializeOuter } from 'parse5';

// The fixture's Qwik build injects this manifest into core at bundle time. The
// source probe supplies the same value so it can exercise the public wrappers.
globalThis.__EXPERIMENTAL__ = { suspense: true, errorBoundary: false };
globalThis.__QWIK_MANIFEST__ = JSON.parse(
  await readFile(new URL('./dist/q-manifest.json', import.meta.url), 'utf8'),
);

const { Fragment, component$, h, useServerData } = await import('@qwik.dev/core');
const {
  COLLECTED_STYLES_KEY,
  injectCollectedStyles,
  renderToStreamWithHeadStyles,
  renderToStringWithHeadStyles,
} = await import('../../packages/qwik/src/ssr-style-placement.ts');

const adversarialBody = '<!-- <style q:style="comment-style">comment</style> -->'
  + '<script type="qwik/state">{"q:style":"script-style","q:container":"payload"}</script>'
  + '<script>const fake = "<style q:style=\\"script-style-2\\">fake</style>";</script>'
  + '<textarea><style q:style="textarea-style">textarea</style></textarea>'
  + '<template data-note="template > boundary"><style q:style="template-style">template</style></template>'
  + '<svg><style q:style="svg-style">svg</style></svg>'
  + '<div q:id="retained" q:p="2" q-e:click="q-chunk.js#handler" :>retained</div>';

const documentWith = (body) => h(
  Fragment,
  null,
  h('head', { 'data-note': 'head > boundary' }, h('title', null, 'compiler contract')),
  h('body', { 'data-note': 'body > boundary' }, body),
);

const Collector = component$(() => {
  const styles = useServerData(COLLECTED_STYLES_KEY);
  assert.ok(styles instanceof Map, 'head wrapper must provide a request-local collector');
  styles.set('generated-a', { text: '.generated-a{color:red}' });
  styles.set('generated-b', { text: '.generated-b{color:blue}' });
  return h('div', { dangerouslySetInnerHTML: adversarialBody });
});

const staleCollector = new Map([['stale', { text: '.stale{color:black}' }]]);
const rendered = await renderToStringWithHeadStyles(
  documentWith(h(Collector, null)),
  { stylePlacement: 'head', serverData: { [COLLECTED_STYLES_KEY]: staleCollector } },
);
const renderedHead = rendered.html.indexOf('</head>');
const renderedBody = rendered.html.indexOf('<body');
assert.ok(renderedHead > 0 && renderedBody > renderedHead);
assert.ok(rendered.html.indexOf('<style q:style="generated-a">') < renderedHead);
assert.ok(rendered.html.indexOf('<style q:style="generated-b">') < renderedHead);
assert.equal(rendered.html.slice(renderedBody).includes('.generated-a{color:red}'), false);
assert.equal(rendered.html.includes('.stale{color:black}'), false);
assert.equal(staleCollector.size, 1, 'caller collector must not be mutated or reused');
for (const marker of ['comment-style', 'script-style', 'script-style-2', 'textarea-style', 'template-style', 'svg-style', 'q:id="retained"']) {
  assert.ok(rendered.html.includes(marker), `adversarial body marker retained: ${marker}`);
}

const staticDocument = '<!doctype html><html><head data-note="head > boundary"><title><style q:style="title-style">title</style></title></head>'
  + '<body data-note="body > boundary">'
  + '<!-- <style q:style="comment-style">comment</style> -->'
  + '<script>const fake = "<style q:style=\\"script-style\\">fake</style>";</script>'
  + '<textarea><style q:style="textarea-style">textarea</style></textarea>'
  + '<template><style q:style="template-style">template</style></template>'
  + '<div q:id="retained" :>retained</div></body></html>';
const staticCss = new Map([['static-id', { text: '.static{color:green}' }]]);
const staticBoundary = staticDocument.indexOf('</head>');
const staticExpected = staticDocument.slice(0, staticBoundary)
  + '<style q:style="static-id">.static{color:green}</style>'
  + staticDocument.slice(staticBoundary);
assert.equal(injectCollectedStyles(staticDocument, staticCss), staticExpected, 'injection preserves body bytes');

function nativeBodyProjection(html) {
  const errors = [];
  const document = parseHtml(html, { onParseError: (error) => errors.push(error.code) });
  const htmlElement = document.childNodes.find((node) => defaultTreeAdapter.isElementNode(node) && node.tagName === 'html');
  const bodyElement = htmlElement?.childNodes.find((node) => defaultTreeAdapter.isElementNode(node) && node.tagName === 'body');
  return {
    errors,
    body: bodyElement ? serializeOuter(bodyElement) : null,
  };
}

function assertOpaqueBodySuffix(document, styles, label) {
  const boundary = document.indexOf('</head>');
  const injected = injectCollectedStyles(document, styles);
  assert.ok(boundary >= 0, `${label}: source has a head boundary`);
  assert.equal(injected.slice(injected.indexOf('</head>')), document.slice(boundary), `${label}: suffix bytes retained`);
  assert.deepEqual(nativeBodyProjection(injected), nativeBodyProjection(document), `${label}: native body parse retained`);
}

const duplicateHeadAfterBody = '<!doctype html><html><head></head><body><p data-before="1">before</p>'
  + '<head><title>late head</title></head><p data-after="2">after</p></body></html>';
assertOpaqueBodySuffix(duplicateHeadAfterBody, new Map([['late-head-check', { text: '.late-head-check{color:purple}' }]]), 'duplicate head after body');

const missingBodyEnd = '<!doctype html><html><head></head><body><div data-open="true">unterminated body suffix';
assertOpaqueBodySuffix(missingBodyEnd, new Map([['missing-body-end-check', { text: '.missing-body-end-check{color:orange}' }]]), 'missing body end');

const validNoscriptDocument = '<!doctype html><html><head><noscript><meta name="description" content="fallback">'
  + '</noscript><title>noscript boundary</title></head><body><p>body</p></body></html>';
const validNoscriptBoundary = validNoscriptDocument.indexOf('</head>');
const validNoscriptExpected = validNoscriptDocument.slice(0, validNoscriptBoundary)
  + '<style q:style="noscript-check">.noscript-check{color:teal}</style>'
  + validNoscriptDocument.slice(validNoscriptBoundary);
assert.equal(
  injectCollectedStyles(validNoscriptDocument, new Map([['noscript-check', { text: '.noscript-check{color:teal}' }]])),
  validNoscriptExpected,
  'valid noscript head is accepted with scripting enabled and disabled',
);

const adversarialNoscriptDocument = '<!doctype html><html><head><noscript><div data-noscript="body-content">'
  + 'body-like fallback</div></noscript></head><body><p>body</p></body></html>';
assert.throws(
  () => injectCollectedStyles(adversarialNoscriptDocument, new Map([['noscript-adversarial', { text: '.noscript-adversarial{}' }]])),
  /valid HTML document before the body|consistent head\/body boundary|exactly one body element/,
  'body-content noscript is rejected when parser modes diverge',
);
assert.throws(
  () => injectCollectedStyles(staticDocument, new Map([['unsafe', { text: 'a</style>b' }]])),
  /literal <\/style sequence/,
);
assert.throws(
  () => injectCollectedStyles('<html><body></body></html>', new Map()),
  /exactly one head element|valid HTML document before the body/,
);
assert.throws(
  () => injectCollectedStyles('<html><head></head><head></head><body></body></html>', new Map()),
  /exactly one head element|valid HTML document before the body/,
);
assert.throws(
  () => injectCollectedStyles(staticDocument, new Map([['pending', {}]])),
  /resolve before flush/,
);

const ConcurrentCollector = component$((props) => {
  const styles = useServerData(COLLECTED_STYLES_KEY);
  const id = props.id;
  assert.ok(styles instanceof Map);
  styles.set(`concurrent-${id}`, { text: `.concurrent-${id}{color:red}` });
  return h('p', { id: `concurrent-${id}` }, id);
});
const [concurrentA, concurrentB] = await Promise.all([
  renderToStringWithHeadStyles(documentWith(h(ConcurrentCollector, { id: 'a' })), { stylePlacement: 'head' }),
  renderToStringWithHeadStyles(documentWith(h(ConcurrentCollector, { id: 'b' })), { stylePlacement: 'head' }),
]);
assert.match(concurrentA.html, /\.concurrent-a\{color:red\}\<\/style>/);
assert.doesNotMatch(concurrentA.html, /\.concurrent-b\{color:red\}\<\/style>/);
assert.match(concurrentB.html, /\.concurrent-b\{color:red\}\<\/style>/);
assert.doesNotMatch(concurrentB.html, /\.concurrent-a\{color:red\}\<\/style>/);

const streamChunks = [];
const streamEvents = [];
const streamResult = await renderToStreamWithHeadStyles(
  documentWith(h(Collector, null)),
  {
    stylePlacement: 'head',
    streaming: { inOrder: { strategy: 'direct' } },
    onBeforeFirstFlush() { streamEvents.push('before'); },
    stream: {
      async write(chunk) {
        streamEvents.push('write');
        streamChunks.push(chunk);
        await Promise.resolve();
        streamEvents.push('settled');
      },
    },
  },
);
assert.deepEqual(streamEvents, ['before', 'write', 'settled']);
assert.equal(streamResult.flushes, 1);
assert.match(streamChunks.join(''), /<style q:style="generated-a">/);

let invalidWrites = 0;
for (const invalid of [{ containerTagName: 'div' }, { streaming: { outOfOrder: true } }]) {
  await assert.rejects(
    renderToStreamWithHeadStyles(documentWith(h(Collector, null)), {
      stylePlacement: 'head',
      stream: { write() { invalidWrites++; } },
      ...invalid,
    }),
    /full HTML document without out-of-order streaming/,
  );
}
assert.equal(invalidWrites, 0);
await assert.rejects(
  renderToStreamWithHeadStyles(documentWith(h(Collector, null)), {
    stylePlacement: 'head',
    stream: { write() { return Promise.reject(new Error('sink failed')); } },
  }),
  /sink failed/,
);

console.log(JSON.stringify({
  pass: true,
  checks: [
    'public SSR wrapper collects and injects styles',
    'request-local collector isolation',
    'parse5 head boundary with adversarial body text',
    'malformed body suffix bytes and native parse parity',
    'scripting-enabled and disabled noscript boundary parity',
    'literal closing style sequence rejected',
    'unresolved collector rejected before flush',
    'one buffered stream write',
    'unsupported modes rejected before writing',
    'sink rejection propagated',
    'concurrent request collector isolation',
  ],
}));
process.exit(0);
