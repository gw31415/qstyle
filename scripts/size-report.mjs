#!/usr/bin/env node
// size-report harness (plan.md B-4): css-asset backend の build 成果物 (dist) の
// 配信 size を集計し JSON 出力する。依存なし (node 組み込みのみ)。
//
// 集計対象:
//   (a) assets 配下の qstyle.*.css: file 数・総 bytes (gzip 含む)
//   (b) qstyle.routes.json: route 毎の初期 asset bytes
//   (c) qstyle.units.json: unit 数
//   (d) JS 内に埋め込まれた unit id 総数 (近似: dist 全 .js の grep。
//       ensureModuleStyles へ渡される `q_xxxxxxxx` 配列要素を数える)
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

const QSTYLE_CSS_RE = /(^|\/)qstyle\.[\w.-]+\.css$/;
const UNIT_ID_RE = /\bq_[0-9a-f]{8}\b/g;

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

  // (a) qstyle CSS assets。
  const cssFiles = walkFiles(dist, (p) => QSTYLE_CSS_RE.test(p));
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

  // (b) route manifest: route 毎の初期 asset bytes。
  const routesJson = readJsonIfExists(join(dist, 'qstyle.routes.json'), warnings);
  const routes = [];
  if (routesJson && Array.isArray(routesJson.entries)) {
    for (const entry of routesJson.entries) {
      if (typeof entry?.route !== 'string' || !Array.isArray(entry?.assets)) continue;
      const assets = entry.assets.filter((a) => typeof a === 'string');
      const resolved = assets.map((name) => join(dist, name));
      for (const [i, name] of assets.entries()) {
        if (!existsSync(resolved[i])) warnings.push(`route ${entry.route}: missing asset ${name}`);
      }
      routes.push({
        route: entry.route,
        assetCount: resolved.filter((p) => existsSync(p)).length,
        bytes: resolved.reduce((sum, p) => sum + (existsSync(p) ? fileSize(p) : 0), 0),
        gzipBytes: resolved.reduce(
          (sum, p) => sum + (existsSync(p) ? gzipSize(p) : 0),
          0,
        ),
        assets,
      });
    }
  }

  // (c) unit 数。
  const unitsJson = readJsonIfExists(join(dist, 'qstyle.units.json'), warnings);
  const units = {
    count:
      unitsJson && unitsJson.units && typeof unitsJson.units === 'object'
        ? Object.keys(unitsJson.units).length
        : 0,
  };

  // (d) JS 内 ensureModuleStyles 埋め込み unit id (近似)。
  const jsFiles = walkFiles(dist, (p) => p.endsWith('.js'));
  const ids = new Set();
  let occurrences = 0;
  for (const path of jsFiles) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(UNIT_ID_RE)) {
      ids.add(match[0]);
      occurrences += 1;
    }
  }
  const embeddedUnitIds = {
    unique: ids.size,
    occurrences,
    jsFileCount: jsFiles.length,
  };

  return {
    version: 1,
    dist,
    generatedAt: new Date().toISOString(),
    css,
    routes,
    units,
    embeddedUnitIds,
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
  metric('units', previous.units?.count ?? 0, current.units.count);
  metric(
    'embeddedUnitIds.unique',
    previous.embeddedUnitIds?.unique ?? 0,
    current.embeddedUnitIds.unique,
  );
  const prevRoutes = new Map((previous.routes ?? []).map((r) => [r.route, r]));
  for (const route of current.routes) {
    const prev = prevRoutes.get(route.route);
    if (prev === undefined) {
      lines.push(`route ${route.route}: new (bytes ${route.bytes})`);
    } else {
      metric(`route ${route.route} initialBytes`, prev.bytes ?? 0, route.bytes);
    }
  }
  for (const route of previous.routes ?? []) {
    if (!current.routes.some((r) => r.route === route.route)) {
      lines.push(`route ${route.route}: removed`);
    }
  }
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
