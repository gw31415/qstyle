#!/usr/bin/env node
// lifecycle fixture の build script。
//
// 1. fixture は workspace package ではないため `@qwik.dev/core` / `@qwik.dev/router`
//    が node resolution で解決できない。packages/qwik の devDependencies に解決済み
//    実体があるので、fixture 内 node_modules に symlink を張る (gitignore 済み。
//    pnpm install は不要・lockfile も不変)。
// 2. `vite build` (JS API) を production mode で実行する。qwik city + ssgAdapter が
//    client / ssr / ssg の 3 environment を build し、dist/ に SSG HTML を吐く。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, '..');
const qwikDepsRoot = path.resolve(fixtureRoot, '../../packages/qwik/node_modules/@qwik.dev');

function ensureDependencyLink(name) {
  const target = path.join(qwikDepsRoot, name);
  if (!fs.existsSync(target)) {
    throw new Error(`missing @qwik.dev/${name} at ${target}; run pnpm install in the repo root`);
  }
  const linkDir = path.join(fixtureRoot, 'node_modules', '@qwik.dev');
  const linkPath = path.join(linkDir, name);
  if (fs.existsSync(linkPath)) {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink() && fs.realpathSync(linkPath) === fs.realpathSync(target)) return;
    throw new Error(`${linkPath} exists but is not the expected symlink to ${target}`);
  }
  fs.mkdirSync(linkDir, { recursive: true });
  fs.symlinkSync(target, linkPath, 'dir');
}

for (const name of ['core', 'router']) {
  ensureDependencyLink(name);
}

process.env.NODE_ENV = 'production';
// qwik city + ssgAdapter は Vite の app builder (buildApp) を必要とする
// (client / ssr / ssg の 3 environment を順に build し、最後に SSG を回す)。
// 素の `createBuilder().buildApp()` はこの構成では client の途中で止まる
// (SSR 成果物・manifest が出ない) ため、plain の `vite build` を使う
// (Qwik 側の警告文にもあるとおり builder が自動選択される)。
// NOTE: Qwik beta.43 の SSG は `<Link>` の click handler QRL を解決できず Q14 で
// 落ちる (qstyle とは無関係・素の fixture でも再現)。QSTYLE_SSG=0 では ssgAdapter
// を外し (vite.config.ts)、SSR server 用の build のみ行う。SSG bake (QWK-002) は
// framework 側の修正待ちとして plan.md B-1 に記録する。
const { build } = await import('vite');
await build({
  root: fixtureRoot,
  logLevel: 'warn',
  mode: 'production',
});
// SSR server bundle (server/)。base の client build の後に積む。
// adapter config は base を extend するため qstyle plugin も再走するが、
// 同一入力からは同一内容になる (HASH-002) ため成果物は安定。
// NOTE: `builder.build(ssrEnv)` の単環境 build は成果物を出さないため
// `buildApp()` で全体を build する (SSG render も走るが、`.qwik.mjs` 化で
// QRL が manifest 登録されるため Q14 にならない。C0 基盤整備で実証済み)。
// adapter config の outDir は server/ のため dist/ の client 成果物は壊れない
// (server/ 側に重複コピーが出るが fixture のため許容)。
const { createBuilder } = await import('vite');
const serverBuilder = await createBuilder({
  root: fixtureRoot,
  logLevel: 'warn',
  mode: 'production',
  configFile: path.resolve(fixtureRoot, 'adapters/node-server/vite.config.ts'),
});
await serverBuilder.buildApp();
// adapter build の ssr env では main plugin の generateBundle 成果物
// (qstyle.routes.json 等) が出ないため、base build の決定論的同一内容を配る。
// entry.ssr.tsx が server bundle 脇の manifest を読んで SSG/SSR の link 焼きに使う。
for (const file of ['qstyle.routes.json', 'qstyle-manifest.json']) {
  const from = path.resolve(fixtureRoot, 'dist', file);
  if (!fs.existsSync(from)) continue; // QSTYLE_OFF=1 (対照実験) では成果物が出ない
  fs.copyFileSync(from, path.resolve(fixtureRoot, 'server', file));
}
