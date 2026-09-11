import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNativeGuarantee, readNativeReport } from '../../packages/inspector/dist/index.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const directory = resolve(root, 'dist');
const source = await readFile(resolve(directory, 'qstyle-report.json'), 'utf8');
const report = readNativeReport(JSON.parse(source));
assert.equal(report.schemaVersion, 1);
assert.equal(source.includes(root), false, 'report must not expose an absolute source path');
assert.equal(report.duplicateDefinitionCount, 0);
assert.equal(report.duplicatePayloadCount, 0);
assert.ok(report.packs.length > 0);
assert.ok(report.assets.length > 0);
for (const asset of report.assets) {
  const bytes = await readFile(resolve(directory, asset.fileName));
  assert.equal(asset.bytes, bytes.length, `final byte count: ${asset.fileName}`);
  assert.equal(asset.contentDigest, createHash('sha256').update(bytes).digest('hex'), `final digest: ${asset.fileName}`);
}
for (const pack of report.packs) {
  const assets = report.assets.filter((asset) => asset.packIds.includes(pack.id));
  assert.equal(assets.length, 1, `exactly one browser payload for ${pack.id}`);
}
const managed = process.env.QSTYLE_REPORT_MANAGED === '1';
assert.equal(report.wholeSiteGuarantee, managed,
  managed ? 'managed fixture must prove its whole-site constraints' : 'authored native/head controls must prevent whole-site guarantee');
if (managed) assertNativeGuarantee(report);
else assert.throws(() => assertNativeGuarantee(report), /whole-site guarantee/);
console.log(JSON.stringify({ checks: ['final bytes', 'final digests', 'one payload per pack', 'source privacy', 'honest whole-site status'],
  assets: report.assets.length, packs: report.packs.length, wholeSiteGuarantee: report.wholeSiteGuarantee }));
