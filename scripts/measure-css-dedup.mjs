import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const { module: { groupDuplicateCss, measureCss, analyzeCssOptimization } } = await runnerImport(
  fileURLToPath(new URL('../packages/vite/src/dedup.ts', import.meta.url)),
);

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/measure-css-dedup.mjs <generated.css>');
const css = readFileSync(path, 'utf8');
// No tag/coexistence evidence is inferred from CSS alone. Unknown cases stay intact.
const meta = { unitTags: new Map(), condUnitIds: new Set() };
const candidate = groupDuplicateCss(css, meta);
const report = analyzeCssOptimization(css, meta);
console.log(JSON.stringify({
  file: path,
  comparison: { gzipLevel: 6, brotliQuality: 11, brotliMode: 'generic' },
  original: measureCss(css),
  rawCandidate: measureCss(candidate),
  selected: report.selected,
  selectedStrategy: report.selectedStrategy,
  evaluatedCandidates: report.evaluatedCandidates,
  keptOriginal: report.css === css,
}, null, 2));
