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
