import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as linksModule from './links.js';
import type * as prefetchModule from './prefetch.js';

/**
 * R1.4/R1.5/R1.7 の純関数・モジュール境界の unit test (plan.md §3.3)。
 *
 * component の full render (SSR/SSG で link が焼かれる、client navigation で注入
 * される等) は QWK-001..004 / RTE-004..007 相当として C0.1/C0.2 Playwright 基盤で
 * 検証する。ここでは qwik city 統合なしで検証できる部分のみ扱う:
 * - resolveRouteLinks: 完全一致 / trailing slash 吸収 / 不一致で空 / manifest が空
 * - manifest 取得: globalThis (__QSTYLE_ROUTES__, SSG in-process) 優先、
 *   fallback fetch (1 回 cache)、fetch 失敗で空 (crash しない)
 * - prefetch helper: 'hover' の pointerover 委譲、'load' の idle scheduling、
 *   'none' の no-op
 *
 * manifest fetch の cache は module singleton なため、vi.resetModules() を呼んだ上で
 * 動的 import により test ごとに新規 module instance を読む (client.test.ts と同じ規約)。
 */

const MANIFEST_A: linksModule.QstyleRouteManifest = {
  version: 1,
  entries: [
    { route: '/', assets: ['assets/qstyle.root.css'] },
    { route: '/a', assets: ['assets/qstyle.a.css', 'assets/qstyle.shared.css'] },
    { route: '/b/', assets: ['assets/qstyle.b.css'] },
  ],
};

interface TestLink {
  rel: string;
  href: string;
  dataset: Record<string, string>;
  getAttribute: (name: string) => string | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

interface TestDom {
  readonly links: TestLink[];
}

/** browser 相当の最小 DOM (client.test.ts と同じ規則) を globalThis に置く。 */
function installDom(): TestDom {
  const dom: TestDom = { links: [] };
  const documentStub = {
    baseURI: 'https://example.test/app/',
    querySelector: (selector: string): TestLink | null => {
      const m: RegExpMatchArray | null = /data-qstyle-href="([^"]*)"/.exec(selector);
      if (m === null) return null;
      const href: string = (m[1] ?? '').replace(/%22/g, '"');
      return dom.links.find((l) => l.href === href) ?? null;
    },
    querySelectorAll: (_selector: string): TestLink[] => dom.links,
    createElement: (): TestLink => {
      const link: TestLink = {
        rel: '',
        href: '',
        dataset: {},
        getAttribute: (name: string): string | null =>
          name === 'data-qstyle-href' ? (link.dataset['qstyleHref'] ?? null) : null,
        onload: null,
        onerror: null,
      };
      return link;
    },
    head: {
      appendChild: (link: TestLink): TestLink => {
        dom.links.push(link);
        queueMicrotask((): void => {
          link.onload?.();
        });
        return link;
      },
    },
  };
  vi.stubGlobal('document', documentStub);
  return dom;
}

/** fetch stub。qstyle.routes.json 相当の JSON を返す。 */
function installRoutesManifest(manifest: unknown): { fetchCalls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (input: unknown): Promise<{ ok: boolean; json: () => Promise<unknown> }> => {
    calls.push(String(input));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(manifest) });
  });
  return { fetchCalls: calls };
}

/** 新規 module instance の links exports を返す (manifest cache を test 間で隔離)。 */
async function freshLinks(): Promise<typeof linksModule> {
  vi.resetModules();
  return await import('./links.js');
}

