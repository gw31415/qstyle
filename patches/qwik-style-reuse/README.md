# Isolated Qwik dependency candidates

`apply.mjs` copies the exact, SHA-256-checked Qwik 2.0.0-beta.43 package into a
disposable output directory. It does not modify installed product dependencies.
These candidates are evidence for an upstream dependency requirement, not a
supported qstyle runtime or production dependency selection.

The client candidate checks existing native style IDs before resolving a style
QRL and shares concurrent resolutions. The server candidate adds an experimental
`stylePlacement: 'head'` render option. Without that option server behavior is
unchanged.

Head placement buffers the complete HTML document before the first network
write. It collects only styles requested during rendering, preserves native and
authored styles already rendered in the head, and inserts body-requested styles
immediately before the actual head closing boundary. The inserted native styles
have no Qwik `:` JSX marker, so they do not shift resumable element indices.
There is no CSS-text rewrite, client hoisting script, or eager enumeration of
unrendered component styles.

This option rejects non-HTML containers and out-of-order streaming before writing.
It requires exactly one rendered head. It sacrifices progressive SSR output and
retains the complete response in memory; production adoption still requires a
supported Qwik API/dependency decision and measured latency/memory acceptance.

Reproduce the integrated production proof from the repository root:

```sh
COMPILER_CONTRACT_QWIK=candidate QSTYLE_CONTRACT_WIND4=1 QSTYLE_CONTRACT_HEAD=1 node fixtures/compiler-contract/build.mjs
QSTYLE_CONTRACT_WIND4=1 QSTYLE_CONTRACT_HEAD=1 node fixtures/compiler-contract/probe.mjs
node fixtures/compiler-contract/head-stream-probe.mjs
node fixtures/compiler-contract/head-boundary-probe.mjs
node --conditions=development fixtures/compiler-contract/head-boundary-probe.mjs
node fixtures/native-contract/scripts/head-performance.mjs
```

The browser probe covers JavaScript-disabled structural selectors and authored
head-style order, resume updates, lazy delivery, unique native style IDs and
inline CSS reuse. The stream probe checks the final head placement, single
deferred flush, awaited asynchronous writes, rejected unsupported modes, and
propagated writer failures. This is not full SSR/SSG/router/consumer acceptance.
The source-level boundary probe supplies Qwik's build globals explicitly and
checks missing/duplicate/empty heads in both server variants with experimental
Suspense enabled. Head mode disables the implicit OOOS default; an explicit
OOOS request remains an error.

The performance probe compares the same candidate with direct writes and head
buffering, with a 25 ms delayed child and 256 KiB / 4 MiB text payloads. It runs
2 warmups and 10 samples per mode in separate processes, checks equivalent HTML
after normalizing Qwik's random instance ID, and records median/p95 first-write
and total time. The 2026-09-11 observation found first-write medians of
0.060/0.084 ms for direct output versus 26.996/27.672 ms for head buffering.
These are renderer writes, not network TTFB. The probe does not benchmark a
production app or peak memory; retained output chunks affect memory observations.
See `docs/audits/2026-09-11-head-performance.json` for samples and limitations.
