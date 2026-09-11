#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Run after pnpm build. Fixtures consume the built public package entries.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '.qstyle/named-acceptance');
await mkdir(output, { recursive: true });
const env = { ...process.env, COMPILER_CONTRACT_QWIK: 'stock',
  QSTYLE_NAMED_IMPORT: '1', QSTYLE_NAMED_HEAD: '1',
  QSTYLE_CONTRACT_REMOVAL: '1', QSTYLE_CONTRACT_RETRY: '1' };
delete env.QSTYLE_HMR_ROOT;
delete env.QSTYLE_CONTRACT_HEAD;
const checks = [
  ['compiler-build', 'fixtures/compiler-contract/build.mjs', { QSTYLE_CONTRACT_WIND4: '1' }],
  ['compiler-browser', 'fixtures/compiler-contract/probe.mjs', { QSTYLE_CONTRACT_WIND4: '1' }],
  ['delivery', 'fixtures/compiler-contract/delivery-probe.mjs'],
  ['ssr-boundary', 'fixtures/compiler-contract/ssr-style-placement.probe.mjs'],
  ['final-report', 'fixtures/compiler-contract/report-build.mjs'],
  ['component-hmr', 'fixtures/compiler-contract/hmr.mjs'],
  ['node-and-route-hmr', 'fixtures/named-contract/scripts/accept.mjs'],
  ['static-adapter', 'fixtures/named-contract/scripts/ssg.mjs'],
];
const results = [];
for (const [name, script, overrides] of checks) {
  const child = spawn(process.execPath, [script], { cwd: root,
    env: { ...env, QSTYLE_CONTRACT_WIND4: '', ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code) => done(code));
  });
  await writeFile(resolve(output, `${name}.log`), stdout + stderr);
  results.push({ name, pass: code === 0, code });
  console.log(`${name}: ${code === 0 ? 'passed' : 'FAILED'}`);
  if (code !== 0) {
    process.stderr.write(stdout + stderr);
    process.exitCode = 1;
    break;
  }
}
await writeFile(resolve(output, 'results.json'), JSON.stringify({ dependency: 'unmodified Qwik beta.43', results }, null, 2) + '\n');
