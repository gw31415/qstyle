# Initial delivery: exact 145-byte attribution

Checkpoint: `f9f2f4f` (signed). Comparison: native qstyle versus legacy qstyle,
route A initial response, prefetch disabled. The unchanged source reproduced
**141565 − 141420 = 145 raw bytes**. All six comparison builds and their
computed-style/state checks passed; the initial-size gate still fails.

| Cause | Raw-byte delta |
|---|---:|
| Three generated DOM class names: 10 → 35 bytes each | +75 |
| Qwik serialized vnode data: 297 → 376 bytes | +79 |
| One remaining `style=""` attribute | +9 |
| Native style-tag markup: 127 → 139 bytes | +12 |
| Shorter DOM component marker | −7 |
| Inline CSS text: 434 → 403 bytes | −31 |
| Shared Qwik JavaScript export clause | +8 |
| **Total** | **+145** |

HTML contributes **137 bytes** (6129 versus 5992), JavaScript **8 bytes**
(135436 versus 135428). There are nine initial requests in each lane and no
external CSS request. Remaining markup, script wrappers and non-vnode script
payloads have zero raw-byte delta. The class-name row counts DOM tokens only;
class names inside CSS are already counted in the CSS row.

The class tokens change from `q_` plus eight hexadecimal digits to `q1_` plus
32 hexadecimal digits. Two shared-color uses and one route-box use add 75 bytes.
The extra StylePack component boundaries and the remaining Fragment for the
shared component increase Qwik's vnode serialization by 79 bytes. That component
has `data-testid={props.testId}`, which selects the general evaluated compiler
path and still emits an empty style object. The other two static elements use
the literal fast path. Their CSS still needs native StylePack owners.

Two generated native style tags (67 bytes of markup) replace the legacy CSS
asset's one tag (55 bytes). Authored native style tags contribute 72 bytes in
both lanes. The shared component's ` :="nf_0"` marker becomes ` :`, saving seven
bytes as the generated Fragment owns its component boundary. CSS text itself
shrinks: native initial generated CSS is 181 bytes versus 212 bytes for legacy;
authored CSS is 222 bytes in both. The legacy asset includes later route/lazy
rules, while native delivery excludes those declarations.

The JavaScript difference is entirely in the final export clause of
`q-CFULr5sM.js` versus `q-DKKacggv.js`. Their implementation prefix is byte-identical.
The export list grows from 58 entries / 522 bytes to 59 entries / 530 bytes;
the one new local symbol is `uo` (`useConstant`), exported as `P`. Its serialized
entry `,uo as P` is eight bytes. Other export aliases move but keep their lengths.
The runtime source imports `useConstant` for the dev-only SSR slot; the final
production runtime no longer imports it, but the shared chunk retains the export.
This eight-byte difference does not add a new function implementation to the
initially fetched core chunk.

The committed gzip/Brotli differences are +35 / −14 bytes. Those are whole-body
compression results and cannot be split additively into HTML attributes. Repeating
the raw measurement yields the same 145-byte delta; ports and generated instance
IDs change the precise compressed totals.

Reproduction: `QSTYLE_DELIVERY_KEEP=1 node scripts/measure-native-delivery.mjs`.
The diagnostic build is retained under `.qstyle/delivery-cost/run-37603`, and
same-port HTML captures under `.qstyle/145-byte-diagnosis`. Machine-readable
counts, prefix hashes and export sets are in
[initial-delivery-delta.json](2026-09-11-initial-delivery-delta.json).

No compiler/runtime fix or release-threshold change was made during this
investigation. The original delivery audit remains unchanged in the worktree.
