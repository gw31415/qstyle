#!/usr/bin/env node
// size-report harness: qwik-native 配信の build 成果物 (dist) の配信 size を
// 集計し JSON 出力する。依存なし (node 組み込みのみ)。
//
// CSS 配信は vite/qwik 標準配管 (pack css import -> vite bundle) のため、
// qstyle 固有 asset (qstyle.*.css / routes.json / units.json) は存在しない。
//
// 集計対象:
//   (a) dist 配下の *.css: file 数・総 bytes (gzip 含む)
//   (b) qstyle-manifest.json: packs 数・cssText 総 bytes・module 数
//
// Usage:
//   node scripts/size-report.mjs <distDir> [--out <file>] [--compare <file>]
//
//   --out     JSON report を file に書き出す (無ければ stdout に JSON)。
//   --compare 過去 report (JSON) と比較し human readable diff を stdout に出す。
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/** dist 以下を再帰走査し、predicate に一致する file path を返す (.map は除外)。 */
function walkFiles(dir, predicate) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, predicate));
    } else if (entry.isFile() && !entry.name.endsWith('.map') && predicate(full)) {
      out.push(full);
    }
  }
  return out.sort();
}

function fileSize(path) {
  return statSync(path).size;
}

function gzipSize(path) {
  return gzipSync(readFileSync(path)).length;
}

function readJsonIfExists(path, warnings) {
  if (!existsSync(path)) {
    warnings.push(`missing: ${basename(path)}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    warnings.push(`unparseable: ${basename(path)} (${error.message})`);
    return null;
  }
}

/**
 * dist dir から size report を組み立てる (純関数: 同一 dist で同一 result。
 * generatedAt を除けば決定的)。
 */
export function buildReport(distDir) {
  const dist = resolve(distDir);
  const warnings = [];
  if (!existsSync(dist)) {
    throw new Error(`dist dir not found: ${dist}`);
  }

  // (a) CSS assets (vite bundle)。
  const cssFiles = walkFiles(dist, (p) => p.endsWith('.css'));
  const files = cssFiles.map((path) => ({
    name: relative(dist, path),
    bytes: fileSize(path),
    gzipBytes: gzipSize(path),
  }));
  const css = {
    fileCount: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
    totalGzipBytes: files.reduce((sum, f) => sum + f.gzipBytes, 0),
    files,
  };

  // (b) qstyle manifest: packs 数・cssText 総 bytes・module 数。
  const manifestJson = readJsonIfExists(join(dist, 'qstyle-manifest.json'), warnings);
  const packs = Array.isArray(manifestJson?.packs) ? manifestJson.packs : [];
  const packCssBytes = packs.reduce(
    (sum, p) => sum + (typeof p?.cssText === 'string' ? Buffer.byteLength(p.cssText, 'utf8') : 0),
    0,
  );
  const manifest = {
    packCount: packs.length,
    packCssBytes,
    moduleCount: manifestJson?.manifest && typeof manifestJson.manifest === 'object'
      ? Object.keys(manifestJson.manifest).length
      : 0,
  };

  return {
    version: 2,
    dist,
    generatedAt: new Date().toISOString(),
    css,
    manifest,
    warnings,
  };
}

function fmtDelta(prev, curr) {
  const delta = curr - prev;
  const sign = delta > 0 ? '+' : '';
  const pct = prev === 0 ? '' : ` (${sign}${((delta / prev) * 100).toFixed(1)}%)`;
  return `${sign}${delta}${pct}`;
}

/** 過去 report との human readable diff。 */
export function formatDiff(current, previous) {
  const lines = [];
  const metric = (label, prev, curr) => {
    lines.push(`${label}: ${prev} -> ${curr} (${fmtDelta(prev, curr)})`);
  };
  metric('totalCssBytes', previous.css?.totalBytes ?? 0, current.css.totalBytes);
  metric(
    'totalCssGzipBytes',
    previous.css?.totalGzipBytes ?? 0,
    current.css.totalGzipBytes,
  );
  metric('cssFileCount', previous.css?.fileCount ?? 0, current.css.fileCount);
  metric('packCount', previous.manifest?.packCount ?? 0, current.manifest.packCount);
  metric('packCssBytes', previous.manifest?.packCssBytes ?? 0, current.manifest.packCssBytes);
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { distDir: null, out: null, compare: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') args.out = argv[++i];
    else if (arg === '--compare') args.compare = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (args.distDir === null) args.distDir = arg;
    else args.help = true;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.distDir === null) {
    process.stderr.write(
      'usage: node scripts/size-report.mjs <distDir> [--out <file>] [--compare <file>]\n',
    );
    process.exitCode = args.distDir === null ? 1 : 0;
    return;
  }
  const report = buildReport(args.distDir);
  if (args.out !== null) {
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`wrote: ${args.out}\n`);
  }
  if (args.compare !== null) {
    if (!existsSync(args.compare)) {
      process.stderr.write(`compare file not found: ${args.compare}\n`);
      process.exitCode = 1;
    } else {
      const previous = JSON.parse(readFileSync(args.compare, 'utf8'));
      process.stdout.write(`${formatDiff(report, previous)}\n`);
    }
  } else if (args.out === null) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main(process.argv.slice(2));
}
