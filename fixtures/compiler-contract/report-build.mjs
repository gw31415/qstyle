import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(fixture, '../..');
await mkdir(resolve(workspace, '.qstyle'), { recursive: true });
const root = await mkdtemp(resolve(workspace, '.qstyle/report-contract-'));
for (const input of ['src', 'vite.config.ts', 'uno.config.ts', 'uno.wind4.config.ts', 'tsconfig.json', 'package.json', 'build.mjs', 'prepare-qwik.mjs', 'report-probe.mjs']) {
  await cp(resolve(fixture, input), resolve(root, input), { recursive: true });
}
await symlink(resolve(fixture, 'node_modules'), resolve(root, 'node_modules'), 'dir');
const sourceFile = resolve(root, 'src/root.tsx');
const original = await readFile(sourceFile, 'utf8');
const environment = { ...process.env, COMPILER_CONTRACT_QWIK: 'stock', QSTYLE_CONTRACT_WIND4: '1', QSTYLE_NAMED_IMPORT: '1', QSTYLE_NAMED_HEAD: '1' };
const results = [];
function run(script, extra = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve(root, script)], { cwd: root, env: { ...environment, ...extra }, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${script}: exit ${code}, signal ${signal}`)));
  });
}
async function inspect(label, managed) {
  await run('build.mjs');
  await run('report-probe.mjs', { QSTYLE_REPORT_MANAGED: managed ? '1' : '0' });
  const report = JSON.parse(await readFile(resolve(root, 'dist/qstyle-report.json'), 'utf8'));
  results.push({ label, wholeSiteGuarantee: report.wholeSiteGuarantee,
    assetCount: report.assets.length, packCount: report.packs.length,
    duplicateDefinitionCount: report.duplicateDefinitionCount, duplicatePayloadCount: report.duplicatePayloadCount,
    classCount: report.classCount, fixedClassCount: report.fixedClassCount, classOptimality: report.classOptimality,
    diagnostics: report.diagnostics });
}
function removeOnce(source, text) {
  assert.equal(source.split(text).length, 2, 'fixture control must appear exactly once');
  return source.replace(text, '');
}
let managedSource = removeOnce(original, `const HeadStyle = component$(() => {
  useStyles$('#head-order{color:rgb(100,0,0)}');
  return null;
});

`);
managedSource = removeOnce(managedSource, '<HeadStyle />');
managedSource = removeOnce(managedSource, "import { NamedHookControls } from './named-hook-controls';\n");
managedSource = removeOnce(managedSource, '<NamedHookControls />');
managedSource = removeOnce(managedSource, '<style dangerouslySetInnerHTML="#head-order{color:rgb(0,100,0)}" />');
try {
  await inspect('authored-controls', false);
  await writeFile(sourceFile, managedSource);
  await inspect('managed-styles', true);
} finally {
  await rm(root, { recursive: true, force: true });
}
assert.equal(await readFile(resolve(fixture, 'src/root.tsx'), 'utf8'), original);
const output = process.env.QSTYLE_REPORT_PROBE_OUTPUT ?? '/private/tmp/qstyle-final-report-probe.json';
await writeFile(output, `${JSON.stringify({ checks: ['final byte counts and SHA-256 digests', 'single payload per pack',
  'source path privacy', 'authored controls reject whole-site guarantee', 'managed source passes', 'source fixture unchanged'], results }, null, 2)}\n`);
console.log(JSON.stringify({ output, results }));
