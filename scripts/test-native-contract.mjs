#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const fixtureRoot = path.join(repoRoot, 'fixtures', 'native-contract');
const nodePath = process.execPath;
const port = process.env.NATIVE_CONTRACT_PORT ?? '4181';
const baseUrl = `http://127.0.0.1:${port}`;

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: fixtureRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function assertCheck(checks, name, pass, details) {
  checks.push({ name, pass, ...(details ? { details } : {}) });
}

const build = await run(nodePath, ['scripts/build.mjs']);
if (build.code !== 0) {
  process.stderr.write(build.stdout);
  process.stderr.write(build.stderr);
  throw new Error(`native contract build failed with exit code ${String(build.code)}`);
}

const server = spawn(nodePath, [process.env.NATIVE_CONTRACT_SSG ? 'scripts/serve-static.mjs' : 'server/entry.node-server.js'], {
  cwd: fixtureRoot,
  env: { ...process.env, PORT: port },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk;
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk;
});

async function stopServer() {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'close'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}

try {
  const readyDeadline = Date.now() + 5000;
  while (Date.now() < readyDeadline) {
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) break;
    } catch {
      // Wait for the generated server bundle to begin listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const probe = await run(nodePath, ['scripts/probe.mjs'], { BASE_URL: baseUrl });
  if (probe.code !== 0) {
    process.stderr.write(probe.stdout);
    process.stderr.write(probe.stderr);
    throw new Error(`native contract browser probe failed with exit code ${String(probe.code)}`);
  }

  const result = JSON.parse(probe.stdout);
  const checks = [];
  const routeStyleCount = process.env.QSTYLE_ADAPTER_FOUNDATION ? 1 : 0;
  if (process.env.QSTYLE_ADAPTER_FOUNDATION) assertCheck(checks,
    'route-only utility is absent initially and compiled on SPA navigation', result.routeB.routePadding === '23px'
      && !result.initial.styleTexts.some((text) => text.includes('padding-top:23px'))
      && result.routeB.styleTexts.filter((text) => text.includes('padding-top:23px')).length === 1,
    { paddingTop: result.routeB.routePadding });
  if (process.env.NATIVE_CONTRACT_SSG && process.env.QSTYLE_ADAPTER_FOUNDATION) {
    const pages = await Promise.all(['/', '/route-b/'].map(async (route) => {
      const response = await fetch(`${baseUrl}${route}`);
      const html = await response.text();
      const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/)?.[1] ?? '';
      return { route, status: response.status,
        foundationHeadCount: [...head.matchAll(/--native-foundation:/g)].length,
        foundationTotalCount: [...html.matchAll(/--native-foundation:/g)].length,
        routeUtilityCount: [...html.matchAll(/padding-top:23px/g)].length,
        lazyAbsent: !html.includes('.native-lazy') };
    }));
    assertCheck(checks, 'every generated SSG document contains exactly one head foundation and no lazy CSS',
      pages.every((page) => page.status === 200 && page.foundationHeadCount === 1
        && page.foundationTotalCount === 1 && page.lazyAbsent), pages);
    assertCheck(checks, 'SSG includes route-only CSS exclusively on the matching page',
      pages.every((page) => page.routeUtilityCount === (page.route === '/route-b/' ? 1 : 0)), pages);
  }
  const initialSharedId = result.ssrStyles.find(({ text }) => text.includes('.native-shared'))?.id;
  const sharedBodyCount = (state) => state.sharedCssResponses.length;
  const lazyBodyCount = (state) => state.lazyCssResponses.length;
  const afterSharedBodies = sharedBodyCount(result.afterSharedResponses) - sharedBodyCount(result.initialResponses);
  const routeBSharedBodies = sharedBodyCount(result.routeBResponses) - sharedBodyCount(result.afterSharedResponses);
  const routeAAgainSharedBodies = sharedBodyCount(result.routeAAgainResponses) - sharedBodyCount(result.routeBResponses);
  const initialLazyBodies = lazyBodyCount(result.initialResponses);
  const afterLazyBodies = lazyBodyCount(result.afterLazyResponses) - lazyBodyCount(result.afterSharedResponses);

  if (process.env.QSTYLE_ADAPTER_FOUNDATION) assertCheck(
    checks,
    `${process.env.NATIVE_CONTRACT_SSG ? 'SSG' : 'Node'} adapter resolves the document foundation and preserves it across SPA routes`,
    result.ssrFoundationHeadCount === 1
      && [result.initial, result.routeB, result.routeAAgain, result.afterSharedInstance, result.afterLazy]
        .every((state) => state.foundationHeadCount === 1 && state.foundationValue === 'rgb(17,34,51)'),
    { ssrFoundationHeadCount: result.ssrFoundationHeadCount,
      values: [result.initial, result.routeB, result.routeAAgain].map((state) => state.foundationValue) },
  );

  assertCheck(
    checks,
    'initial SSR inlines one shared pack style ID',
    result.ssrStyles.filter(({ text }) => text.includes('.native-shared')).length === 1
      && result.initial.styleIds.filter((id) => id === initialSharedId).length === 1,
    { ssrStyles: result.ssrStyles, styleIds: result.initial.styleIds },
  );
  assertCheck(
    checks,
    'initial shared computed style is correct',
    result.initial.sharedColor === 'rgb(12, 34, 56)',
    { sharedColor: result.initial.sharedColor },
  );
  assertCheck(
    checks,
    'equal CSS literals in independent components remain two definitions',
    result.initial.styleTexts.filter((text) => text.includes('.native-identical')).length === 2
      && result.initial.identicalColor === 'rgb(78, 90, 12)',
    { styleTexts: result.initial.styleTexts, identicalColor: result.initial.identicalColor },
  );
  assertCheck(
    checks,
    'lazy CSS is absent from initial HTML/CSSOM and CSS QRL responses',
    result.ssrHasLazyClass === false
      && result.initial.htmlHasLazyClass === false
      && result.initial.cssomHasLazyRule === false
      && initialLazyBodies === 0,
    { ssrHasLazyClass: result.ssrHasLazyClass, initial: result.initial, initialLazyBodies },
  );
  assertCheck(
    checks,
    'SPA A to B does not refetch the inlined shared CSS QRL',
    routeBSharedBodies === 0 && result.routeB.styleCount === result.initial.styleCount + routeStyleCount,
    { routeBSharedBodies, initialStyleCount: result.initial.styleCount, routeBStyleCount: result.routeB.styleCount },
  );
  assertCheck(
    checks,
    'SPA B to A reuses the shared CSS without refetch or duplicate style',
    routeAAgainSharedBodies === 0
      && result.routeAAgain.styleCount === result.routeB.styleCount
      && result.routeAAgain.sharedColor === 'rgb(12, 34, 56)',
    { routeAAgainSharedBodies, routeAAgain: result.routeAAgain },
  );
  assertCheck(
    checks,
    'new shared pack instance after click has no CSS QRL refetch or style insertion',
    afterSharedBodies === 0
      && result.afterSharedInstance.styleCount === result.initial.styleCount,
    {
      afterSharedBodies,
      sharedCssResponses: result.afterSharedResponses.sharedCssResponses,
      beforeStyleCount: result.initial.styleCount,
      afterStyleCount: result.afterSharedInstance.styleCount,
    },
  );
  assertCheck(
    checks,
    'lazy unique pack resolves once on first render and computes correctly',
    afterLazyBodies === 1
      && result.afterLazy.styleCount === result.routeAAgain.styleCount + 1
      && result.afterLazy.lazyBackground === 'rgb(230, 240, 255)'
      && result.afterLazy.lazyBorderTop === '2px',
    { afterLazyBodies, afterLazy: result.afterLazy },
  );

  assertCheck(checks, 'all observed native style IDs stay unique',
    [result.initial, result.afterSharedInstance, result.routeB, result.routeAAgain, result.afterLazy]
      .every((state) => new Set(state.styleIds).size === state.styleIds.length));

  const failures = checks.filter(({ pass }) => !pass);
  console.log(JSON.stringify({ ...result, checks }, null, 2));
  if (failures.length > 0) {
    console.error('\nNative contract failures:');
    for (const failure of failures) {
      console.error(`- ${failure.name}: ${JSON.stringify(failure.details)}`);
    }
    console.error(
      '\nThe shared CSS refetch failures are expected against stock @qwik.dev/core beta.43 until its style-QRL lookup moves before resolve().',
    );
    process.exitCode = 1;
  }
} finally {
  await stopServer();
  if (serverOutput && server.exitCode !== 0) process.stderr.write(serverOutput);
}
