#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, '..');

function findWorkspaceRoot(from) {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('pnpm-workspace.yaml not found');
    dir = parent;
  }
}

const workspaceRoot = findWorkspaceRoot(fixtureRoot);
const qwikDepsRoot = path.resolve(workspaceRoot, 'packages/qwik/node_modules/@qwik.dev');
const sourceCoreRoot = path.join(qwikDepsRoot, 'core');
const sourceRouterRoot = path.join(qwikDepsRoot, 'router');
const qwikMode = process.env.NATIVE_CONTRACT_QWIK ?? 'stock';

if (qwikMode !== 'stock' && qwikMode !== 'candidate') {
  throw new Error(`NATIVE_CONTRACT_QWIK must be stock or candidate, got ${qwikMode}`);
}

function ensureSymlink(target, linkPath) {
  let stat;
  try {
    stat = fs.lstatSync(linkPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat) {
    if (stat.isSymbolicLink() && fs.realpathSync(linkPath) === fs.realpathSync(target)) return;
    if (!stat.isSymbolicLink()) {
      throw new Error(`${linkPath} exists but is not a symlink`);
    }
    fs.rmSync(linkPath, { force: true });
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, 'dir');
}

function ensureDependencyLink(name, targetRoot, linkRoot) {
  const target = path.join(targetRoot, name);
  if (!fs.existsSync(target)) {
    throw new Error(`missing @qwik.dev/${name} at ${target}; run pnpm install in the repo root`);
  }
  ensureSymlink(target, path.join(linkRoot, name));
}

const fixtureQwikRoot = path.join(fixtureRoot, 'node_modules', '@qwik.dev');
let coreRoot = sourceCoreRoot;
if (qwikMode === 'candidate') {
  const { patchQwikCore } = await import(
    pathToFileURL(path.resolve(workspaceRoot, 'patches/qwik-style-reuse/apply.mjs')).href,
  );
  coreRoot = path.resolve(fixtureRoot, 'node_modules/.cache/native-contract-candidate/core');
  patchQwikCore({ sourceRoot: sourceCoreRoot, outputRoot: coreRoot });

  // The copied package is outside pnpm's virtual store, so give it the exact
  // dependencies used by the source package. Keep the candidate self-contained
  // while leaving the workspace installation untouched.
  const sourcePackageNodeModules = path.resolve(fs.realpathSync(sourceCoreRoot), '../..');
  for (const name of ['csstype', 'launch-editor', 'magic-string', '@qwik.dev/optimizer']) {
    ensureDependencyLink(name, sourcePackageNodeModules, path.join(coreRoot, 'node_modules'));
  }
}
ensureSymlink(coreRoot, path.join(fixtureQwikRoot, 'core'));
ensureSymlink(sourceRouterRoot, path.join(fixtureQwikRoot, 'router'));

// Remove generated files so stale chunks cannot satisfy the body-based QRL
// assertions. The fixture owns these directories.
for (const generated of ['dist', 'server/build', 'server/entry.node-server.js']) {
  fs.rmSync(path.join(fixtureRoot, generated), { recursive: true, force: true });
}

process.env.NODE_ENV = 'production';
const { build, createBuilder } = await import('vite');
await build({ root: fixtureRoot, logLevel: 'warn', mode: 'production' });

const serverBuilder = await createBuilder({
  root: fixtureRoot,
  logLevel: 'warn',
  mode: 'production',
  configFile: path.resolve(fixtureRoot, process.env.NATIVE_CONTRACT_SSG
    ? 'adapters/static/vite.config.ts' : 'adapters/node-server/vite.config.ts'),
});
const ssrEnv = serverBuilder.environments.ssr;
if (ssrEnv === undefined) throw new Error('ssr environment not found');
if (process.env.NATIVE_CONTRACT_SSG) await serverBuilder.buildApp();
else await serverBuilder.build(ssrEnv);
