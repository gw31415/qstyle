// scripts/size-report.mjs の node:test。`node --test scripts/` で実行する。
// fixtures/route-css-asset の build 済み dist が無い環境では skip する
// (dist は gitignore 済み)。
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, formatDiff } from './size-report.mjs';

const distDir = fileURLToPath(new URL('../fixtures/route-css-asset/dist', import.meta.url));
const skip = !existsSync(distDir);

test('css assets: qstyle.*.css の数・bytes・gzip を集計する', { skip }, () => {
  const report = buildReport(distDir);
  assert.equal(report.css.fileCount, 3);
  assert.deepEqual(
    report.css.files.map((f) => f.name).sort(),
    [
      'assets/qstyle.q_007720f1.css',
      'assets/qstyle.q_288d32da.css',
      'assets/qstyle.q_f22bf132.css',
    ],
  );
  for (const file of report.css.files) {
    assert.equal(file.bytes, statSync(join(distDir, file.name)).size);
    assert.ok(file.gzipBytes > 0);
    assert.ok(file.gzipBytes <= file.bytes * 2, 'gzip は raw の数倍を超えない');
  }
  assert.equal(
    report.css.totalBytes,
    report.css.files.reduce((sum, f) => sum + f.bytes, 0),
  );
});

test('routes: qstyle.routes.json から route 毎の初期 asset bytes', { skip }, () => {
  const report = buildReport(distDir);
  assert.deepEqual(
    report.routes.map((r) => r.route),
    ['/', '/about'],
  );
  const root = report.routes[0];
  assert.equal(root.assetCount, 2);
  assert.equal(
    root.bytes,
    statSync(join(distDir, 'assets/qstyle.q_007720f1.css')).size +
      statSync(join(distDir, 'assets/qstyle.q_288d32da.css')).size,
  );
  assert.deepEqual(root.assets, [
    'assets/qstyle.q_007720f1.css',
    'assets/qstyle.q_288d32da.css',
  ]);
});

test('units: qstyle.units.json の unit 数', { skip }, () => {
  const report = buildReport(distDir);
  assert.equal(report.units.count, 5);
});

test('embeddedUnitIds: JS 内の埋め込み unit id (近似 grep)', { skip }, () => {
  const report = buildReport(distDir);
  // fixture は 5 unit が JS (ensureModuleStyles への配列) に埋め込まれている。
  assert.equal(report.embeddedUnitIds.unique, 5);
  assert.ok(report.embeddedUnitIds.occurrences >= 5);
  assert.ok(report.embeddedUnitIds.jsFileCount >= 1);
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
    routes: current.routes.map((r, i) => (i === 0 ? { ...r, bytes: r.bytes - 1 } : r)),
  };
  const diff = formatDiff(current, previous);
  assert.match(diff, /totalCssBytes: \d+ -> \d+ \(\+10/);
  assert.match(diff, /route \/ initialBytes/);
  assert.match(diff, /units/);
});

test('buildReport: 存在しない dist dir は error', () => {
  assert.throws(() => buildReport('/nonexistent/qstyle-dist'), /not found/);
});
