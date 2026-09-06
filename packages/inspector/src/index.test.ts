import { describe, expect, it } from 'vitest';
import {
  VERSION,
  assetFileName,
  buildRouteManifest,
  createUsageGraph,
  recordComponentRoute,
  recordSource,
  recordUsage,
  routeSignature,
} from '@qstyle/core';
import {
  buildAtomReport,
  buildChunkReport,
  formatAtomReport,
  formatChunkReport,
  formatLegacyReport,
  formatResidualReport,
  summarizeManifest,
  summarizeResiduals,
} from './index.js';

describe('inspector', () => {
  it('formats atom report', () => {
    const out = formatAtomReport({
      atomId: 'q_a81d',
      semantic: 'display:flex',
      usedBy: ['Button'],
      routes: ['/'],
      chunk: 'style.71bc9.css',
      sources: ['button.tsx:42'],
    });
    expect(out).toContain('Atom: q_a81d');
    expect(out).toContain('style.71bc9.css');
  });

  it('builds an atom report from the usage graph and manifest', () => {
    const graph = createUsageGraph();
    recordUsage(graph, 'q_a81d', 'Button');
    recordUsage(graph, 'q_a81d', 'Card');
    recordComponentRoute(graph, 'Button', '/');
    recordComponentRoute(graph, 'Card', '/about');
    const manifest = buildRouteManifest(
      new Map([
        ['/', [assetFileName('base', 'q_dead')]],
        ['/about', [assetFileName('base', 'q_dead'), 'base.q_a81d.css']],
      ]),
      { compilerVersion: VERSION },
    );

    const report = buildAtomReport({
      atomId: 'q_a81d',
      semantic: 'display:flex',
      graph,
      manifest,
    });
    expect(report.usedBy).toEqual(['Button', 'Card']);
    expect(report.routes).toEqual(['/', '/about']);
    expect(report.chunk).toBe('base.q_a81d.css');
    expect(report.sources).toEqual([]);

    const out = formatAtomReport(report);
    expect(out).toContain('Atom: q_a81d');
    expect(out).toContain('  /about');
    expect(out).toContain('Chunk: base.q_a81d.css');
  });

  it('resolves provenance sources from the usage graph', () => {
    const graph = createUsageGraph();
    recordUsage(graph, 'q_a81d', 'Button');
    recordSource(graph, 'q_a81d', '/src/button.tsx');
    recordSource(graph, 'q_a81d', '/src/card.tsx');
    const report = buildAtomReport({
      atomId: 'q_a81d',
      semantic: 'display:flex',
      graph,
      manifest: null,
    });
    expect(report.sources).toEqual(['/src/button.tsx', '/src/card.tsx']);
    const out = formatAtomReport(report);
    expect(out).toContain('/src/button.tsx');
  });

  it('reports an unassigned chunk when the manifest is null or lacks the atom', () => {
    const graph = createUsageGraph();
    const manifest = buildRouteManifest(new Map([['/', [assetFileName('base', 'q_dead')]]]), {
      compilerVersion: VERSION,
    });

    const nullManifest = buildAtomReport({
      atomId: 'q_a81d',
      semantic: 'display:flex',
      graph,
      manifest: null,
    });
    expect(nullManifest.chunk).toBeNull();

    const missing = buildAtomReport({
      atomId: 'q_a81d',
      semantic: 'display:flex',
      graph,
      manifest,
    });
    expect(missing.chunk).toBeNull();
  });

  it('summarizes a manifest as one line', () => {
    const manifest = buildRouteManifest(
      new Map([
        ['/', [assetFileName('base', 'q_dead'), 'base.q_a81d.css']],
        ['/about', [assetFileName('base', 'q_dead')]],
      ]),
      { compilerVersion: VERSION },
    );
    expect(summarizeManifest(manifest)).toBe('routes: 2, assets: 2');
    expect(summarizeManifest(buildRouteManifest(new Map(), { compilerVersion: VERSION }))).toBe(
      'routes: 0, assets: 0',
    );
  });

  it('explains residuals with reason and origin (§59)', () => {
    const out = formatResidualReport({
      kind: 'residual-rule',
      cssText: '& > svg',
      scope: 'component',
      reason: 'unsupported-selector',
      provenance: [{ source: '/src/button.tsx', line: 1, column: 1 }],
    });
    expect(out).toContain('/src/button.tsx');
    expect(out).toContain('not atomicized:');
    expect(out).toContain('unsupported-selector');
  });

  it('summarizes residuals by reason', () => {
    expect(summarizeResiduals([])).toBe('residuals: 0');
    expect(
      summarizeResiduals([
        {
          kind: 'residual-rule',
          cssText: 'a',
          scope: 'component',
          reason: 'unsupported-selector',
          provenance: [],
        },
        {
          kind: 'residual-rule',
          cssText: 'b',
          scope: 'component',
          reason: 'unsupported-value',
          provenance: [],
        },
        {
          kind: 'residual-rule',
          cssText: 'c',
          scope: 'component',
          reason: 'unsupported-selector',
          provenance: [],
        },
      ]),
    ).toBe('residuals: 3 (unsupported-selector x2, unsupported-value x1)');
  });

  it('lists legacy hook usages (§24)', () => {
    expect(formatLegacyReport([])).toContain('none');
    expect(
      formatLegacyReport([
        { module: '/src/b.tsx', hook: 'scoped', local: 'legacy', cssPath: './b.css?inline' },
        { module: '/src/a.tsx', hook: 'global', local: 'theme', cssPath: null },
      ]),
    ).toBe(
      [
        'legacy styles (preserved in Qwik lifecycle):',
        '  /src/a.tsx: global(theme)',
        '  /src/b.tsx: scoped(legacy) <- ./b.css?inline',
      ].join('\n'),
    );
  });

  describe('chunk report (R1.8 / R2)', () => {
    /** css-asset backend の __chunkPlans 相当 (fileName × bytes × classification × routes × members)。 */
    const planLike = [
      {
        id: 'pack_000001',
        members: ['q_a', 'q_b'],
        bytes: 312,
        fileName: 'assets/qstyle.q_a1b2c3d4.css',
        cssText: '...',
        classification: 'route-local' as const,
        routes: ['/'],
      },
      {
        id: 'pack_000002',
        members: ['q_c', 'q_d', 'q_e'],
        bytes: 768,
        fileName: 'assets/qstyle.q_e5f6a7b8.css',
        cssText: '...',
        classification: 'shared' as const,
        routes: ['/about', '/'],
      },
    ];

    it('builds a sorted chunk report with backend, classification, routes and member counts', () => {
      const report = buildChunkReport({ backend: 'css-asset', chunks: planLike });
      expect(report.backend).toBe('css-asset');
      expect(report.chunks).toHaveLength(2);
      // fileName 昇順で決定的に並ぶ。routes は sort 済み。
      expect(report.chunks.map((c) => c.fileName)).toEqual([
        'assets/qstyle.q_a1b2c3d4.css',
        'assets/qstyle.q_e5f6a7b8.css',
      ]);
      const shared = report.chunks[1];
      expect(shared?.classification).toBe('shared');
      expect(shared?.routes).toEqual(['/', '/about']);
      expect(shared?.members).toBe(3);
      const local = report.chunks[0];
      expect(local?.classification).toBe('route-local');
      expect(local?.members).toBe(2);
    });

    it('normalizes missing classification/routes and numeric member counts', () => {
      const report = buildChunkReport({
        backend: 'qwik-native',
        chunks: [{ fileName: 'x.css', bytes: 10, members: 7 }],
      });
      expect(report.chunks[0]?.classification).toBe('unrouted');
      expect(report.chunks[0]?.routes).toEqual([]);
      expect(report.chunks[0]?.members).toBe(7);
    });

    it('formats the report as a readable table (backend 種別 + chunk 表)', () => {
      const out = formatChunkReport(buildChunkReport({ backend: 'css-asset', chunks: planLike }));
      const lines = out.split('\n');
      expect(lines[0]).toBe('chunk report (backend: css-asset, chunks: 2)');
      expect(out).toContain('assets/qstyle.q_a1b2c3d4.css');
      expect(out).toContain('bytes: 312');
      expect(out).toContain('route-local');
      expect(out).toContain('routes: /');
      expect(out).toContain('shared');
      expect(out).toContain('routes: /, /about');
      expect(out).toContain('units: 3');
    });

    it('formats an empty plan without chunk rows', () => {
      const out = formatChunkReport(buildChunkReport({ backend: 'css-asset', chunks: [] }));
      expect(out).toBe('chunk report (backend: css-asset, chunks: 0)');
    });

    it('classifies units from the usage graph consistently with the planner wiring (R2)', () => {
      // vite plugin の classifyChunkUnits と同じ逆引きが graph から組めることの inspector 側証明:
      // report の routes は core の routeSignature (sorted union) と一致する。
      const graph = createUsageGraph();
      recordUsage(graph, 'q_a', 'home.tsx');
      recordUsage(graph, 'q_b', 'shared.tsx');
      recordUsage(graph, 'q_c', 'shared.tsx');
      recordComponentRoute(graph, 'home.tsx', '/');
      recordComponentRoute(graph, 'shared.tsx', '/');
      recordComponentRoute(graph, 'shared.tsx', '/about');
      const report = buildChunkReport({
        backend: 'css-asset',
        chunks: [
          {
            fileName: 'assets/qstyle.q_local.css',
            bytes: 40,
            classification: 'route-local',
            routes: routeSignature(graph, 'q_a'),
            members: ['q_a'],
          },
          {
            fileName: 'assets/qstyle.q_shared.css',
            bytes: 80,
            classification: 'shared',
            routes: routeSignature(graph, 'q_b'),
            members: ['q_b', 'q_c'],
          },
        ],
      });
      expect(report.chunks[0]?.routes).toEqual(['/']);
      expect(report.chunks[1]?.routes).toEqual(['/', '/about']);
    });
  });
});
