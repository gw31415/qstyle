import { describe, expect, it } from 'vitest';
import {
  VERSION,
  assetFileName,
  buildRouteManifest,
  createUsageGraph,
  recordComponentRoute,
  recordSource,
  recordUsage,
} from '@qstyle/core';
import { buildAtomReport, formatAtomReport, formatLegacyReport, formatResidualReport, summarizeManifest, summarizeResiduals } from './index.js';

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
});
