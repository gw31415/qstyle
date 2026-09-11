import { ResidualRuleNode, StyleManifest, UsageGraph } from "@qstyle/core";
//#region src/native-report.d.ts
/**
 * Structural reader for the qstyle-native report emitted by @qstyle/vite.
 *
 * This package deliberately does not import the Vite package.  Reports are
 * build artifacts, so the reader keeps a small local copy of the public shape
 * and validates the fields that are needed by inspection and release gates.
 */
interface NativeReportModule {
  readonly id: string;
  readonly digest: string;
  readonly imports: readonly string[];
  /** Included when the producer's opt-in `report.sources` setting is true. */
  readonly source?: string;
}
interface NativeReportOwner {
  readonly id: string;
  readonly demandIds: readonly string[];
}
interface NativeReportRule {
  readonly id: string;
  readonly declarationIds: readonly string[];
  readonly ownerIds: readonly string[];
  readonly packIds: readonly string[];
  readonly fixed: boolean;
}
interface NativeReportPack {
  readonly id: string;
  readonly declarationIds: readonly string[];
  readonly ownerIds: readonly string[];
  readonly cssBytes: number;
  readonly cssDigest: string;
  readonly globalIds?: readonly string[];
}
interface NativeReportAsset {
  readonly fileName: string;
  readonly contentDigest: string;
  readonly bytes: number;
  readonly packIds: readonly string[];
  readonly kind: "chunk" | "css" | "asset";
  readonly unmapped?: boolean;
}
interface NativeReportDiagnosticSpan {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}
interface NativeReportDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly start?: number;
  readonly end?: number;
  readonly related?: readonly NativeReportDiagnosticSpan[];
  readonly fixHint?: string;
}
interface NativeReportClassAssignment {
  readonly stateId: string;
  readonly classNames: readonly string[];
}
interface NativeReportClassOptimality {
  readonly status: "optimal" | "unknown";
  readonly lowerBound: {
    readonly K: number;
    readonly T: number;
  };
  readonly upperBound: {
    readonly K: number;
    readonly T: number;
  };
  readonly candidateCount: number;
  readonly exploredNodes: number;
  readonly modelVersion: string;
}
/** Local structural representation of the schema-v1 native report. */
interface NativeReport {
  readonly schemaVersion: 1;
  readonly compilerVersion: string;
  readonly targetVersions: Readonly<Record<string, string>>;
  readonly modules: readonly NativeReportModule[];
  readonly owners: readonly NativeReportOwner[];
  readonly rules: readonly NativeReportRule[];
  readonly packs: readonly NativeReportPack[];
  readonly assets: readonly NativeReportAsset[];
  readonly diagnostics: readonly NativeReportDiagnostic[];
  readonly timings: Readonly<Record<string, number>>;
  readonly wholeSiteGuarantee: boolean;
  readonly unmanagedStylesheets: readonly string[];
  readonly duplicateDefinitionCount: number;
  readonly duplicatePayloadCount: number;
  readonly classCount: number;
  readonly classAssignments: readonly NativeReportClassAssignment[];
  readonly fixedClassCount: number;
  readonly classOptimality: NativeReportClassOptimality;
}
/** Result of validating unknown JSON against the report reader contract. */
interface NativeReportValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}
/** Thrown by {@link parseNativeReport} when a report is malformed. */
export declare class NativeReportValidationError extends TypeError {
  readonly errors: readonly string[];
  constructor(errors: readonly string[]);
}
interface NativeReportSummary {
  readonly schemaVersion: 1;
  readonly compilerVersion: string;
  readonly wholeSiteGuarantee: boolean;
  readonly packCount: number;
  readonly assetCount: number;
  readonly mappedAssetCount: number;
  readonly unmappedAssetCount: number;
  readonly ownerCount: number;
  readonly declarationCount: number;
  readonly classCount: number;
  readonly fixedClassCount: number;
  readonly diagnosticCount: number;
  readonly diagnosticsByCode: Readonly<Record<string, number>>;
  readonly unmanagedStylesheetCount: number;
  readonly duplicateDefinitionCount: number;
  readonly duplicatePayloadCount: number;
  readonly classOptimality: NativeReportClassOptimality;
  readonly failures: readonly string[];
}
/** One pack's owners, declarations, and final assets. */
interface NativeReportPackMapping {
  readonly packId: string;
  readonly ownerIds: readonly string[];
  readonly declarationIds: readonly string[];
  /** Final bundle file names whose asset record references this pack. */
  readonly assets: readonly string[];
}
/** Validate unknown report data without changing or enriching its guarantee. */
export declare function validateNativeReport(value: unknown): NativeReportValidationResult;
/** Parse and validate a schema-v1 native report. */
export declare function parseNativeReport(value: unknown): NativeReport;
/** Alias for callers that read an already-parsed JSON value. */
export declare function readNativeReport(value: unknown): NativeReport;
/** Type guard for integrations that prefer a non-throwing check. */
export declare function isNativeReport(value: unknown): value is NativeReport;
/**
 * Assert the release gate represented by a native report. The returned value
 * is the validated report so a CLI can parse and gate it in one expression.
 */
