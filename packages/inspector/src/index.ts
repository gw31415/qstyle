// @qstyle/inspector — atom provenance / chunk membership viewer (plan.md §58-59)。
import { routeSignature, sourceSignature, usageSignature } from '@qstyle/core';
import type { ResidualRuleNode, StyleManifest, UsageGraph } from '@qstyle/core';

export interface AtomReport {
  readonly atomId: string;
  readonly semantic: string;
  readonly usedBy: readonly string[];
  readonly routes: readonly string[];
  readonly chunk: string | null;
  readonly sources: readonly string[];
}

export function formatAtomReport(report: AtomReport): string {
  const lines = [
    `Atom: ${report.atomId}`,
    `Semantic: ${report.semantic}`,
    'Used by:',
    ...report.usedBy.map((c) => `  ${c}`),
    'Routes:',
    ...report.routes.map((r) => `  ${r}`),
    `Chunk: ${report.chunk ?? '(unassigned)'}`,
    'Sources:',
    ...report.sources.map((s) => `  ${s}`),
  ];
  return lines.join('\n');
}

/** graph + manifest から atom の所属情報を収集する。sources 明示時はそれを優先する。 */
export function buildAtomReport(input: {
  readonly atomId: string;
  readonly semantic: string;
  readonly graph: UsageGraph;
  readonly manifest: StyleManifest | null;
  readonly sources?: readonly string[] | undefined;
}): AtomReport {
  return {
    atomId: input.atomId,
    semantic: input.semantic,
    usedBy: usageSignature(input.graph, input.atomId),
    routes: routeSignature(input.graph, input.atomId),
    chunk: chunkOf(input.manifest, input.atomId),
    sources: input.sources ?? sourceSignature(input.graph, input.atomId),
  };
}

/** manifest の 1 行サマリ: route 数とユニーク asset 数。 */
export function summarizeManifest(manifest: StyleManifest): string {
  const assets: Set<string> = new Set<string>();
  for (const entry of manifest.entries) {
    for (const asset of entry.assets) assets.add(asset);
  }
  return `routes: ${manifest.entries.length}, assets: ${assets.size}`;
}

/**
 * residual の説明行 (plan.md §59)。
 * 例: `button.css:34\nnot atomicized:\n  shorthand/longhand ordering dependency`
 */
export function formatResidualReport(residual: ResidualRuleNode): string {
  const origin: string =
    residual.provenance.length > 0
      ? (residual.provenance.map((p) => p.source).join(', ') ?? '')
      : '<unknown>';
  return [
    `${origin}`,
    'not atomicized:',
    `  ${residual.reason}: ${residual.cssText}`,
  ].join('\n');
}

