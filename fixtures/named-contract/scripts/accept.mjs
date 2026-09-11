#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const node = process.execPath;
const port = process.env.NAMED_CONTRACT_PORT ?? '4183';
const baseUrl = `http://127.0.0.1:${port}`;

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, ...env };
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete environment[key];
    }
    const child = spawn(node, args, {
      cwd: root,
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

const build = await run(['scripts/build.mjs'], { QSTYLE_NAMED_IMPORT: '1', QSTYLE_NAMED_HEAD: '1' });
if (build.code !== 0) {
  process.stderr.write(build.stdout);
  process.stderr.write(build.stderr);
  process.exit(build.code ?? 1);
}

const server = spawn(node, ['server/entry.node-server.js'], {
  cwd: root,
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
      // Wait for the generated server bundle to begin listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!ready) throw new Error(`server did not become ready\n${serverOutput}`);
  const probe = await run(['scripts/probe.mjs'], { BASE_URL: baseUrl, QSTYLE_NAMED_HEAD: '1' });
  process.stdout.write(probe.stdout);
  process.stderr.write(probe.stderr);
  if (probe.code !== 0) process.exitCode = probe.code ?? 1;
} finally {
  await stopServer();
}

if (process.exitCode) process.exit(process.exitCode);
const hmr = await run(['scripts/hmr.mjs'], { QSTYLE_NAMED_IMPORT: '1', QSTYLE_NAMED_HEAD: '1' });
process.stdout.write(hmr.stdout);
process.stderr.write(hmr.stderr);
if (hmr.code !== 0) process.exitCode = hmr.code ?? 1;
