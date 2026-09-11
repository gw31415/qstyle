#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, '..');

function findWorkspaceRoot(from) {
  let directory = from;
  for (;;) {
    if (fs.existsSync(path.join(directory, 'pnpm-workspace.yaml'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('pnpm-workspace.yaml not found');
    directory = parent;
  }
}

const workspaceRoot = findWorkspaceRoot(fixtureRoot);
const stockCore = path.resolve(workspaceRoot, 'packages/qwik/node_modules/@qwik.dev/core');
const stockRouter = path.resolve(workspaceRoot, 'packages/qwik/node_modules/@qwik.dev/router');
const compilerFixtureCore = path.resolve(workspaceRoot, 'fixtures/compiler-contract/node_modules/@qwik.dev/core');

function ensureSymlink(target, linkPath) {
  let stat;
  try {
    stat = fs.lstatSync(linkPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat) {
    if (stat.isSymbolicLink() && fs.realpathSync(linkPath) === fs.realpathSync(target)) return;
    if (!stat.isSymbolicLink()) throw new Error(`${linkPath} exists but is not a symlink`);
    fs.rmSync(linkPath, { force: true });
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, 'dir');
}

if (!fs.existsSync(stockCore) || !fs.existsSync(stockRouter)) {
  throw new Error('stock Qwik packages are missing; run pnpm install in the repository root');
}
ensureSymlink(stockCore, path.join(fixtureRoot, 'node_modules/@qwik.dev/core'));
ensureSymlink(stockRouter, path.join(fixtureRoot, 'node_modules/@qwik.dev/router'));

// Both acceptance fixtures and the package runtime must resolve to the same
// unmodified stock Qwik package.
if (!fs.existsSync(compilerFixtureCore)
  || fs.realpathSync(compilerFixtureCore) !== fs.realpathSync(stockCore)) {
  throw new Error('compiler-contract and named-contract must both use stock packages/qwik/node_modules/@qwik.dev/core');
}

for (const generated of ['dist', 'server/build', 'server/entry.node-server.js']) {
  fs.rmSync(path.join(fixtureRoot, generated), { recursive: true, force: true });
}

process.env.NODE_ENV = 'production';
process.env.QSTYLE_NAMED_IMPORT ??= '1';
const { build, createBuilder } = await import('vite');
await build({ root: fixtureRoot, logLevel: 'warn', mode: 'production' });

const serverBuilder = await createBuilder({
  root: fixtureRoot,
  logLevel: 'warn',
  mode: 'production',
  configFile: path.resolve(fixtureRoot, 'adapters/node-server/vite.config.ts'),
});
const ssrEnvironment = serverBuilder.environments.ssr;
if (ssrEnvironment === undefined) throw new Error('ssr environment not found');
await serverBuilder.build(ssrEnvironment);

console.log(JSON.stringify({
  fixture: 'named-contract',
  qwik: fs.realpathSync(stockCore),
  namedImport: process.env.QSTYLE_NAMED_IMPORT === '1',
  headPlacement: process.env.QSTYLE_NAMED_HEAD === '1',
}));
