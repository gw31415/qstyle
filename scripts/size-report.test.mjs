// scripts/size-report.mjs の node:test。`node --test scripts/` で実行する。
// fixtures/m0-minimal の build 済み dist が無い環境では skip する
// (dist は gitignore 済み。m0-proof の vite.build() が生成する)。
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, formatDiff } from './size-report.mjs';

const distDir = fileURLToPath(new URL('../fixtures/m0-minimal/dist', import.meta.url));
const skip = !existsSync(distDir);

test('css assets: dist の *.css の数・bytes・gzip を集計する', { skip }, () => {
  const report = buildReport(distDir);
  assert.ok(report.css.fileCount >= 1);
  for (const file of report.css.files) {
    assert.ok(file.name.endsWith('.css'));
    assert.equal(file.bytes, statSync(join(distDir, file.name)).size);
    assert.ok(file.gzipBytes > 0);
    assert.ok(file.gzipBytes <= file.bytes * 2, 'gzip は raw の数倍を超えない');
  }
  assert.equal(
    report.css.totalBytes,
    report.css.files.reduce((sum, f) => sum + f.bytes, 0),
  );
});

test('manifest: packs 数・cssText bytes・module 数', { skip }, () => {
  const report = buildReport(distDir);
  assert.ok(report.manifest.packCount >= 1);
  assert.ok(report.manifest.packCssBytes > 0);
  assert.ok(report.manifest.moduleCount >= 1);
});

test('決定性: 同一 dist からは同一 report (generatedAt を除く)', { skip }, () => {
  const a = buildReport(distDir);
  const b = buildReport(distDir);
  delete a.generatedAt;
  delete b.generatedAt;
  assert.deepEqual(a, b);
});

test('formatDiff: 前回比 diff の表示', { skip }, () => {
  const current = buildReport(distDir);
  const previous = {
    ...current,
    css: { ...current.css, totalBytes: current.css.totalBytes - 10 },
    manifest: { ...current.manifest, packCssBytes: current.manifest.packCssBytes - 1 },
  };
  const diff = formatDiff(current, previous);
  assert.match(diff, /totalCssBytes: \d+ -> \d+ \(\+10/);
  assert.match(diff, /packCssBytes/);
});

test('buildReport: 存在しない dist dir は error', () => {
  assert.throws(() => buildReport('/nonexistent/qstyle-dist'), /not found/);
});