/** residual 群の 1 行サマリ: 件数と理由別の内訳 (reason asc)。 */
export function summarizeResiduals(residuals: readonly ResidualRuleNode[]): string {
  const counts = new Map<string, number>();
  for (const residual of residuals) {
    counts.set(residual.reason, (counts.get(residual.reason) ?? 0) + 1);
  }
  const parts: string[] = [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([reason, count]) => `${reason} x${count}`);
  return `residuals: ${residuals.length}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
}

interface LegacyStyleUsageLike {
  readonly module: string;
  readonly hook: 'global' | 'scoped';
  readonly local: string;
  readonly cssPath: string | null;
}

/**
 * legacy hook 利用の一覧 (plan.md §24)。Qwik lifecycle に残すため rewrite しない旨も示す。
 * @qstyle/vite への依存を作らないよう構造的部分型で受ける。
 */
export function formatLegacyReport(usages: readonly LegacyStyleUsageLike[]): string {
  if (usages.length === 0) return 'legacy styles: none (Qwik lifecycle preserved)';
  const sorted: readonly LegacyStyleUsageLike[] = [...usages].sort((a, b) =>
    a.module < b.module
      ? -1
      : a.module > b.module
        ? 1
        : a.local < b.local
          ? -1
          : a.local > b.local
            ? 1
            : 0,
  );
  const lines: string[] = ['legacy styles (preserved in Qwik lifecycle):'];
  for (const usage of sorted) {
    lines.push(
      `  ${usage.module}: ${usage.hook}(${usage.local})${usage.cssPath === null ? '' : ` <- ${usage.cssPath}`}`,
    );
  }
  return lines.join('\n');
}

/** atomId を含む asset 名を entries から探す (route asc の先勝ち)。見つからなければ null。 */
function chunkOf(manifest: StyleManifest | null, atomId: string): string | null {
  if (manifest === null) return null;
  for (const entry of manifest.entries) {
    for (const asset of entry.assets) {
      if (asset.includes(atomId)) return asset;
    }
  }
  return null;
}

/** chunk の route 分類 (R2)。usage graph の逆引きで 1 route → route-local / 複数 → shared。 */
export type ChunkClassification = 'route-local' | 'shared' | 'unrouted';

/** chunk report の 1 行分 (plan.md R1.8: fileName × bytes × classification × routes × members 数)。 */
export interface ChunkReportEntry {
  readonly fileName: string;
  readonly bytes: number;
  readonly classification: ChunkClassification;
  readonly routes: readonly string[];
  readonly members: number;
}

/** backend 種別 + chunk 表の report (R1.8)。 */
export interface ChunkReport {
  readonly backend: string;
  readonly chunks: readonly ChunkReportEntry[];
}

/**
 * `__chunkPlans` (CssAssetChunk) 等の chunk plan 一覧から report を組む。
 * @qstyle/vite への依存を作らないよう構造的部分型で受ける。fileName 昇順で決定的に並べる。
 */
export function buildChunkReport(input: {
  readonly backend: string;
  readonly chunks: readonly {
    readonly fileName: string;
    readonly bytes: number;
    readonly classification?: string | undefined;
    readonly routes?: readonly string[] | undefined;
    /** members は配列 (CssAssetChunk) でも件数 (事前集計) でもよい。 */
    readonly members: readonly unknown[] | number;
  }[];
}): ChunkReport {
  const chunks: ChunkReportEntry[] = input.chunks.map((chunk) => ({
    fileName: chunk.fileName,
    bytes: chunk.bytes,
    classification: isClassification(chunk.classification) ? chunk.classification : 'unrouted',
    routes: [...(chunk.routes ?? [])].sort(),
    members: typeof chunk.members === 'number' ? chunk.members : chunk.members.length,
  }));
  chunks.sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
  return { backend: input.backend, chunks };
}

/**
 * chunk report を文字列化する (R1.8)。
 * 例:
 * ```
 * chunk report (backend: css-asset, chunks: 2)
 *   assets/qstyle.q_a1b2c3d4.css  bytes: 312  route-local  routes: /
 *   units: 2
 * ```
 * 1 chunk 2 行 (属性行 + units 行) にして、長い route 列でも折返しを汚さない。
 */
export function formatChunkReport(report: ChunkReport): string {
  const lines: string[] = [
    `chunk report (backend: ${report.backend}, chunks: ${report.chunks.length})`,
  ];
  for (const chunk of report.chunks) {
    const routes: string = chunk.routes.length > 0 ? chunk.routes.join(', ') : '(unrouted)';
    lines.push(
      `  ${chunk.fileName}  bytes: ${String(chunk.bytes)}  ${chunk.classification}  routes: ${routes}`,
      `    units: ${String(chunk.members)}`,
    );
  }
  return lines.join('\n');
}

function isClassification(value: unknown): value is ChunkClassification {
  return value === 'route-local' || value === 'shared' || value === 'unrouted';
}

export {
  assertNativeGuarantee,
  formatNativePackMappings,
  formatNativeReportSummary,
  isNativeReport,
  mapNativeReportPacks,
  parseNativeReport,
  readNativeReport,
  summarizeNativeReport,
  validateNativeReport,
} from './native-report.js';
export type {
  NativeReport,
  NativeReportAsset,
  NativeReportClassAssignment,
  NativeReportClassOptimality,
  NativeReportDiagnostic,
  NativeReportDiagnosticSpan,
  NativeReportModule,
  NativeReportOwner,
  NativeReportPack,
  NativeReportPackMapping,
  NativeReportRule,
  NativeReportSummary,
  NativeReportValidationResult,
} from './native-report.js';
export { NativeReportValidationError } from './native-report.js';
