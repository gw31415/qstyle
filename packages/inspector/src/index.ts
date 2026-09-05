// @qstyle/inspector — atom provenance / chunk membership viewer (plan.md §58-59)。
// Milestone 10 で本実装する。M0 では型のみ。
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
