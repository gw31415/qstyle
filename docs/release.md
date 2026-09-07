# リリース手順

パッケージは `@qstyle/*` の lockstep version で公開する。workspace 依存の
`workspace:^` を公開用バージョンへ置換する必要があるため、公開には npm ではなく
pnpm を使う。

## 事前条件

- npm アカウントが `@qstyle` scope を所有している。
- `pnpm whoami` が公開権限を持つアカウントを返す。
- GitHub のリリース対象コミットが `main` に push 済みである。

## 検証

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm -r pack --dry-run
```

各パッケージの dry-run tarball に `dist`、`package.json`、`README.md`、
`LICENSE` が含まれることを確認する。

## 公開

```sh
pnpm -r publish --access public
```

公開後に以下を確認する。

```sh
npm view @qstyle/core@0.1.0 version license
npm view @qstyle/qwik@0.1.0 version license
npm view @qstyle/vite@0.1.0 version license
npm view @qstyle/unocss@0.1.0 version license
npm view @qstyle/inspector@0.1.0 version license
```

その後、公開コミットに `v0.1.0` タグを付けて push する。
