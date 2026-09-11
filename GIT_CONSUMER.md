# Temporary Git consumer branch

The `main` branch packages commit `9cfed27039fa665573f5a517ba6260bdcda293cd`
for consumers that cannot install an unpublished qstyle release.

It differs from `main` only in distribution concerns:

- built `dist` files are tracked for each public package;
- internal dependencies use their package versions so a consumer can override
  the complete `@qstyle/*` family to Git subdirectories on `main`.

Consumers should use pnpm's Git package selector, for example:

```json
"@qstyle/qwik": "github:gw31415/qstyle#path:packages/qwik&main"
```

The consumer lockfile resolves `main` to an exact Git commit. Consumers must
apply equivalent pnpm overrides for transitive `@qstyle/*` packages. This is
temporary and is not an npm release.
