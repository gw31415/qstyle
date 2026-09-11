#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

const scriptPath = fileURLToPath(import.meta.url);
const fixtureRoot = dirname(scriptPath);
const outputPath = process.env.HEAD_PERFORMANCE_OUTPUT ?? '/private/tmp/qstyle-named-buffer-performance.json';
const payloadSizes = [256 * 1024, 4 * 1024 * 1024];
const modes = ['direct', 'head'];
const warmups = 2;
const samples = 10;

function quantile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

function summary(records, key) {
  const values = records.map((record) => record[key]);
  return {
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
  };
}

function optionsFor(mode, stream) {
  const options = {
    manifest: {
      manifestHash: 'head-performance',
      mapping: {},
      symbols: {},
      bundles: {},
      injections: [],
    },
    preloader: false,
    stream,
  };
  if (mode === 'direct') {
    // Keep the control on direct in-order writes while the experimental
    // suspense flag is enabled for the same process.
    options.streaming = { inOrder: { strategy: 'direct' }, outOfOrder: false };
  } else {
    // The non-invasive wrapper requires a complete, in-order HTML document.
    options.stylePlacement = 'head';
    options.streaming = { outOfOrder: false };
  }
  return options;
}

function documentFor(jsx, Fragment, payloadBytes) {
  const payload = 'x'.repeat(payloadBytes);
  const delayed = new Promise((resolveValue) => {
    setTimeout(() => resolveValue(jsx('p', { children: 'delayed-child' })), 25);
  });
  return jsx(Fragment, {
    children: [
      jsx('head', { children: jsx('title', { children: 'head-performance' }) }),
      jsx('body', {
        children: [jsx('main', { children: payload }), delayed],
      }),
    ],
  });
}

async function runWorker(mode, payloadBytes) {
  globalThis.__EXPERIMENTAL__ = { suspense: true, errorBoundary: false };
  globalThis.__QWIK_MANIFEST__ = {
    manifestHash: 'head-performance',
    mapping: {},
    symbols: {},
    bundles: {},
    injections: [],
  };
  const { jsx, Fragment } = await import('@qwik.dev/core');
  const { renderToStream: nativeRenderToStream } = await import('@qwik.dev/core/server');
  const { renderToStream: renderToStreamWithHeadStyles } = await import('../../packages/qwik/dist/server.mjs');
  const renderToStream = mode === 'head' ? renderToStreamWithHeadStyles : nativeRenderToStream;
  const records = [];

  async function renderOnce(withSanity = false) {
    const chunks = [];
    let firstWriteMs = null;
    let writes = 0;
    const startedAt = process.hrtime.bigint();
    const stream = {
      write(chunk) {
        if (firstWriteMs === null) {
          firstWriteMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        }
        writes += 1;
        chunks.push(chunk);
      },
    };
    const before = process.memoryUsage();
    const result = await renderToStream(documentFor(jsx, Fragment, payloadBytes), optionsFor(mode, stream));
    const finishedAt = process.hrtime.bigint();
    const after = process.memoryUsage();
    const htmlBytes = chunks.reduce((total, chunk) => total + Buffer.byteLength(String(chunk)), 0);
    const record = {
      firstWriteMs,
      totalMs: Number(finishedAt - startedAt) / 1e6,
      bytes: htmlBytes,
      flushes: result.flushes,
      writes,
      rssDeltaBytes: after.rss - before.rss,
      heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
      reportedSize: result.size,
    };
    if (withSanity) {
      const html = chunks.join('');
      record.sha256 = createHash('sha256').update(html).digest('hex');
      // Qwik assigns a random container instance per render. Mask that
      // runtime nonce before comparing otherwise equivalent output modes.
      const normalizedHtml = html.replace(/\bq:instance="[^"]*"/g, 'q:instance="<instance>"');
      record.normalizedSha256 = createHash('sha256').update(normalizedHtml).digest('hex');
      record.semantic = {
        hasDoctype: html.startsWith('<!DOCTYPE html>'),
        headCount: (html.match(/<head(?:\s|>)/g) ?? []).length,
        bodyCount: (html.match(/<body(?:\s|>)/g) ?? []).length,
        hasPayload: html.includes('x'.repeat(Math.min(payloadBytes, 64))),
        hasDelayedChild: html.includes('<p :>delayed-child</p>'),
        headBeforeBody: html.indexOf('<head') >= 0 && html.indexOf('<head') < html.indexOf('<body'),
      };
    }
    return record;
  }

  for (let index = 0; index < warmups; index += 1) await renderOnce();
  for (let index = 0; index < samples; index += 1) records.push(await renderOnce(index === 0));
  const output = JSON.stringify({ mode, payloadBytes, warmups, samples, records });
  await new Promise((resolveOutput) => process.stdout.write(output, resolveOutput));
  // The stock server runtime may retain a MessageChannel after rendering;
  // the worker must exit so the harness can proceed to the next isolated run.
  process.exit(0);
}

