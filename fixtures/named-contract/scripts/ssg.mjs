#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, '..');
const node = process.execPath;
const staticConfig = path.resolve(fixtureRoot, 'adapters/static/vite.config.ts');
const port = process.env.NAMED_CONTRACT_SSG_PORT ?? '4184';
const baseUrl = `http://127.0.0.1:${port}`;
const nodeDist = path.resolve(fixtureRoot, 'dist');
const staticDist = path.resolve(fixtureRoot, 'dist-ssg');
const preservedNodeDist = path.resolve(fixtureRoot, `.node-dist-${process.pid}`);

function findWorkspaceRoot(from) {
  let directory = from;
  for (;;) {
    if (fs.existsSync(path.join(directory, 'pnpm-workspace.yaml'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('pnpm-workspace.yaml not found');
    directory = parent;
  }
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
    if (!stat.isSymbolicLink()) throw new Error(`${linkPath} exists but is not a symlink`);
    fs.rmSync(linkPath, { force: true });
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, 'dir');
}

const workspaceRoot = findWorkspaceRoot(fixtureRoot);
const stockCore = path.resolve(workspaceRoot, 'packages/qwik/node_modules/@qwik.dev/core');
const stockRouter = path.resolve(workspaceRoot, 'packages/qwik/node_modules/@qwik.dev/router');
const compilerFixtureCore = path.resolve(workspaceRoot, 'fixtures/compiler-contract/node_modules/@qwik.dev/core');
if (!fs.existsSync(stockCore) || !fs.existsSync(stockRouter)) {
  throw new Error('stock Qwik packages are missing; run pnpm install in the repository root');
}
ensureSymlink(stockCore, path.join(fixtureRoot, 'node_modules/@qwik.dev/core'));
ensureSymlink(stockRouter, path.join(fixtureRoot, 'node_modules/@qwik.dev/router'));
if (!fs.existsSync(compilerFixtureCore)
  || fs.realpathSync(compilerFixtureCore) !== fs.realpathSync(stockCore)) {
  throw new Error('compiler-contract and named-contract must both use stock packages/qwik/node_modules/@qwik.dev/core');
}

for (const generated of ['dist-ssg', 'server-ssg', `.node-dist-${process.pid}`]) {
  fs.rmSync(path.join(fixtureRoot, generated), { recursive: true, force: true });
}

// The stock adapter uses the Qwik optimizer's client directory (dist) even
// when a Vite environment outDir is supplied. Stage that directory aside so
// SSG output can live under dist-ssg without disturbing the Node acceptance.
if (fs.existsSync(nodeDist)) fs.renameSync(nodeDist, preservedNodeDist);

process.env.NODE_ENV = 'production';
process.env.QSTYLE_NAMED_IMPORT ??= '1';
process.env.QSTYLE_NAMED_HEAD ??= '1';
const { build, createBuilder } = await import('vite');
try {
  // The stock Qwik adapter's SSG worker reads the client manifest before its
  // app-builder pass. Seed the staging directory with the normal client build
  // first, as the Qwik CLI does for adapter builds.
  await build({ root: fixtureRoot, logLevel: 'warn', mode: 'production' });
  const builder = await createBuilder({
    root: fixtureRoot,
    logLevel: 'warn',
    mode: 'production',
    configFile: staticConfig,
  });
  await builder.buildApp();
  if (!fs.existsSync(nodeDist)) throw new Error(`SSG build did not emit ${nodeDist}`);
  fs.rmSync(staticDist, { recursive: true, force: true });
  fs.renameSync(nodeDist, staticDist);
} finally {
  if (fs.existsSync(nodeDist)) fs.rmSync(nodeDist, { recursive: true, force: true });
  if (fs.existsSync(preservedNodeDist)) fs.renameSync(preservedNodeDist, nodeDist);
}

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, ...env };
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete environment[key];
    }
    const child = spawn(node, args, {
      cwd: fixtureRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const server = spawn(node, ['scripts/serve-ssg.mjs'], {
  cwd: fixtureRoot,
  env: { ...process.env, PORT: port },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk; });
server.stderr.on('data', (chunk) => { serverOutput += chunk; });

async function stopServer() {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'close'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}

try {
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) { ready = true; break; }
    } catch {
      // Wait for the static server to begin listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!ready) throw new Error(`static server did not become ready\n${serverOutput}`);
  const probe = await run(['scripts/ssg-probe.mjs'], { BASE_URL: baseUrl });
  process.stdout.write(probe.stdout);
  process.stderr.write(probe.stderr);
  if (probe.code !== 0) {
    process.stderr.write(serverOutput);
    process.exitCode = probe.code ?? 1;
  }
} finally {
  await stopServer();
}

if (process.exitCode) process.exit(process.exitCode);

console.log(JSON.stringify({
  fixture: 'named-contract',
  adapter: 'ssg',
  outDir: pathToFileURL(path.resolve(fixtureRoot, 'dist-ssg')).pathname,
  routes: ['/', '/route-b/'],
}));
