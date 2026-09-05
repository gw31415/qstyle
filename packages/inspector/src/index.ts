// @qstyle/inspector — atom provenance / chunk membership viewer (plan.md §58-59)。
// provenance (sources) は M10 後半で接続する。現状は core の graph / manifest API を照会する。
import { routeSignature, usageSignature } from '@qstyle/core';
import type { StyleManifest, UsageGraph } from '@qstyle/core';

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

/** graph + manifest から atom の所属情報を収集する (sources は M10 後半で埋める)。 */
export function buildAtomReport(input: {
  readonly atomId: string;
  readonly semantic: string;
  readonly graph: UsageGraph;
  readonly manifest: StyleManifest | null;
}): AtomReport {
  return {
    atomId: input.atomId,
    semantic: input.semantic,
    usedBy: usageSignature(input.graph, input.atomId),
    routes: routeSignature(input.graph, input.atomId),
    chunk: chunkOf(input.manifest, input.atomId),
    sources: [],
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
