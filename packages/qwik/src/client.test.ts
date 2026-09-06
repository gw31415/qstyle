import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as clientModule from './client.js';

/**
 * ensureModuleStyles (plan.md §3.4 R1.6 案 B) および ensureStylesheet / resolveAssetUrl
 * (R1.4/R1.5 の link 注入の実体) の unit test。
 * fetch / document を stub して、SSR no-op・fetch 1 回 cache・二重 link 防止を検証する。
 * units index の cache は module singleton なため、vi.resetModules() を呼んだ上で
 * 動的 import により test ごとに新規 module instance を読む。
 */

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

/** browser 相当の最小 DOM を globalThis に置く。返り値で append された link を観測する。 */
function installDom(): TestDom {
  const dom: TestDom = { links: [] };
  const documentStub = {
    baseURI: 'https://example.test/app/',
    querySelector: (selector: string): TestLink | null => {
      // route-loader / client と同じ data-qstyle-href 規則で既存 link を探す。
      const m: RegExpMatchArray | null = /data-qstyle-href="([^"]*)"/.exec(selector);
      if (m === null) return null;
      const href: string = (m[1] ?? '').replace(/%22/g, '"');
      return dom.links.find((l) => l.href === href) ?? null;
    },
    // hasStylesheet が SSR 焼き込み link (root 相対 data-qstyle-href) の比較に使う。
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
        // browser の link 読み込みを模倣し、append 直後に onload を発火させる
        // (ensureModuleStyles は link の load を待って resolve する)。
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

/** fetch stub。qstyle.units.json 相当の JSON を返す。 */
function installUnitsIndex(units: Record<string, readonly string[]>): { fetchCalls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (input: unknown): Promise<{ ok: boolean; json: () => Promise<unknown> }> => {
    calls.push(String(input));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ version: 1, units }),
    });
  });
  return { fetchCalls: calls };
}

/** 新規 module instance の client exports を返す (cache 状態を test 間で隔離)。 */
async function freshClient(): Promise<typeof clientModule> {
  vi.resetModules();
  return await import('./client.js');
}

/** 新規 module instance の ensureModuleStyles を返す (cache 状態を test 間で隔離)。 */
async function freshEnsureModuleStyles(): Promise<typeof clientModule.ensureModuleStyles> {
  const mod: typeof clientModule = await freshClient();
  return mod.ensureModuleStyles;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('ensureModuleStyles (R1.6)', () => {
  it('resolves immediately on SSR (document undefined) without fetch', async (): Promise<void> => {
    // node 環境の既定では document が undefined のままなので SSR 相当。
    const ensureModuleStyles = await freshEnsureModuleStyles();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await ensureModuleStyles(['q_aaaa1111']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches qstyle.units.json once and appends a stylesheet link', async (): Promise<void> => {
    const ensureModuleStyles = await freshEnsureModuleStyles();
    const dom: TestDom = installDom();
    const { fetchCalls } = installUnitsIndex({ q_aaaa1111: ['assets/qstyle.q_1a2b3c4d.css'] });
    await ensureModuleStyles(['q_aaaa1111']);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toBe('https://example.test/qstyle.units.json');
    expect(dom.links).toHaveLength(1);
    expect(dom.links[0]?.rel).toBe('stylesheet');
    expect(dom.links[0]?.href).toBe('https://example.test/assets/qstyle.q_1a2b3c4d.css');
    expect(dom.links[0]?.dataset['qstyleHref']).toBe('https://example.test/assets/qstyle.q_1a2b3c4d.css');
  });

  it('caches the units index across calls (single fetch)', async (): Promise<void> => {
    const ensureModuleStyles = await freshEnsureModuleStyles();
    const dom: TestDom = installDom();
    const { fetchCalls } = installUnitsIndex({ q_aaaa1111: ['assets/qstyle.a.css'] });
    await ensureModuleStyles(['q_aaaa1111']);
    await ensureModuleStyles(['q_aaaa1111']);
    expect(fetchCalls).toHaveLength(1);
    expect(dom.links).toHaveLength(1);
  });

  it('does not append the same href twice (same unit id and shared chunk)', async (): Promise<void> => {
    const ensureModuleStyles = await freshEnsureModuleStyles();
    const dom: TestDom = installDom();
    // 2 unit が同一 chunk に属する場合も、href dedup で link は 1 本だけ。
    installUnitsIndex({
      q_aaaa1111: ['assets/qstyle.shared.css'],
      q_bbbb2222: ['assets/qstyle.shared.css'],
    });
    await ensureModuleStyles(['q_aaaa1111', 'q_bbbb2222']);
    await ensureModuleStyles(['q_aaaa1111']);
    expect(dom.links).toHaveLength(1);
    expect(dom.links[0]?.href).toBe('https://example.test/assets/qstyle.shared.css');
  });

  it('resolves (not rejects) when the units index fetch fails', async (): Promise<void> => {
    const ensureModuleStyles = await freshEnsureModuleStyles();
    installDom();
    vi.stubGlobal('fetch', (): Promise<{ ok: boolean }> => Promise.resolve({ ok: false }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(ensureModuleStyles(['q_aaaa1111'])).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('skips unit ids missing from the index without crashing', async (): Promise<void> => {
    const ensureModuleStyles = await freshEnsureModuleStyles();
    const dom: TestDom = installDom();
    installUnitsIndex({ q_aaaa1111: ['assets/qstyle.a.css'] });
    await ensureModuleStyles(['q_unknown0000', 'q_aaaa1111']);
    expect(dom.links).toHaveLength(1);
    expect(dom.links[0]?.href).toBe('https://example.test/assets/qstyle.a.css');
  });
});

describe('ensureStylesheet / resolveAssetUrl (R1.4/R1.5 link 注入の実体)', () => {
  it('resolveAssetUrl resolves a root-relative asset name against the base', async (): Promise<void> => {
    const client = await freshClient();
    installDom();
    expect(client.resolveAssetUrl('assets/qstyle.a.css')).toBe(
      'https://example.test/assets/qstyle.a.css',
    );
  });

  it('appends a single link for repeated ensureStylesheet calls with the same href', async (): Promise<void> => {
    const client = await freshClient();
    const dom: TestDom = installDom();
    await client.ensureStylesheet('https://example.test/assets/qstyle.a.css');
    await client.ensureStylesheet('https://example.test/assets/qstyle.a.css');
    expect(dom.links).toHaveLength(1);
    expect(dom.links[0]?.rel).toBe('stylesheet');
    expect(dom.links[0]?.href).toBe('https://example.test/assets/qstyle.a.css');
  });

  it('treats an SSR-rendered root-relative link (R1.4) as already loaded', async (): Promise<void> => {
    // R1.4 の <QstyleLinks /> は SSR で data-qstyle-href に root 相対 href を焼く。
    // server 側では絶対 URL を組めないため、client 側の絶対 URL 注入と文字列は一致しない。
    // hasStylesheet の base 解決比較がこれを吸収し二重適用を防ぐことを検証する。
    const client = await freshClient();
    const dom: TestDom = installDom();
    dom.links.push({
      rel: 'stylesheet',
      href: '/assets/qstyle.a.css',
      dataset: { qstyleHref: '/assets/qstyle.a.css' },
      getAttribute: (): string => '/assets/qstyle.a.css',
      onload: null,
      onerror: null,
    });
    await client.ensureStylesheet('https://example.test/assets/qstyle.a.css');
    expect(dom.links).toHaveLength(1);
  });
});
