import type { SourceSpan } from './native-ir.js';

export type NativeDiagnosticCode =
  | 'QS1001' | 'QS1101' | 'QS1102' | 'QS1103' | 'QS1201' | 'QS1301'
  | 'QS1401' | 'QS1501' | 'QS1601' | 'QS1602' | 'QS1603';

export interface NativeDiagnostic {
  readonly code: NativeDiagnosticCode;
  readonly message: string;
  readonly source?: SourceSpan;
  readonly related?: readonly SourceSpan[];
  readonly fixHint?: string;
}

export class NativeStyleError extends Error {
  readonly diagnostic: NativeDiagnostic;
  readonly code: NativeDiagnosticCode;

  constructor(diagnostic: NativeDiagnostic) {
    const location = diagnostic.source
      ? ` (${diagnostic.source.file}:${diagnostic.source.start})`
      : '';
    super(`[qstyle ${diagnostic.code}] ${diagnostic.message}${location}`);
    this.name = 'NativeStyleError';
    this.code = diagnostic.code;
    this.diagnostic = diagnostic;
  }
}
