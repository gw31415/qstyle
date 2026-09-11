# Active Plan: Qstyle 1.0 native style compiler

Specification: [native-style-compiler-spec.md](docs/native-style-compiler-spec.md).
Architecture: [architecture-performance-plan.md](docs/architecture-performance-plan.md).
Implementation history and completed verification are archived in the native
compiler checkpoint commit. This plan contains unfinished acceptance work.

## Immediate investigation

- Initial +145 raw-byte attribution is recorded in
  [the delta audit](docs/audits/2026-09-11-initial-delivery-delta.json).
  Select a separately verified optimization; no fix was made during diagnosis.
- Persist emitted module provenance to establish the additional-runtime gate;
  marker-body substring counts are insufficient evidence.
- Keep existing release thresholds while diagnosing; initial transfer remains
  above legacy, so the public default must not switch yet.

## Remaining acceptance and implementation

- Measure the large consumer and second consumer (VitePlus), cold/warm transfer,
  initial/lazy timing and HMR median/p95 under the specified repeatable conditions.
- Resolve the runtime-zero contract against the named-import implementation and
  supported Qwik behavior, without silently changing the requirement.
- Finish strict unmanaged-style build policy (QS1603), opaque authoring stubs,
  legacy default cutover/removal and public API/documentation migration only
  after the prerequisite gates pass.
- Complete official Uno generator differential coverage, production cascade and
  final-output acceptance, consumer migration and CI/release checks.
- Validate failed/delayed CSS delivery and query-bearing retry URLs on the target
  hosting environment; a failed request can leave an unstyled node until recovery.
- Address or explicitly settle full-response head buffering, first-write delay,
  memory use and unsupported container/streaming modes before release.

## Constraints and reproduction

Use named import rewriting first. Do not alias the entire Qwik core or adopt
historical differential patches as the production dependency. Only a demonstrated
CSS chunk dependency limitation permits considering a minimal generic Qwik hook.
Preserve SSR, resumability, authored scoped styles, navigation, deduplication and
HMR while investigating. Never hand-patch shared node_modules.

Use Node >=24.11 (current verification runtime 26.8.2) and the pinned lockfile.
`pnpm test:native` runs package acceptance, `pnpm test:package-consumer` checks
external tarballs, and `pnpm report:delivery` replays the delivery comparison.
Set `QSTYLE_DELIVERY_KEEP=1` to retain diagnostic builds. These measurement
commands intentionally fail when a release gate is unmet. No release or
publication is authorized by this checkpoint.