export declare function assertNativeGuarantee(value: unknown): NativeReport;
/** Build a compact, deterministic summary for terminal or CI output. */
export declare function summarizeNativeReport(report: NativeReport): NativeReportSummary;
/** Human-readable summary including the reasons a report cannot be released. */
export declare function formatNativeReportSummary(report: NativeReport): string;
/** Map each pack to its owners, declarations, and final bundle assets. */
export declare function mapNativeReportPacks(report: NativeReport): readonly NativeReportPackMapping[];
/** Human-readable form of {@link mapNativeReportPacks}. */
export declare function formatNativePackMappings(report: NativeReport): string;
//#endregion
//#region src/index.d.ts
export interface AtomReport {
  readonly atomId: string;
  readonly semantic: string;
  readonly usedBy: readonly string[];
  readonly routes: readonly string[];
  readonly chunk: string | null;
  readonly sources: readonly string[];
}
export declare function formatAtomReport(report: AtomReport): string;
/** graph + manifest から atom の所属情報を収集する。sources 明示時はそれを優先する。 */
export declare function buildAtomReport(input: {
  readonly atomId: string;
  readonly semantic: string;
  readonly graph: UsageGraph;
  readonly manifest: StyleManifest | null;
  readonly sources?: readonly string[] | undefined;
}): AtomReport;
/** manifest の 1 行サマリ: route 数とユニーク asset 数。 */
export declare function summarizeManifest(manifest: StyleManifest): string;
/**
 * residual の説明行 (plan.md §59)。
 * 例: `button.css:34\nnot atomicized:\n  shorthand/longhand ordering dependency`
 */
export declare function formatResidualReport(residual: ResidualRuleNode): string;
/** residual 群の 1 行サマリ: 件数と理由別の内訳 (reason asc)。 */
export declare function summarizeResiduals(residuals: readonly ResidualRuleNode[]): string;
interface LegacyStyleUsageLike {
  readonly module: string;
  readonly hook: "global" | "scoped";
  readonly local: string;
  readonly cssPath: string | null;
}
/**
 * legacy hook 利用の一覧 (plan.md §24)。Qwik lifecycle に残すため rewrite しない旨も示す。
 * @qstyle/vite への依存を作らないよう構造的部分型で受ける。
 */
export declare function formatLegacyReport(usages: readonly LegacyStyleUsageLike[]): string;
/** chunk の route 分類 (R2)。usage graph の逆引きで 1 route → route-local / 複数 → shared。 */
export type ChunkClassification = "route-local" | "shared" | "unrouted";
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
export declare function buildChunkReport(input: {
  readonly backend: string;
  readonly chunks: readonly {
    readonly fileName: string;
    readonly bytes: number;
    readonly classification?: string | undefined;
    readonly routes?: readonly string[] | undefined;
    /** members は配列 (CssAssetChunk) でも件数 (事前集計) でもよい。 */
    readonly members: readonly unknown[] | number;
  }[];
}): ChunkReport;
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
export declare function formatChunkReport(report: ChunkReport): string;
//#endregion
export type { NativeReport, NativeReportAsset, NativeReportClassAssignment, NativeReportClassOptimality, NativeReportDiagnostic, NativeReportDiagnosticSpan, NativeReportModule, NativeReportOwner, NativeReportPack, NativeReportPackMapping, NativeReportRule, NativeReportSummary, NativeReportValidationResult };
//# sourceMappingURL=index.d.mts.map