#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { assertNativeGuarantee, formatNativeReportSummary } from '../packages/inspector/dist/index.mjs';

const arguments_ = process.argv.slice(2).filter((argument) => argument !== '--');
if (arguments_.length !== 1) {
  console.error('Usage: pnpm check:native-report <qstyle-report.json>');
  process.exitCode = 2;
} else {
  try {
    const report = assertNativeGuarantee(JSON.parse(await readFile(arguments_[0], 'utf8')));
    console.log(formatNativeReportSummary(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