/** 新規 module instance の prefetch exports。 */
async function freshPrefetch(): Promise<typeof prefetchModule> {
  vi.resetModules();
  return await import('./prefetch.js');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('resolveRouteLinks (R1.4 純関数)', () => {
  it('returns assets for an exact route match', async (): Promise<void> => {
    const links = await freshLinks();
    expect(links.resolveRouteLinks(MANIFEST_A, '/a')).toEqual([
      'assets/qstyle.a.css',
      'assets/qstyle.shared.css',
    ]);
  });

  it('absorbs trailing slash differences in both directions', async (): Promise<void> => {
    const links = await freshLinks();
    // manifest 側が slash なし / location 側が slash 付き
    expect(links.resolveRouteLinks(MANIFEST_A, '/a/')).toEqual([
      'assets/qstyle.a.css',
      'assets/qstyle.shared.css',
    ]);
    // manifest 側が slash 付き / location 側が slash なし
    expect(links.resolveRouteLinks(MANIFEST_A, '/b')).toEqual(['assets/qstyle.b.css']);
  });

  it("keeps '/' as '/'", async (): Promise<void> => {
    const links = await freshLinks();
    expect(links.resolveRouteLinks(MANIFEST_A, '/')).toEqual(['assets/qstyle.root.css']);
    // 空文字は '/' 扱い
    expect(links.resolveRouteLinks(MANIFEST_A, '')).toEqual(['assets/qstyle.root.css']);
  });

  it('returns an empty array for unknown routes (no prefix match)', async (): Promise<void> => {
    const links = await freshLinks();
    expect(links.resolveRouteLinks(MANIFEST_A, '/missing')).toEqual([]);
    // prefix match はしない (MVP は options.routes に正確な path を書く運用)
    expect(links.resolveRouteLinks(MANIFEST_A, '/a/b')).toEqual([]);
  });

  it('returns an empty array for an empty manifest', async (): Promise<void> => {
    const links = await freshLinks();
    expect(links.resolveRouteLinks({ version: 1, entries: [] }, '/a')).toEqual([]);
  });

  it('matches [param] patterns for dynamic routes (RTE-004)', async (): Promise<void> => {
    const links = await freshLinks();
    const manifest: linksModule.QstyleRouteManifest = {
      version: 1,
      entries: [{ route: '/item/[id]', assets: ['assets/qstyle.item.css'] }],
    };
    expect(links.resolveRouteLinks(manifest, '/item/42')).toEqual([
      'assets/qstyle.item.css',
    ]);
    expect(links.resolveRouteLinks(manifest, '/item/42/')).toEqual([
      'assets/qstyle.item.css',
    ]);
    // segment 数が違う・空 segment は不一致。exact があれば exact が勝つ。
    expect(links.resolveRouteLinks(manifest, '/item')).toEqual([]);
    expect(links.resolveRouteLinks(manifest, '/item/42/extra')).toEqual([]);
    expect(links.resolveRouteLinks(manifest, '/other/42')).toEqual([]);
    const mixed: linksModule.QstyleRouteManifest = {
      version: 1,
      entries: [
        { route: '/item/[id]', assets: ['assets/qstyle.pattern.css'] },
        { route: '/item/42', assets: ['assets/qstyle.exact.css'] },
      ],
    };
    expect(links.resolveRouteLinks(mixed, '/item/42')).toEqual(['assets/qstyle.exact.css']);
    expect(links.resolveRouteLinks(mixed, '/item/99')).toEqual(['assets/qstyle.pattern.css']);
  });
});

describe('parseRouteManifest', () => {
  it('parses the emitted manifest shape (extra fields ignored)', async (): Promise<void> => {
    const links = await freshLinks();
    const manifest = links.parseRouteManifest({
      version: 1,
      compilerVersion: '0.0.0',
      entries: [{ route: '/a', assets: ['assets/qstyle.a.css'] }],
    });
    expect(manifest).toEqual({
      version: 1,
      entries: [{ route: '/a', assets: ['assets/qstyle.a.css'] }],
    });
  });

  it('rejects malformed shapes without crashing', async (): Promise<void> => {
    const links = await freshLinks();
    expect(links.parseRouteManifest(null)).toBeNull();
    expect(links.parseRouteManifest('{"version":1}')).toBeNull();
    expect(links.parseRouteManifest({ version: 2, entries: [] })).toBeNull();
    expect(links.parseRouteManifest({ version: 1, entries: {} })).toBeNull();
    expect(links.parseRouteManifest({ version: 1, entries: [{ route: 1, assets: [] }] })).toBeNull();
    expect(links.parseRouteManifest({ version: 1, entries: [{ route: '/a', assets: [1] }] })).toBeNull();
  });
});

describe('manifest 取得と注入 (R1.5 module 境界)', () => {
  it('prefers globalThis.__QSTYLE_ROUTES__ (SSG in-process) without fetch', async (): Promise<void> => {
    const links = await freshLinks();
    const dom: TestDom = installDom();
    vi.stubGlobal('__QSTYLE_ROUTES__', MANIFEST_A);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const hrefs: readonly string[] = await links.loadRouteStyles('/a');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hrefs).toEqual([
      'https://example.test/assets/qstyle.a.css',
      'https://example.test/assets/qstyle.shared.css',
    ]);
    expect(dom.links).toHaveLength(2);
    expect(dom.links[0]?.rel).toBe('stylesheet');
    expect(dom.links[0]?.href).toBe('https://example.test/assets/qstyle.a.css');
  });

  it('falls back to fetching qstyle.routes.json once (cached across calls)', async (): Promise<void> => {
    const links = await freshLinks();
    const dom: TestDom = installDom();
    const { fetchCalls } = installRoutesManifest(MANIFEST_A);
    await links.loadRouteStyles('/a');
    await links.loadRouteStyles('/b');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toBe('https://example.test/qstyle.routes.json');
    expect(dom.links).toHaveLength(3);
  });

  it('resolves to an empty array (console.error only) when the fetch fails', async (): Promise<void> => {
    const links = await freshLinks();
    installDom();
    vi.stubGlobal('fetch', (): Promise<{ ok: boolean }> => Promise.resolve({ ok: false }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(links.loadRouteStyles('/a')).resolves.toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('resolves to an empty array when fetch rejects', async (): Promise<void> => {
    const links = await freshLinks();
    installDom();
    vi.stubGlobal('fetch', (): Promise<never> => Promise.reject(new Error('offline')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(links.loadRouteStyles('/a')).resolves.toEqual([]);
    errorSpy.mockRestore();
  });

  it('injects nothing for unknown routes but still caches the manifest', async (): Promise<void> => {
    const links = await freshLinks();
    const dom: TestDom = installDom();
    const { fetchCalls } = installRoutesManifest(MANIFEST_A);
    await expect(links.loadRouteStyles('/missing')).resolves.toEqual([]);
    expect(dom.links).toHaveLength(0);
    expect(fetchCalls).toHaveLength(1);
  });
});

interface FakeAnchor {
  readonly href: string | null;
  readonly handlers: Map<string, Array<(event: unknown) => void>>;
  addEventListener: (type: string, handler: (event: unknown) => void) => void;
  removeEventListener: (type: string, handler: (event: unknown) => void) => void;
  getAttribute: (name: string) => string | null;
}

function fakeAnchor(href: string | null): FakeAnchor {
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  const anchor: FakeAnchor = {
    href,
    handlers,
    addEventListener: (type: string, handler: (event: unknown) => void): void => {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    removeEventListener: (type: string, handler: (event: unknown) => void): void => {
      const list = handlers.get(type) ?? [];
      handlers.set(type, list.filter((h) => h !== handler));
    },
    getAttribute: (name: string): string | null => (name === 'href' ? href : null),
  };
  return anchor;
}

/** anchor 配列に付いた pointerover handler を発火させる。 */
function dispatchPointerover(anchor: FakeAnchor): void {
  for (const handler of anchor.handlers.get('pointerover') ?? []) {
    handler({ target: anchor });
  }
}

describe('QstyleLinks component (R1.4 module 境界)', () => {
  it('exports the component (module-level componentQrl wiring loads without $ APIs)', async (): Promise<void> => {
    // precompiled library pattern で書かれているため、module 評価時に optimizer 前提の
    // $ API が throw しない (component の full render は C0.1/C0.2 で検証)。
    const links = await freshLinks();
    expect(links.QstyleLinks).toBeTypeOf('function');
    expect(links.useQstyleRouteStyles).toBeTypeOf('function');
    expect(links.qstyleRouteBootstrap).toBeTypeOf('function');
  });

  it('qstyleRouteBootstrap is self-contained (Q14 guard: no module-scope references)', async (): Promise<void> => {
    // sync QRL は fn source が HTML に埋め込まれて resume される。module scope の
    // import / closure を参照すると client で名前解決できず crash する。
    const links = await freshLinks();
    const source: string = links.qstyleRouteBootstrap.toString();
    // marker 名の一致 (rename 時の silent break 防止。bootstrap は module const を
    // 参照できないため literal を持つ)。
    expect(source).toContain('qstyle:prefetch');
    for (const forbidden of [
      '_captures',
      'loadRouteStyles',
      'loadRouteManifest',
      'ensureStylesheet',
      'resolveAssetUrl',
      'prefetchRouteStyles',
      'clientBaseUrl',
      'parseRouteManifest',
      'resolveRouteLinks',
      'require(',
      'import(',
      'process.',
      '__QSTYLE_ROUTES__',
    ]) {
      expect(source, `forbidden reference: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('qstyleRouteBootstrap injects current route styles and follows pushState navigation', async (): Promise<void> => {
    const links = await freshLinks();
    interface StubLink {
      rel: string;
      href: string;
      onload: (() => void) | null;
      onerror: (() => void) | null;
      setAttribute: (name: string, value: string) => void;
      getAttribute: (name: string) => string | null;
    }
    const injected: StubLink[] = [];
    const makeLink = (): StubLink => {
      const attrs = new Map<string, string>();
      return {
        rel: '',
        href: '',
        onload: null,
        onerror: null,
        setAttribute: (name: string, value: string): void => {
          attrs.set(name, value);
        },
        getAttribute: (name: string): string | null => attrs.get(name) ?? null,
      };
    };
    const metaStub = {
      getAttribute: (name: string): string | null => {
        if (name === 'content') return 'none';
        if (name === 'data-qstyle-base') return '/app/';
        return null;
      },
    };
    vi.stubGlobal('document', {
      baseURI: 'https://example.test/app/',
      querySelector: (selector: string): unknown => {
        if (selector.startsWith('meta[')) return metaStub;
        const m: RegExpMatchArray | null = /data-qstyle-href="([^"]*)"/.exec(selector);
        if (m === null) return null;
        const href: string = (m[1] ?? '').replace(/%22/g, '"');
        return (
          injected.find(
            (l) => l.href === href || l.getAttribute('data-qstyle-href') === href,
          ) ?? null
        );
      },
      querySelectorAll: (_selector: string): StubLink[] => injected,
      createElement: (): StubLink => makeLink(),
      head: {
        appendChild: (link: StubLink): StubLink => {
          injected.push(link);
          queueMicrotask((): void => {
            link.onload?.();
          });
          return link;
        },
      },
      addEventListener: (): void => undefined,
    });
    let pathname = '/';
    vi.stubGlobal('location', {
      get pathname(): string {
        return pathname;
      },
      origin: 'https://example.test',
    });
    const historyStub = {
      pushState: (_data: unknown, _unused: string, url?: string): void => {
        if (typeof url === 'string') pathname = new URL(url, 'https://example.test').pathname;
      },
      replaceState: (_data: unknown, _unused: string, _url?: string): void => undefined,
    };
    vi.stubGlobal('history', historyStub);
    vi.stubGlobal('window', { addEventListener: (): void => undefined });
    installRoutesManifest(MANIFEST_A);
    links.qstyleRouteBootstrap();
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 0);
    });
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 0);
    });
    // 初回適用: '/' の asset 1 件。
    expect(injected.map((l) => l.href)).toEqual([
      'https://example.test/app/assets/qstyle.root.css',
    ]);
    // pushState navigation で '/a' の assets が追加される (共有 chunk の重複なし)。
    historyStub.pushState({}, '', '/a');
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 0);
    });
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 0);
    });
    expect(injected.map((l) => l.href).sort()).toEqual(
      [
        'https://example.test/app/assets/qstyle.root.css',
        'https://example.test/app/assets/qstyle.a.css',
        'https://example.test/app/assets/qstyle.shared.css',
      ].sort(),
    );
  });
});

describe('prefetchRouteStyles (R1.7)', () => {
  it("does nothing for 'none' (default)", async (): Promise<void> => {
    const prefetch = await freshPrefetch();
    const docListeners: string[] = [];
    const documentStub = {
      baseURI: 'https://example.test/app/',
      addEventListener: (type: string): void => {
        docListeners.push(type);
      },
      removeEventListener: (): void => {},
    };
    vi.stubGlobal('document', documentStub);
    const ensure = vi.fn();
    const dispose = prefetch.prefetchRouteStyles(documentStub as unknown as Document, MANIFEST_A, {
      ensure,
    });
    expect(ensure).not.toHaveBeenCalled();
    expect(docListeners).toEqual([]);
    expect(typeof dispose).toBe('function');
  });

  it("prefetches the route assets on pointerover for 'hover' (anchor list)", async (): Promise<void> => {
    const prefetch = await freshPrefetch();
    installDom();
    const anchorA = fakeAnchor('/a');
    const anchorOther = fakeAnchor('/not-in-manifest');
    const ensure = vi.fn();
    prefetch.prefetchRouteStyles([anchorA, anchorOther] as unknown as readonly HTMLAnchorElement[], MANIFEST_A, {
      strategy: 'hover',
      ensure,
    });
    // manifest に存在する route への link hover だけが先読みされる
    dispatchPointerover(anchorA);
    expect(ensure.mock.calls.map((c) => c[0])).toEqual([
      'https://example.test/assets/qstyle.a.css',
      'https://example.test/assets/qstyle.shared.css',
    ]);
    // 不一致 route では呼ばれない
    dispatchPointerover(anchorOther);
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it("dedupes duplicate assets within one entry for 'hover'", async (): Promise<void> => {
    const prefetch = await freshPrefetch();
    installDom();
    const anchor = fakeAnchor('/dup');
    const manifest: linksModule.QstyleRouteManifest = {
      version: 1,
      entries: [{ route: '/dup', assets: ['assets/qstyle.x.css', 'assets/qstyle.x.css'] }],
    };
    const ensure = vi.fn();
    prefetch.prefetchRouteStyles([anchor] as unknown as readonly HTMLAnchorElement[], manifest, {
      strategy: 'hover',
      ensure,
    });
    dispatchPointerover(anchor);
    // 実運用の ensureStylesheet は data-qstyle-href 規則で二重適用を排除するが、
    // 1 dispatch 内の asset 重複は Set で潰しておく (無駄な ensure 呼び出しを避ける)。
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith('https://example.test/assets/qstyle.x.css');
  });

  it("delegates pointerover at document level for 'hover' (Document scope)", async (): Promise<void> => {
    const prefetch = await freshPrefetch();
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const documentStub = {
      baseURI: 'https://example.test/app/',
      addEventListener: (type: string, handler: (event: unknown) => void): void => {
        const list = listeners.get(type) ?? [];
        list.push(handler);
        listeners.set(type, list);
      },
      removeEventListener: (type: string, handler: (event: unknown) => void): void => {
        const list = listeners.get(type) ?? [];
        listeners.set(type, list.filter((h) => h !== handler));
      },
    };
    vi.stubGlobal('document', documentStub);
    const anchor = fakeAnchor('/b');
    const ensure = vi.fn();
    const dispose = prefetch.prefetchRouteStyles(documentStub as unknown as Document, MANIFEST_A, {
      strategy: 'hover',
      ensure,
    });
    expect(listeners.get('pointerover')).toHaveLength(1);
    // 委譲捕捉: event target は anchor 自身ではなく子 element のこともある (closest で遡る)
    for (const handler of listeners.get('pointerover') ?? []) {
      handler({
        target: {
          closest: (selector: string): unknown => (selector === 'a[href]' ? anchor : null),
        },
      });
    }
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith('https://example.test/assets/qstyle.b.css');
    // dispose で listener を外す
    dispose();
    expect(listeners.get('pointerover')).toHaveLength(0);
  });

  it("prefetches all manifest assets when idle for 'load' (requestIdleCallback)", async (): Promise<void> => {
    const prefetch = await freshPrefetch();
    installDom();
    const idle: { cb?: () => void } = {};
    const cancelIdle = vi.fn();
    vi.stubGlobal('requestIdleCallback', (cb: () => void): number => {
      idle.cb = cb;
      return 42;
    });
    vi.stubGlobal('cancelIdleCallback', cancelIdle);
    const ensure = vi.fn();
    const dispose = prefetch.prefetchRouteStyles([] as unknown as readonly HTMLAnchorElement[], MANIFEST_A, {
      strategy: 'load',
      ensure,
    });
    // idle までは何もしない
    expect(ensure).not.toHaveBeenCalled();
    idle.cb?.();
    expect(ensure.mock.calls.map((c) => c[0]).sort()).toEqual(
      [
        'https://example.test/assets/qstyle.root.css',
        'https://example.test/assets/qstyle.a.css',
        'https://example.test/assets/qstyle.shared.css',
        'https://example.test/assets/qstyle.b.css',
      ].sort(),
    );
    dispose();
    expect(cancelIdle).toHaveBeenCalledWith(42);
  });

  it("falls back to setTimeout for 'load' when requestIdleCallback is unavailable", async (): Promise<void> => {
    const prefetch = await freshPrefetch();
    installDom();
    // requestIdleCallback が無い環境 (Safari 等) での setTimeout fallback を確定させる
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.useFakeTimers();
    try {
      const ensure = vi.fn();
      prefetch.prefetchRouteStyles([] as unknown as readonly HTMLAnchorElement[], MANIFEST_A, {
        strategy: 'load',
        ensure,
      });
      expect(ensure).not.toHaveBeenCalled();
      vi.advanceTimersByTime(200);
      expect(ensure).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
