import { describe, expect, it } from 'vitest';
import {
  IMMUTABLE_CACHE_HEADER,
  assetFileName,
  buildRouteManifest,
  chunkHash,
  parseManifest,
  resolveRouteAssets,
  serializeManifest,
} from './manifest.js';

describe('chunkHash', () => {
  it('is 8-hex prefixed with q_ (§42)', () => {
    expect(chunkHash('.a{color:red}')).toMatch(/^q_[0-9a-f]{8}$/);
  });

  it('is deterministic for identical bytes', () => {
    expect(chunkHash('.a{color:red}')).toBe(chunkHash('.a{color:red}'));
  });

  it('changes on any content byte change (HASH-012)', () => {
    expect(chunkHash('.a{color:red}')).not.toBe(chunkHash('.a{color:green}'));
    expect(chunkHash('.a{color:red}')).not.toBe(chunkHash('.a{ color:red}'));
  });

  it('is computed over the serialized css text only, not membership (§43)', () => {
    // 同じ最終 bytes なら同名。member 構成が違っても hash は変わらない。
    expect(chunkHash('.a{color:red}\n.b{color:blue}\n')).toBe(
      chunkHash('.a{color:red}\n.b{color:blue}\n'),
    );
  });
});

describe('assetFileName', () => {
  it('joins prefix, hash and .css extension (§42)', () => {
    expect(assetFileName('base', 'q_81adbeef')).toBe('base.q_81adbeef.css');
    expect(assetFileName('route-home', chunkHash('x'))).toMatch(/^[^.]+\.[^.]+\.css$/);
  });
});

describe('IMMUTABLE_CACHE_HEADER', () => {
  it('matches the §50 policy', () => {
    expect(IMMUTABLE_CACHE_HEADER).toBe('public, max-age=31536000, immutable');
  });
});

describe('buildRouteManifest', () => {
  it('sorts entries by route and dedupes + sorts assets', () => {
    const manifest = buildRouteManifest(
      new Map<string, readonly string[]>([
        ['/settings', ['settings.q_bb.css', 'base.q_aa.css', 'settings.q_bb.css']],
        ['/', ['base.q_aa.css']],
      ]),
      { compilerVersion: '0.1.0' },
    );
    expect(manifest.version).toBe(1);
    expect(manifest.entries.map((entry) => entry.route)).toEqual(['/', '/settings']);
    expect(manifest.entries[1]?.assets).toEqual(['base.q_aa.css', 'settings.q_bb.css']);
  });

  it('is independent of map insertion order', () => {
    const a = buildRouteManifest(
      new Map<string, readonly string[]>([
        ['/b', ['b.q_1.css']],
        ['/a', ['a.q_1.css']],
      ]),
      { compilerVersion: 'v' },
    );
    const b = buildRouteManifest(
      new Map<string, readonly string[]>([
        ['/a', ['a.q_1.css']],
        ['/b', ['b.q_1.css']],
      ]),
      { compilerVersion: 'v' },
    );
    expect(serializeManifest(a)).toBe(serializeManifest(b));
  });

  it('gives no entry to a route with no qstyle assets (RTE-008)', () => {
    const manifest = buildRouteManifest(
      new Map<string, readonly string[]>([
        ['/plain', []],
        ['/styled', ['a.q_1.css']],
      ]),
      { compilerVersion: 'v' },
    );
    expect(manifest.entries.map((entry) => entry.route)).toEqual(['/styled']);
  });

  it('gives empty entries for an empty routes map (RTE-008)', () => {
    expect(buildRouteManifest(new Map<string, readonly string[]>(), { compilerVersion: 'v' })).toEqual({
      version: 1,
      compilerVersion: 'v',
      entries: [],
    });
  });

  it('records the compiler version (HASH-011)', () => {
    expect(buildRouteManifest(new Map<string, readonly string[]>(), { compilerVersion: '9.9.9' }).compilerVersion).toBe(
      '9.9.9',
    );
  });
});

describe('serializeManifest / parseManifest', () => {
  it('roundtrips byte-stably', () => {
    const manifest = buildRouteManifest(
      new Map<string, readonly string[]>([
        ['/settings', ['forms.q_c.css', 'base.q_a.css']],
        ['/', ['base.q_a.css']],
      ]),
      { compilerVersion: '0.1.0' },
    );
    const parsed = parseManifest(serializeManifest(manifest));
    expect(parsed).toEqual(manifest);
    expect(serializeManifest(parsed as NonNullable<typeof parsed>)).toBe(serializeManifest(manifest));
  });

  it('uses a 2-space indented, fixed key order', () => {
    const text = serializeManifest({
      version: 1,
      compilerVersion: 'v',
      entries: [{ route: '/', assets: ['a.q_1.css'] }],
    });
    expect(text.split('\n')).toEqual([
      '{',
      '  "version": 1,',
      '  "compilerVersion": "v",',
      '  "entries": [',
      '    {',
      '      "route": "/",',
      '      "assets": [',
      '        "a.q_1.css"',
      '      ]',
      '    }',
      '  ]',
      '}',
    ]);
  });

  it('returns null on garbage (FLB-007)', () => {
    for (const text of ['', 'not json', '[]', '{}', '{"version":1}']) {
      expect(parseManifest(text)).toBeNull();
    }
  });

  it('rejects wrong version, missing compilerVersion and malformed entries', () => {
    const cases: unknown[] = [
      { version: 2, compilerVersion: 'v', entries: [] },
      { version: 1, entries: [] },
      { version: 1, compilerVersion: 1, entries: [] },
      { version: 1, compilerVersion: 'v', entries: {} },
      { version: 1, compilerVersion: 'v', entries: [{ route: '/' }] },
      { version: 1, compilerVersion: 'v', entries: [{ route: '/', assets: 'a.css' }] },
      { version: 1, compilerVersion: 'v', entries: [{ route: '/', assets: [1] }] },
      { version: 1, compilerVersion: 'v', entries: ['nope'] },
    ];
    for (const value of cases) {
      expect(parseManifest(JSON.stringify(value))).toBeNull();
    }
  });
});

describe('resolveRouteAssets', () => {
  it('returns sorted assets for a known route and [] for unknown routes', () => {
    const manifest = buildRouteManifest(
      new Map<string, readonly string[]>([
        ['/', ['base.q_aa.css']],
        ['/settings', ['settings.q_bb.css', 'base.q_aa.css']],
      ]),
      { compilerVersion: 'test' },
    );
    expect(resolveRouteAssets(manifest, '/settings')).toEqual(['base.q_aa.css', 'settings.q_bb.css']);
    expect(resolveRouteAssets(manifest, '/missing')).toEqual([]);
  });
});
