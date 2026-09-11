# Temporary Git consumer branch

This branch packages commit `9cfed27039fa665573f5a517ba6260bdcda293cd`
for consumers that cannot install an unpublished qstyle release.

It differs from `main` only in distribution concerns:

- built `dist` files are tracked for each public package;
- internal `workspace:^` dependencies point back to package subdirectories on
  this branch.

Consumers should use pnpm's Git package selector, for example:

```json
"@qstyle/qwik": "github:gw31415/qstyle#path:packages/qwik&git-consumer"
```

The consumer lockfile resolves the branch to an exact Git commit. This branch
is temporary and is not an npm release.
