# Active Plan: Qstyle release blockers 1–3

Status: implementation complete; awaiting review/commit.

## User value

Make the first public release fail closed instead of silently emitting incorrect or unsafe CSS:

1. Different inputs must never silently share a generated CSS identity.
2. Custom property names must not be able to escape a CSS declaration or rule.
3. A Qwik style that cannot be compiled must not result in a successful build with the style silently missing.

## Scope

In scope:

- collision detection for every generated identity that can affect CSS, assets, manifests, keyframes, or runtime slot variables;
- one conservative custom-property validator shared by every input path;
- explicit classification and fail-closed handling for transform occurrences that remain untouched;
- focused unit, integration, and fixture tests plus documentation of the release behavior.

Out of scope for this slice:

- replacing the handwritten JSX scanner with a full AST parser;
- Qwik City route generalization;
- CI, package metadata, or license work;
- changing the hash format unless the compatibility decision in Milestone 4 is approved.

## Current state and constraints

- Repository: pnpm monorepo; current branch is `main` and the working tree is clean.
- Relevant code is in `packages/core`, `packages/qwik`, and `packages/vite`.
- `fnv1aHex` currently produces 8 hexadecimal characters. It is used for class names, asset names, manifests, keyframes, and slot variables.
- `DedupRegistry` and Vite collection currently treat an equal generated ID as equal content; a collision can therefore discard CSS silently.
- Custom property checks currently accept any non-whitespace suffix in several paths. Output serialization does not escape property names.
- Qwik has no runtime `css` prop implementation. An occurrence left as `css={{...}}` is therefore not a valid runtime fallback.
- Existing options include `diagnostics: 'silent' | 'warning' | 'error'` and `optimization: 'safe' | 'strict'`. Existing warning/error behavior and message assertions must be preserved or deliberately versioned.
- A hash-format change changes HTML class names, asset URLs, manifest keys, cache keys, snapshots, and compatibility with already-generated HTML. Collision detection must ship independently of any hash migration.

## Decisions

- **Collision policy:** identical logical input may deduplicate; different input producing the same generated identity is a build error before a publishable artifact is emitted. A warning is not sufficient.
- **Custom-property policy:** reject invalid names at the input boundary; do not trim, rewrite, or escape them into a different meaning. Initially use a conservative ASCII grammar, `^--[A-Za-z_][A-Za-z0-9_-]*$`, and document the deliberate rejection of escapes and non-ASCII names.
- **Untouched policy:** only a proven no-op or proven static fallback may succeed. If the `css` prop remains and no runtime implementation can apply it, the release build must fail. A legacy warning mode may remain explicit and opt-in during migration, but must not be the first-release default.
- **Hash migration:** retain the existing 8-character format while adding fail-closed collision detection. Consider a versioned 64/128-bit hash in a separate opt-in/major milestone; do not mix that compatibility break into the safety patch.

## Milestones

### 1. Centralize the safety contracts

**Goal:** introduce shared primitives and stable diagnostic reasons without changing generated output for valid inputs.

**Edits:**

- Add a collision registry/identity comparison abstraction in `packages/core` that stores the logical input or canonical content alongside each generated identity.
- Define stable diagnostic codes/reasons for hash collision, invalid custom property, and unsupported runtime style, reusing the repository's existing diagnostic transport where possible.
- Add a single custom-property validator in `packages/core/src/safety.ts`; route object syntax, tagged templates, `@property`, and any generated slot-property checks through it.
- Keep existing valid names such as `--brand-color`, `--my-Var`, and `--a-b_c` valid. Decide and test whether the internal `--qstyle-` namespace is reserved; if reserved, reject it consistently rather than relying on convention.

**Result:** all later changes use one collision contract and one property-name contract.

**Proof:** core tests cover duplicate-vs-collision identity behavior and a table of accepted/rejected property names.

### 2. Harden custom property handling (release blocker 2)

**Goal:** malformed property names cannot enter serialized CSS.

**Edits:**

- Update `packages/core/src/safety.ts` and the callers in `packages/qwik/src/template.ts`, `packages/qwik/src/object.ts`, and `packages/core/src/keyframes.ts` to use the shared validator.
- Ensure invalid names become the existing unsupported/residual diagnostic and are never serialized by `serializeStaticDecl` or `serializeParametricDecl`.
- Add tests in `packages/core/src/safety.test.ts`, `packages/qwik/src/object.test.ts`, and the template tests for `--a;b`, `--a{}`, `--a}`, `--a<b`, quotes, whitespace, control characters, empty names, and reserved generated prefixes.
- Add an output-shape/property-based assertion that every emitted custom property matches the accepted grammar.

**Acceptance:** invalid names fail or become an explicit residual according to the selected release policy; no generated CSS contains a malformed property name; all existing valid-name tests remain green.

**Proof command:**

```sh
pnpm --filter @qstyle/core test
pnpm --filter @qstyle/qwik test
```

### 3. Add fail-closed collision detection (release blocker 1)

**Goal:** no different CSS input can be silently deduplicated, overwritten, or emitted under the same public identity.

**Edits:**

