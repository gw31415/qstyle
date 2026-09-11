import { parse } from '@babel/parser';
import traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { NativeStyleError, type SourceSpan } from '@qstyle/core';

export interface ParsedStyleModule {
  readonly file: string;
  readonly code: string;
  readonly ast: t.File;
  readonly program: NodePath<t.Program>;
}

export function sourceSpan(file: string, node: t.Node): SourceSpan {
  return { file, start: node.start ?? 0, end: node.end ?? node.start ?? 0 };
}

/** Parsing never recovers to a partial AST: all syntax must be accounted for. */
export function parseStyleModule(code: string, file: string): ParsedStyleModule {
  let ast: t.File;
  try {
    ast = parse(code, {
      sourceType: 'module', sourceFilename: file,
      plugins: /\.[jt]sx(?:$|\?)/.test(file) ? ['typescript', 'jsx'] : ['typescript'], errorRecovery: false,
      createImportExpressions: true,
    });
  } catch (error) {
    const details = error as Error & { pos?: number };
    throw new NativeStyleError({
      code: 'QS1101', message: `Cannot parse style module: ${details.message}`,
      source: { file, start: details.pos ?? 0, end: (details.pos ?? 0) + 1 },
    });
  }
  let program: NodePath<t.Program> | undefined;
  traverse(ast, { Program(path) { program = path; path.stop(); } });
  if (!program) throw new NativeStyleError({ code: 'QS1101', message: `No program in ${file}.` });
  return { file, code, ast, program };
}
