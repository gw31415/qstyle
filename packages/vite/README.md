# @qstyle/vite

Vite plugin for compiling Qwik styles into optimized CSS assets with route
aware delivery and development HMR support.

See the [qstyle repository](https://github.com/gw31415/qstyle) for setup and
configuration.

## CSS compression in `qstyle()`

Production builds jointly search declaration sharing and legal declaration/rule
orders within each generated CSS pack. Byte savings generate sharing proposals,
including partial groups and intermediate checkpoints; an initially worse merge
can still win after reordering. Similar rule bodies and property sequences are
placed near each other where cascade dependencies permit it.

Candidates are compared using raw bytes, gzip level 6, and Brotli quality 11 in
generic mode. A candidate is eligible only when none of those three sizes exceeds
the original. The smallest sum of gzip and Brotli bytes wins, with raw bytes
breaking ties. If nothing improves, the original source is preserved. No server
compression settings are changed and no `.gz`/`.br` assets are emitted.

For Vite's default Lightning CSS minifier, candidate measurements include the
configured minification step: declaration orders that it canonicalizes back to
the same output receive the same score. With CSS minification disabled, candidates
are measured directly. The esbuild minifier, Lightning CSS transformer mode, unsupported target
notations (including ES-year targets) and unavailable minifier modules retain the
original source conservatively.

Optimization runs before Vite processes and hashes CSS, so normal imports and
`?inline` imports share one cached result. Final assets are never rewritten in
`generateBundle`. Development/HMR and `qstyleNative()` are unchanged. Grouping
and ordering never cross pack boundaries or separate occurrences of at-rule blocks.

Declaration reordering uses a closed list of understood properties and reset
families. Unknown properties, fallbacks, opaque syntax and conditional units are
barriers; equal-specificity rules that may overlap keep their relative order.
The generated-class coexistence contract and compiler metadata are required.

Search is deterministic and bounded, **not a proof of globally minimal CSS**.
The joint search measures at most 512 distinct outputs / 8 MB of candidate bytes,
tries 128 property-priority swaps and two rounds of partial merging. Ordering
also caps rules, declarations and segments; inputs over 1 MB skip optimization.
The underlying sharing search has separate candidate and cascade-scan budgets.

Measurements apply to individual packs. Combining multiple packs, later custom
plugins, inline HTML context and different server compressor settings can change
final transfer sizes. Browser semantics constrain legal changes; compressor
measurements select among them. See [research and rationale](../../docs/css-compression.md).

To compare a saved generated CSS file from the repository checkout (without a
subsequent minifier):

```sh
node scripts/measure-css-dedup.mjs path/to/generated.css
```

The report includes original sizes, the raw greedy candidate, selected result,
strategy and evaluated candidate count. Without compiler metadata it cannot infer
conditional classes or tag relationships, so it is a size diagnostic rather than
a replacement for the compiler's delivery pipeline.
