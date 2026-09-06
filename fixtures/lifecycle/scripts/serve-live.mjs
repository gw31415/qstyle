#!/usr/bin/env node
// live SSR server (C0/differential/matrix 用)。
//
// dist/ の SSG HTML があると staticFile がそれを直接配信し、live SSR を隠して
// しまう。server 起動前に SSG HTML を消してから server bundle を起動する。
// SSG bake の検証 (QWK-002/RTE-004) は別 config (e2e/ssg.config.ts) で行う。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, '..');

function removeSsgHtml(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) removeSsgHtml(full);
    else if (entry.isFile() && entry.name.endsWith('.html')) fs.rmSync(full);
  }
}

const distDir = path.join(fixtureRoot, 'dist');
if (fs.existsSync(distDir)) removeSsgHtml(distDir);

const serverEntry = path.join(fixtureRoot, 'server', 'entry.node-server.js');
if (!fs.existsSync(serverEntry)) {
  console.error(`[serve-live] missing ${serverEntry}; run scripts/build.mjs first`);
  process.exit(1);
}
const child = spawn(process.execPath, [serverEntry], {
  cwd: fixtureRoot,
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