- Integrate the registry at the `DedupRegistry` boundary in `packages/core/src/dedup.ts`.
- Add equivalent checks at Vite unit collection, CSS asset planning, and Qwik-native pack registration in `packages/vite/src/index.ts`.
- Compare canonical CSS/logical input, not only the generated hash. Permit repeated identical input; throw a deterministic diagnostic for different input with the generated ID, namespace, and both source locations.
- Check before emission and ensure a failed build does not leave a publishable partial manifest or CSS asset.
- Cover class/unit IDs, asset filenames, manifest entries, keyframe/global IDs, and generated slot-variable namespaces. Do not use warning-only behavior for a collision.

**Tests:**

- Inject a deterministic test hasher or use a verified known collision pair; do not make the test depend only on probabilistic discovery.
- Test duplicate identical input succeeds.
- Test different input with the same ID fails in `DedupRegistry`, Vite unit collection, and asset planning.
- Test diagnostics include namespace and source information and are emitted once per collision.
- Test deterministic behavior across input order, incremental builds, and parallel/chunked collection.

**Acceptance:** a collision cannot produce a successful build or a silently truncated CSS/manifest; existing deterministic hash tests remain green.

**Proof command:**

```sh
pnpm --filter @qstyle/core test
pnpm --filter @qstyle/vite test
```

### 4. Make unsupported Qwik styles fail closed (release blocker 3)

**Goal:** distinguish “nothing needed” from “the compiler could not apply the style,” and prevent the latter from succeeding silently.

**Edits:**

- Audit every `noteSkipped`/residual reason in `packages/vite/src/index.ts` and classify it as `Applied`, `NotNeeded`, `StaticFallback`, or `UnsupportedRuntimeStyle`.
- Treat parse failures, unsupported syntax/residuals, unresolved handles, uneditable tags, and other cases that leave a `css` prop in the output as `UnsupportedRuntimeStyle`.
- Make the first-release/production profile error on `UnsupportedRuntimeStyle` before emitting publishable output. Keep an explicit legacy warning mode only for migration and document that it can lose styles.
- Preserve a real no-op/static fallback only when a test proves the resulting DOM/runtime behavior is equivalent.
- Update `docs/css.md`, `docs/options.md`, and development guidance to state that `untouched` is not a runtime fallback and to show the strict CI configuration.
- Keep existing diagnostic message assertions stable where possible; update them only with a deliberate code/reason change.

**Tests:**

- Supported static, dynamic, and genuinely no-op cases still build.
- Spread, call expressions, nested dynamic values, unresolved cross-module handles, unsupported selectors/at-rules, uneditable tags, and dynamic local keyframes fail in release mode.
- Explicit legacy warning mode is tested separately and clearly marked non-release.
- Failed transforms do not emit a usable manifest/asset set.
- SSR, client manifest lookup, and HMR fallback behavior are tested independently; HMR may recover to the ordinary Qwik path without turning a production build into success.

**Acceptance:** no release build can contain a remaining `css` prop whose style has no runtime applier.

**Proof command:**

```sh
pnpm --filter @qstyle/vite test
pnpm --filter @qstyle/qwik test
pnpm typecheck
```

### 5. Full release verification

**Goal:** prove the three fixes together without regressions.

**Checks:**

```sh
pnpm test
pnpm typecheck
pnpm -r build
```

Run the lifecycle/Playwright suites using the existing documented build-first procedure. Inspect generated CSS, manifests, and package artifacts for the collision and untouched-style cases.

**Acceptance:** all checks pass; no malformed custom property is serialized; collision fixtures fail closed; unsupported runtime styles fail in release mode; valid legacy output remains stable unless the hash-v2 milestone is explicitly enabled.

## Optional follow-up: versioned hash v2

After the fail-closed patch is released or deliberately scheduled as a major change:

- introduce a versioned 64/128-bit digest and record the algorithm/format in the manifest;
- keep collision detection enabled for v2;
- provide explicit v1/v2 artifact and manifest handling rather than mixing formats;
- update cache/HTML migration documentation and all hash-shaped snapshots.

This is not a substitute for collision detection and must not be enabled without a compatibility plan.

## Rollback and retry

- Keep Milestones 2–4 in separate commits or independently revertible changes; do not reset or discard unrelated work.
- If valid custom-property fixtures fail, narrow the validator only with a documented grammar decision; never restore arbitrary-name serialization.
- If collision detection reports a real collision in a fixture, preserve the fixture and fix the identity design rather than downgrading the diagnostic.
- If strict mode exposes existing unsupported styles, either implement that case or explicitly classify it as a documented non-release migration case; do not ship it as a silent warning.
- Do not enable hash v2 in the same change as the fail-closed safety fixes.

## Current progress

- [x] Central safety contracts
- [x] Custom property hardening
- [x] Collision detection
- [x] Fail-closed unsupported-style handling
- [x] Full release verification

## Verification evidence

All commands below completed successfully after the implementation:

- `pnpm test` — all workspace tests passed, including core 149 tests, Qwik 157
  tests, Vite 249 tests, and the root size-report checks.
- `pnpm typecheck` — all five packages passed.
- `pnpm build` — all packages built and publint reported no issues.
- `git diff --check` — no whitespace errors.

The build still prints pre-existing non-blocking warnings for CommonJS `import.meta`
replacement and mixed exports. Hash-v2 migration remains intentionally deferred because
it changes class names, asset URLs, and manifest compatibility.
