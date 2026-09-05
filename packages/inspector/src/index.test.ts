import { describe, expect, it } from 'vitest';
import {
  VERSION,
  assetFileName,
  buildRouteManifest,
  createUsageGraph,
  recordComponentRoute,
  recordUsage,
} from '@qstyle/core';
import { buildAtomReport, formatAtomReport, summarizeManifest } from './index.js';

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
});