function runChild(mode, payloadBytes) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [scriptPath, '--worker', mode, String(payloadBytes)], {
      cwd: fixtureRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectChild);
    child.once('close', (code, signal) => {
      if (code !== 0) {
        rejectChild(new Error(`head-performance worker failed (${mode}, ${payloadBytes} bytes): exit=${code} signal=${signal ?? 'none'}\n${stderr}`));
        return;
      }
      try {
        resolveChild(JSON.parse(stdout));
      } catch (error) {
        rejectChild(new Error(`head-performance worker returned invalid JSON (${mode}, ${payloadBytes} bytes): ${error.message}\nstdout=${stdout}\nstderr=${stderr}`));
      }
    });
  });
}

async function runHarness() {
  const startedAt = new Date().toISOString();
  const runs = [];
  const failures = [];
  for (const payloadBytes of payloadSizes) {
    for (const mode of modes) {
      try {
        runs.push(await runChild(mode, payloadBytes));
      } catch (error) {
        failures.push({ mode, payloadBytes, message: error.message });
      }
    }
  }
  const validation = [];
  for (const payloadBytes of payloadSizes) {
    const pair = runs.filter((run) => run.payloadBytes === payloadBytes);
    const direct = pair.find((run) => run.mode === 'direct');
    const head = pair.find((run) => run.mode === 'head');
    if (!direct || !head) {
      validation.push({ payloadBytes, pass: false, message: 'missing direct/head pair' });
      continue;
    }
    const directFirst = direct.records[0];
    const headFirst = head.records[0];
    const sameBytes = directFirst.bytes === headFirst.bytes;
    const sameDigest = directFirst.normalizedSha256 === headFirst.normalizedSha256;
    const sameSemantics = JSON.stringify(directFirst.semantic) === JSON.stringify(headFirst.semantic);
    validation.push({ payloadBytes, pass: sameBytes && sameDigest && sameSemantics, sameBytes, sameDigest, sameSemantics });
  }
  const report = {
    benchmark: 'non-invasive head buffering and parse5 observation',
    startedAt,
    dependency: '@qwik.dev/core stock from fixtures/compiler-contract/node_modules',
    protocol: {
      experimental: { suspense: true, errorBoundary: false },
      manifest: 'empty source-level manifest; no CSS or QRL module loading',
      delayedPromiseMs: 25,
      payload: 'same html/head/body tree and body text for both modes',
    },
    warmups,
    samples,
    validation,
    failures,
    modes: runs.map((run) => ({
      mode: run.mode,
      payloadBytes: run.payloadBytes,
      summary: {
        firstWriteMs: summary(run.records, 'firstWriteMs'),
        totalMs: summary(run.records, 'totalMs'),
        bytes: summary(run.records, 'bytes'),
        flushes: summary(run.records, 'flushes'),
        writes: summary(run.records, 'writes'),
        rssDeltaBytes: summary(run.records, 'rssDeltaBytes'),
        heapUsedDeltaBytes: summary(run.records, 'heapUsedDeltaBytes'),
        reportedSize: summary(run.records, 'reportedSize'),
      },
      records: run.records,
    })),
    note: 'RSS and heap deltas are observational per-render deltas, not peak-memory guarantees; this report makes no performance acceptance claim.',
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ outputPath, runs: report.modes.map(({ mode, payloadBytes, summary: runSummary }) => ({ mode, payloadBytes, firstWriteMs: runSummary.firstWriteMs, totalMs: runSummary.totalMs, bytes: runSummary.bytes, flushes: runSummary.flushes })) })}\n`);
  if (failures.length || validation.some((check) => !check.pass)) process.exitCode = 1;
}

if (process.argv[2] === '--worker') {
  const mode = process.argv[3];
  const payloadBytes = Number(process.argv[4]);
  if (!modes.includes(mode) || !Number.isSafeInteger(payloadBytes) || payloadBytes <= 0) {
    throw new Error('Usage: head-performance.mjs --worker <direct|head> <positive-payload-bytes>');
  }
  await runWorker(mode, payloadBytes);
} else {
  await runHarness();
}
