import { describe, expect, it } from 'vitest';
import { qstyle as qstyleFactory } from './index.js';
import type { QstyleSourceMap } from './index.js';

/**
 * dev HMR・dev server・build 経路の回帰スイート (HMR-101〜)。
 *
 * 由来: 過去不具合 (stable dev alias / client 未読 module の full-reload /
 * watcher null-byte crash / routes.json 404) で触った経路のうち、
 * unit test が無かったもの (configureServer 全体・middleware) と、
 * refreshDevCss / generateBundle の分岐の隙間を埋める。
 * 方針は correctness first: 振る舞いを変えず、現在の契約を固定する。
 */

interface Transformable {
  transform: (
    code: string,
    id: string,
  ) => { code: string; map: QstyleSourceMap } | null;
  load: (id: string) => string | null;
}

interface GraphFake {
  getModuleById: (id: string) => { id: string } | undefined;
  invalidateModule: (mod: unknown) => void;
}

interface HmrServer {
  moduleGraph: GraphFake;
  environments?: Record<string, { moduleGraph?: GraphFake; hot?: { send: (p: unknown) => void } }>;
  ws?: { send: (payload: unknown) => void };
  hot?: { send: (payload: unknown) => void };
}

interface HmrPlugin extends Transformable {
  configResolved: (config: { command: string; mode: string }) => void;
  configureServer: (server: unknown) => void;
  buildStart: () => void;
  generateBundle: (this: { emitFile: (f: { fileName: string; source: string }) => void }) => void;
  resolveId: (id: string) => string | null;
  handleHotUpdate: (ctx: {
    file: string;
    timestamp?: number;
    read?: () => string | Promise<string>;
    server: HmrServer;
  }) => Promise<void> | void;
}

const plugin = (
  options: Parameters<typeof qstyleFactory>[0] = {
    backend: 'qwik-native',
    diagnostics: 'silent',
  },
): HmrPlugin => qstyleFactory(options)[0] as unknown as HmrPlugin;

const devPlugin = (options: Parameters<typeof qstyleFactory>[0] = { diagnostics: 'silent' }): HmrPlugin => {
  const p = plugin(options);
  p.configResolved({ command: 'serve', mode: 'development' });
  return p;
};

/** graph 参照・無効化・送信を記録する fake server。 */
function trackingServer(): {
  server: HmrServer;
  requested: string[];
  invalidated: unknown[];
  sent: unknown[];
} {
  const requested: string[] = [];
  const invalidated: unknown[] = [];
  const sent: unknown[] = [];
  const server: HmrServer = {
    moduleGraph: {
      getModuleById: (id: string): { id: string } | undefined => {
        requested.push(id);
        return { id };
      },
      invalidateModule: (mod: unknown): void => {
        invalidated.push(mod);
      },
    },
    ws: {
      send: (payload: unknown): void => {
        sent.push(payload);
      },
    },
  };
  return { server, requested, invalidated, sent };
}

function devKeyOf(code: string): string {
  const key: string = (code.match(/virtual:qstyle\/dev\/([\w.]+)/) ?? [])[1] ?? '';
  expect(key).not.toBe('');
  return key;
}

function sentTypes(sent: readonly unknown[]): string[] {
  return sent.map((p) => (p as { type?: string }).type ?? '?');
}

describe('HMR-101〜: handleHotUpdate の分岐網羅', () => {
  it('HMR-101: tsx/jsx 以外は graph に触れず解決する', async () => {
    const p = devPlugin();
    const { server, requested, invalidated, sent } = trackingServer();
    await p.handleHotUpdate({ file: '/src/style.css', server });
    await p.handleHotUpdate({ file: '/src/util.ts', server });
    expect(requested).toHaveLength(0);
    expect(invalidated).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('HMR-102: css を含まない編集は未管理ファイルなら何もしない', async () => {
    const p = devPlugin();
    let touched = false;
    const server: HmrServer = {
      moduleGraph: {
        getModuleById: (): { id: string } | undefined => {
          touched = true;
          return undefined;
        },
        invalidateModule: (): void => {},
      },
    };
    // 'css' 部分文字列自体が無い → graph 参照より前に return する。
    await p.handleHotUpdate({
      file: '/src/plain.tsx',
      read: async () => `export const A = () => <div>hi</div>;`,
      server,
    });
    expect(touched).toBe(false);
  });

  it('HMR-103: css という単語だけのファイルは transform null でも静かに解決する', async () => {
    const p = devPlugin();
    const { server, requested, invalidated, sent } = trackingServer();
    // occurrence が無いため transform は null (edits なし)。未管理なので早期 return。
    await p.handleHotUpdate({
      file: '/src/wordy.tsx',
      read: async () => `// css about nothing\nexport const A = () => <div />;`,
      server,
    });
    expect(requested).toHaveLength(0);
    expect(invalidated).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('HMR-104: read 失敗は未管理なら無視・管理済みなら更新扱いで例外にしない', async () => {
    const p = devPlugin();
    const failing = (): Promise<string> => Promise.reject(new Error('gone'));
    // 未管理: 何も起きない。
    {
      const t = trackingServer();
      await p.handleHotUpdate({ file: '/src/missing.tsx', read: failing, server: t.server });
      expect(t.invalidated).toHaveLength(0);
      expect(t.sent).toHaveLength(0);
    }
    // 管理済み: 再読込不能 = 更新ありとみなして invalidate + update
    // (DOM 追随は qwik の qwik:hmr が担う)。
    const managed = `export const A = () => <div css={{ display: 'flex' }} />;`;
    expect(p.transform(managed, '/src/managed.tsx')).not.toBeNull();
    {
      const t = trackingServer();
      await p.handleHotUpdate({ file: '/src/managed.tsx', read: failing, server: t.server });
      expect(t.invalidated).toHaveLength(1);
      expect(sentTypes(t.sent)).toEqual(['update']);
    }
  });

  it('HMR-105: read が無い管理済みファイルは更新扱いで css-update を送る', async () => {
    const p = devPlugin();
    expect(
      p.transform(`export const A = () => <div css={{ display: 'flex' }} />;`, '/src/noread.tsx'),
    ).not.toBeNull();
    const { server, invalidated, sent } = trackingServer();
    await p.handleHotUpdate({ file: '/src/noread.tsx', server });
    expect(invalidated).toHaveLength(1);
    expect(sentTypes(sent)).toEqual(['update']);
  });

  it('HMR-106: css 削除は virtual css を空にする (DOM の class 除去は qwik:hmr が担う)', async () => {
    const p = devPlugin();
    const file = '/src/removed.tsx';
    const v1 = p.transform(`export const A = () => <div css={{ display: 'flex' }} />;`, file);
    const key: string = devKeyOf(v1?.code ?? '');
    expect(p.load(`virtual:qstyle/dev/${key}`)).toContain('display:flex');
    const { server, invalidated, sent } = trackingServer();
    await p.handleHotUpdate({
      file,
      read: async () => `export const A = () => <div>plain</div>;`,
      server,
    });
    expect(invalidated).toHaveLength(1);
    expect(sentTypes(sent)).toEqual(['update']);
    // devCss エントリは消え、link の refetch は空 CSS を返す (404 ではなく)。
    expect(p.load(`virtual:qstyle/dev/${key}`)).toBe('');
  });

  it('HMR-107: css 以外の編集 (テキスト変更) は css-update のみ (DOM は qwik:hmr)', async () => {
    const p = devPlugin();
    const file = '/src/textedit.tsx';
    expect(
      p.transform(`export const A = () => <div css={{ display: 'flex' }}>a</div>;`, file),
    ).not.toBeNull();
    const { server, sent } = trackingServer();
    await p.handleHotUpdate({
      file,
      read: async () => `export const A = () => <div css={{ display: 'flex' }}>b</div>;`,
      server,
    });
    // devCode (変換後 JS) が変わるが、DOM 更新は qwik の qwik:hmr が担うため
    // qstyle からは css-update のみ送る (0.1.1: 自前 full-reload は廃止)。
    expect(sentTypes(sent)).toEqual(['update']);
  });

  it('HMR-108: 先頭 occurrence 削除で alias がずれる (DOM 追随は qwik:hmr)', async () => {
    const p = devPlugin();
    const file = '/src/shift.tsx';
    const v1 = p.transform(
      `export const A = () => <><div css={{ color: 'red' }} /><div css={{ color: 'blue' }} /></>;`,
      file,
    );
    expect(v1).not.toBeNull();
    const before: string[] = [...(v1?.code.matchAll(/class="([^"]*)"/g) ?? [])].map(
      (m) => m[1] ?? '',
    );
    expect(before).toHaveLength(2);
    const { server, sent } = trackingServer();
    await p.handleHotUpdate({
      file,
      read: async () => `export const A = () => <><div css={{ color: 'blue' }} /></>;`,
      server,
    });
    // occurrence slot が詰まるため残存要素の class が変わる。css は新 alias で
    // 再生成され、DOM 側は qwik:hmr (chunk 再取得) が追随させる。
    expect(sentTypes(sent)).toEqual(['update']);
    const v2 = p.transform(
      `export const A = () => <><div css={{ color: 'blue' }} /></>;`,
      file,
    );
    const after: string[] = [...(v2?.code.matchAll(/class="([^"]*)"/g) ?? [])].map(
      (m) => m[1] ?? '',
    );
    // 残存 occurrence は slot 0 に詰まる (v1 先頭と同一 alias)。DOM は qwik:hmr で追随する。
    expect(after).toEqual([before[0]]);
  });

  it('HMR-109: 送信先は hot > environments.client.hot > ws の順で選ぶ', async () => {
    const file = '/src/sender.tsx';
    const edited = `export const A = () => <div css={{ display: 'block' }} />;`;
    const setup = (): HmrPlugin => {
      const q = devPlugin();
      expect(q.transform(`export const A = () => <div css={{ display: 'flex' }} />;`, file)).not.toBeNull();
      return q;
    };
    // 値のみの編集は出力不変 → css-update のみ。どこへ送られたかで優先順位を判定する。
    // (a) top-level hot があれば ws は使わない。
    {
      const p = setup();
      const hotSent: unknown[] = [];
      const wsSent: unknown[] = [];
      const { server } = trackingServer();
      server.hot = { send: (q: unknown): void => { hotSent.push(q); } };
      server.ws = { send: (q: unknown): void => { wsSent.push(q); } };
      await p.handleHotUpdate({ file, read: async () => edited, server });
      expect(hotSent).toHaveLength(1);
      expect(wsSent).toHaveLength(0);
    }
    // (b) top-level hot が無ければ environments.client.hot を使う。
    {
      const p = setup();
      const clientSent: unknown[] = [];
      const wsSent: unknown[] = [];
      const { server } = trackingServer();
      server.environments = { client: { hot: { send: (q: unknown): void => { clientSent.push(q); } } } };
      server.ws = { send: (q: unknown): void => { wsSent.push(q); } };
      await p.handleHotUpdate({ file, read: async () => edited, server });
      expect(clientSent).toHaveLength(1);
      expect(wsSent).toHaveLength(0);
    }
    // (c) どちらも無ければ ws に送る (既存テストの経路)。
    {
      const p = setup();
      const { server, sent } = trackingServer();
      await p.handleHotUpdate({ file, read: async () => edited, server });
      expect(sent).toHaveLength(1);
    }
  });

  it('HMR-110: css-update の timestamp は ctx 由来、無ければ数値時刻', async () => {
    const file = '/src/ts.tsx';
    const mk = (): HmrPlugin => {
      const q = devPlugin();
      expect(q.transform(`export const A = () => <div css={{ display: 'flex' }} />;`, file)).not.toBeNull();
      return q;
    };
    const edited = `export const A = () => <div css={{ display: 'block' }} />;`;
    {
      const p = mk();
      const { server, sent } = trackingServer();
      await p.handleHotUpdate({ file, timestamp: 777, read: async () => edited, server });
      const update = sent[0] as { updates: { timestamp: number }[] };
      expect(update.updates[0]?.timestamp).toBe(777);
    }
    {
      const p = mk();
      const { server, sent } = trackingServer();
      await p.handleHotUpdate({ file, read: async () => edited, server });
      const update = sent[0] as { updates: { timestamp: unknown }[] };
      expect(typeof update.updates[0]?.timestamp).toBe('number');
    }
  });

  it('HMR-111: module を持つ全 env graph を無効化する', async () => {
    const p = devPlugin();
    const file = '/src/multi.tsx';
    expect(
      p.transform(`export const A = () => <div css={{ display: 'flex' }} />;`, file),
    ).not.toBeNull();
    const invalidated: string[] = [];
    const graph = (tag: string): GraphFake => ({
      getModuleById: (id: string): { id: string } | undefined => ({ id: `${tag}:${id}` }),
      invalidateModule: (mod: unknown): void => {
        invalidated.push((mod as { id: string }).id);
      },
    });
    const sent: unknown[] = [];
    await p.handleHotUpdate({
      file,
      read: async () => `export const A = () => <div css={{ display: 'block' }} />;`,
      server: {
        moduleGraph: graph('root'),
        environments: { ssr: { moduleGraph: graph('ssr') }, client: { moduleGraph: graph('client') } },
        ws: { send: (q: unknown): void => { sent.push(q); } },
      },
    });
    // vid は devModuleId(file) で全 graph 共通。3 graph が各1回無効化される。
    expect(invalidated).toHaveLength(3);
    expect(new Set(invalidated.map((s) => s.split(':')[0])).size).toBe(3);
    expect(sent).toHaveLength(1);
  });

  it('HMR-112: 1 つの graph が throw しても他は処理し解決する (best-effort)', async () => {
    const p = devPlugin();
    const file = '/src/throw.tsx';
    expect(
      p.transform(`export const A = () => <div css={{ display: 'flex' }} />;`, file),
    ).not.toBeNull();
    let secondInvalidated = 0;
    const sent: unknown[] = [];
    await p.handleHotUpdate({
      file,
      read: async () => `export const A = () => <div css={{ display: 'block' }} />;`,
      server: {
        moduleGraph: {
          getModuleById: (): { id: string } | undefined => {
            throw new Error('graph down');
          },
          invalidateModule: (): void => {},
        },
        environments: {
          client: {
            moduleGraph: {
              getModuleById: (id: string): { id: string } | undefined => ({ id }),
              invalidateModule: (): void => {
                secondInvalidated += 1;
              },
            },
          },
        },
        ws: { send: (q: unknown): void => { sent.push(q); } },
      },
    });
    expect(secondInvalidated).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('HMR-113: send が throw しても handleHotUpdate は解決する', async () => {
    const p = devPlugin();
    const file = '/src/sendthrow.tsx';
    expect(
      p.transform(`export const A = () => <div css={{ display: 'flex' }} />;`, file),
    ).not.toBeNull();
    const invalidated: unknown[] = [];
    await p.handleHotUpdate({
      file,
      read: async () => `export const A = () => <div css={{ display: 'block' }} />;`,
      server: {
        moduleGraph: {
          getModuleById: (id: string): { id: string } | undefined => ({ id }),
          invalidateModule: (mod: unknown): void => {
            invalidated.push(mod);
          },
        },
        ws: {
          send: (): void => {
            throw new Error('socket gone');
          },
        },
      },
    });
    expect(invalidated).toHaveLength(1);
  });

  it('HMR-114: strict 破壊編集の re-transform 例外は握りつぶして更新経路に回す', async () => {
    const p = devPlugin({ optimization: 'strict', diagnostics: 'silent' });
    const file = '/src/strict.tsx';
    expect(
      p.transform(`export const A = () => <div css={{ display: 'flex' }} />;`, file),
    ).not.toBeNull();
    const { server, invalidated, sent } = trackingServer();
    // strict では residual が compile error になるが、HMR 経路では throw させない。
    await p.handleHotUpdate({
      file,
      read: async () => `export const A = () => <div css={{ '&& x': { color: 'red' } }} />;`,
      server,
    });
    expect(invalidated).toHaveLength(1);
    expect(sentTypes(sent)).toEqual(['update']);
  });

  it('HMR-115: .jsx も HMR 対象になる', async () => {
    const p = devPlugin();
    const file = '/src/comp.jsx';
    const v1 = p.transform(`export const A = () => <div css={{ display: 'flex' }} />;`, file);
    expect(v1).not.toBeNull();
    expect(v1?.code).toContain('virtual:qstyle/dev/');
    const { server, sent } = trackingServer();
    await p.handleHotUpdate({
      file,
      read: async () => `export const A = () => <div css={{ display: 'block' }} />;`,
      server,
    });
    // 値のみの編集 → 出力不変 → css-update のみ。
    expect(sent).toHaveLength(1);
    expect(sentTypes(sent)).toEqual(['update']);
  });

  it('HMR-116: re-transform は plugin container 経由で走り devCss が完全パイプラインと一致する', async () => {
    // 由来: 自プラグインの transform を直接呼ぶ先行 re-transform は、上流
    // plugin (@qstyle/unocss の class → css prop 変換) を適用しない。その結果
    // devCss の unit/alias が DOM 側 (完全パイプラインで作り直される chunk
    // re-transform) と乖離し、css-update が一致しない rule を配信して要素の
    // statics が外れて消えた (0.1.1 修正)。container 経由で変換することを
    // ここで固定する。
    const p = devPlugin();
    const file = '/src/pipeline.tsx';
    const v1 = p.transform(`export const A = () => <div css={{ display: 'flex' }} />;`, file);
    const key: string = devKeyOf(v1?.code ?? '');
    expect(key).not.toBe('');
    const { server, sent } = trackingServer();
    const containerCalls: number[] = [];
    // 上流 plugin の代役。container 経由でのみ css prop が完成する
    // (生 source は未解決の marker を含み、自プラグイン単独では parse 不能)。
    (server as unknown as {
      pluginContainer: {
        transform: (code: string, id: string) => { code: string } | null;
      };
    }).pluginContainer = {
      transform: (code: string, id: string) => {
        containerCalls.push(1);
        return p.transform(code.replace('/*UNO*/', "color: 'red'"), id);
      },
    };
    await p.handleHotUpdate({
      file,
      read: async () => `export const A = () => <div css={{ /*UNO*/ }} />;`,
      server,
    });
    // container を経由する (自プラグイン単独の直接呼び出しは廃止)。
    expect(containerCalls).toHaveLength(1);
    // devCss は完全パイプラインの出力 (上流変換後の css prop) を反映する。
    expect(p.load(`virtual:qstyle/dev/${key}`)).toContain('color:red');
    expect(sentTypes(sent)).toEqual(['update']);
  });
});

describe('DEV-101〜: configureServer (watcher 保護 + css middleware)', () => {
  interface WatcherFake {
    add: (paths: unknown, ...rest: unknown[]) => unknown;
    __qstyleWatchPatched?: boolean;
  }

  function fakeWatcher(): { watcher: WatcherFake; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const watcher: WatcherFake = {
      add: (paths: unknown, ...rest: unknown[]): unknown => {
        calls.push([paths, ...rest]);
        return watcher;
      },
    };
    return { watcher, calls };
  }

  interface ResFake {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    ended: boolean;
    setHeader: (k: string, v: string) => void;
    end: (d?: string) => void;
  }

  function fakeRes(): ResFake {
    const res: ResFake = {
      statusCode: 0,
      headers: {},
      body: '',
      ended: false,
      setHeader: (k: string, v: string): void => {
        res.headers[k] = v;
      },
      end: (d = ''): void => {
        res.body = d;
        res.ended = true;
      },
    };
    return res;
  }

  function devServer(p: { load: (id: string) => string | null }): {
    server: {
      watcher: WatcherFake;
      middlewares: { use: (fn: (req: unknown, res: unknown, next: () => void) => void) => void };
      pluginContainer: { load: (id: string) => Promise<unknown> };
    };
    middlewares: ((req: unknown, res: unknown, next: () => void) => void)[];
    watcher: WatcherFake;
    calls: unknown[][];
  } {
    const middlewares: ((req: unknown, res: unknown, next: () => void) => void)[] = [];
    const { watcher, calls } = fakeWatcher();
    const server = {
      watcher,
      middlewares: {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void): void => {
          middlewares.push(fn);
        },
      },
      pluginContainer: {
        load: async (id: string): Promise<unknown> => p.load(id),
      },
    };
    return { server, middlewares, watcher, calls };
  }

  const tick = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('DEV-101: null byte 付き watch は落とさず捨てる (chain 維持)', () => {
    const p = plugin();
    const { server, watcher, calls } = devServer(p);
    p.configureServer(server);
    expect(() => watcher.add('\0virtual:qstyle/dev/abcd1234.css')).not.toThrow();
    expect(calls).toHaveLength(0);
    // chainable: 戻り値は watcher 自身。
    expect(watcher.add('\0x')).toBe(watcher);
  });

  it('DEV-102: 配列混在は null byte だけ除外して1回委譲する', () => {
    const p = plugin();
    const { server, calls } = devServer(p);
    p.configureServer(server);
    (server.watcher as WatcherFake).add(['/src/a.tsx', '\0virtual:qstyle/dev/x.css', '/src/b.tsx']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual(['/src/a.tsx', '/src/b.tsx']);
  });

  it('DEV-103: 全滅配列は委譲せず watcher を返す', () => {
    const p = plugin();
    const { server, watcher, calls } = devServer(p);
    p.configureServer(server);
    expect((watcher as WatcherFake).add(['\0a', '\0b'])).toBe(watcher);
    expect(calls).toHaveLength(0);
  });

  it('DEV-104: 通常パスは素通しする (string/array)', () => {
    const p = plugin();
    const { server, calls } = devServer(p);
    p.configureServer(server);
    (server.watcher as WatcherFake).add('/src/a.tsx', { ignoreInitial: true });
    (server.watcher as WatcherFake).add(['/src/a.tsx', '/src/b.tsx']);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['/src/a.tsx', { ignoreInitial: true }]);
    expect(calls[1]?.[0]).toEqual(['/src/a.tsx', '/src/b.tsx']);
  });

  it('DEV-105: configureServer 二重呼び出しでも wrap は1回だけ', () => {
    const p = plugin();
    const { server, calls } = devServer(p);
    const before = server.watcher.add;
    p.configureServer(server);
    const afterFirst = server.watcher.add;
    expect(afterFirst).not.toBe(before);
    expect((server.watcher as WatcherFake).__qstyleWatchPatched).toBe(true);
    p.configureServer(server);
    expect(server.watcher.add).toBe(afterFirst);
    // 二重 wrap していないため委譲は1回だけ。
    (server.watcher as WatcherFake).add('/src/a.tsx');
    expect(calls).toHaveLength(1);
  });

  it('DEV-106: 対象外 URL は next() に回す', async () => {
    const p = plugin();
    const { server, middlewares } = devServer(p);
    p.configureServer(server);
    expect(middlewares).toHaveLength(1);
    const mw = middlewares[0] as (req: unknown, res: unknown, next: () => void) => void;
    for (const url of ['/src/main.tsx', '/virtual:qstyle/registry', '/virtual:qstyle/dev/x.js']) {
      let nexted = false;
      const res = fakeRes();
      mw({ url }, res, () => {
        nexted = true;
      });
      await tick();
      expect(nexted).toBe(true);
      expect(res.ended).toBe(false);
    }
  });

  it('DEV-107: dev css を ?クエリ付きでも text/css 200 で返す', async () => {
    const p = devPlugin();
    const file = '/src/mw.tsx';
    const out = p.transform(`export const A = () => <div css={{ display: 'flex' }} />;`, file);
    const key: string = devKeyOf(out?.code ?? '');
    const { server, middlewares } = devServer(p);
    p.configureServer(server);
    const mw = middlewares[0] as (req: unknown, res: unknown, next: () => void) => void;
    let nexted = false;
    const res = fakeRes();
    mw({ url: `/virtual:qstyle/dev/${key}?t=12345` }, res, () => {
      nexted = true;
    });
    await tick();
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/css; charset=utf-8');
    expect(res.body).toContain('display:flex');
  });

  it('DEV-108: 未知 dev key は空 200 (link 切れで落とさない)', async () => {
    const p = plugin();
    const { server, middlewares } = devServer(p);
    p.configureServer(server);
    const mw = middlewares[0] as (req: unknown, res: unknown, next: () => void) => void;
    let nexted = false;
    const res = fakeRes();
    mw({ url: '/virtual:qstyle/dev/deadbeef.css' }, res, () => {
      nexted = true;
    });
    await tick();
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('DEV-109: load 不能 virtual path は 404 にする', async () => {
    const p = plugin();
    const { server, middlewares } = devServer(p);
    p.configureServer(server);
    const mw = middlewares[0] as (req: unknown, res: unknown, next: () => void) => void;
    let nexted = false;
    const res = fakeRes();
    mw({ url: '/virtual:qstyle/bogus.css' }, res, () => {
      nexted = true;
    });
    await tick();
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(404);
    expect(res.ended).toBe(true);
  });

  it('DEV-110: load 例外は 500 にして落とさない', async () => {
    const p = plugin();
    const { server, middlewares } = devServer(p);
    p.configureServer(server);
    server.pluginContainer.load = async (): Promise<unknown> => {
      throw new Error('boom');
    };
    const mw = middlewares[0] as (req: unknown, res: unknown, next: () => void) => void;
    let nexted = false;
    const res = fakeRes();
    mw({ url: '/virtual:qstyle/dev/anykey.css' }, res, () => {
      nexted = true;
    });
    await tick();
    await tick();
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(500);
    expect(res.ended).toBe(true);
  });
});

describe('DEV-111〜: dev transform の不変条件', () => {
  it('DEV-111: 同一 css でも module 毎に別 alias (編集が他 module に漏れない)', () => {
    const p = devPlugin();
    const code = `export const A = () => <div css={{ display: 'flex' }} />;`;
    const a = p.transform(code, '/src/same-a.tsx');
    const b = p.transform(code, '/src/same-b.tsx');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const cls = (c: string): string[] =>
      [...c.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? '').split(/\s+/).filter(Boolean));
    expect(cls(a?.code ?? '')).toHaveLength(1);
    expect(cls(b?.code ?? '')).toHaveLength(1);
    const clsA: string = cls(a?.code ?? '')[0] ?? '';
    const clsB: string = cls(b?.code ?? '')[0] ?? '';
    expect(clsA).not.toBe('');
    expect(clsB).not.toBe('');
    expect(clsA).not.toBe(clsB);
    // 各 module の dev css に自 rule がある。
    const cssOf = (c: string): string => {
      const key: string = devKeyOf(c);
      return p.load(`virtual:qstyle/dev/${key}`) ?? '';
    };
    expect(cssOf(a?.code ?? '')).toContain(clsA);
    expect(cssOf(b?.code ?? '')).toContain(clsB);
  });

  it('DEV-112: dev の dynamic は style var 名と css の var() が一致する', () => {
    const p = devPlugin({ diagnostics: 'silent', runtimeStyles: { promotion: 'always' } });
    const out = p.transform(`export const A = () => <div css={{ width: props.w }} />;`, '/src/dyn.tsx');
    expect(out).not.toBeNull();
    const code: string = out?.code ?? '';
    const slot: string = (code.match(/'--(qstyle-[0-9a-f]{6}-\d+)': props\.w/) ?? [])[1] ?? '';
    expect(slot).not.toBe('');
    const key: string = devKeyOf(code);
    const css: string = p.load(`virtual:qstyle/dev/${key}`) ?? '';
    expect(css).toContain(`width:var(--${slot})`);
    // class は alias、var 名は content 由来のまま。
    expect(code).toMatch(/class="qd_[^"]*"/);
    expect(code).not.toContain('class="q_');
  });

  it('DEV-113: dev でも module-scope css() handle が解決される', () => {
    const p = devPlugin();
    const out = p.transform(
      `import { css } from '@qstyle/qwik';\nconst base = css({ display: 'flex' });\nexport const A = () => <div css={base} />;`,
      '/src/handle.tsx',
    );
    expect(out).not.toBeNull();
    expect(out?.code).toContain('virtual:qstyle/dev/');
    const key: string = devKeyOf(out?.code ?? '');
    expect(p.load(`virtual:qstyle/dev/${key}`)).toContain('display:flex');
  });

  it('DEV-114: dev の keyframes 定義は virtual css に乗り参照が解決される', () => {
    const p = devPlugin();
    const out = p.transform(
      `export const A = () => <div css={{ '@keyframes fade': { from: { opacity: 0 } }, animation: 'fade 1s' }} />;`,
      '/src/kfdev.tsx',
    );
    expect(out).not.toBeNull();
    const key: string = devKeyOf(out?.code ?? '');
    const css: string = p.load(`virtual:qstyle/dev/${key}`) ?? '';
    const name: string = (css.match(/@keyframes (qkf_[0-9a-f]{8})/) ?? [])[1] ?? '';
    expect(name).not.toBe('');
    // class 側の animation 参照が確定名を指す (dev alias 化されない global 名)。
    expect(css).toContain(`animation:${name} 1s`);
  });
});

describe('BLD-101〜: build/generateBundle の境界', () => {
  function mainOf(options: Parameters<typeof qstyleFactory>[0]): HmrPlugin {
    return qstyleFactory(options)[0] as unknown as HmrPlugin;
  }

  function generateOf(
    options: Parameters<typeof qstyleFactory>[0],
  ): {
    main: HmrPlugin;
    cssAsset: HmrPlugin;
    dedup: { generateBundle: (options: unknown, bundle: Record<string, unknown>) => void };
  } {
    const found = qstyleFactory(options) as unknown as HmrPlugin[];
    const byName = (n: string): HmrPlugin => {
      const hit: HmrPlugin | undefined = found.find(
        (x) => (x as unknown as { name?: string }).name === n,
      );
      if (hit === undefined) throw new Error(`plugin ${n} not found`);
      return hit;
    };
    return {
      main: byName('qstyle'),
      cssAsset: byName('qstyle:css-asset'),
      dedup: byName('qstyle:dedup') as unknown as {
        generateBundle: (options: unknown, bundle: Record<string, unknown>) => void;
      },
    };
  }

  function collectEmit(): { emitted: { fileName: string; source: string }[]; emitFile: (f: { fileName: string; source: string }) => void } {
    const emitted: { fileName: string; source: string }[] = [];
    return {
      emitted,
      emitFile: (f: { fileName: string; source: string }): void => {
        emitted.push(f);
      },
    };
  }

  it('BLD-101: 空 build でも manifest 系は壊れず css-asset は何も出さない', () => {
    const { main, cssAsset } = generateOf({ backend: 'css-asset', diagnostics: 'silent' });
    main.buildStart();
    // css の無い module は transform null。
    expect(
      main.transform(`export const A = () => <div>plain</div>;`, '/src/plain.tsx'),
    ).toBeNull();
    const { emitted, emitFile } = collectEmit();
    main.generateBundle.call({ emitFile });
    cssAsset.generateBundle.call({ emitFile });
    const names: string[] = emitted.map((e) => e.fileName).sort();
    // chunk が無くても manifest 系 + 空の units index は出す。css 本体は出さない。
    expect(names).toEqual(['qstyle-manifest.json', 'qstyle.routes.json', 'qstyle.units.json']);
    expect(names.filter((n) => n.startsWith('assets/'))).toHaveLength(0);
    const routes = JSON.parse(
      emitted.find((e) => e.fileName === 'qstyle.routes.json')?.source ?? '{}',
    ) as { version: number; routes: unknown };
    expect(routes.version).toBe(1);
    const units = JSON.parse(
      emitted.find((e) => e.fileName === 'qstyle.units.json')?.source ?? '{}',
    ) as { version: number; units: unknown };
    expect(units.version).toBe(1);
    expect(units.units).toEqual({});
  });

  it('BLD-102: qwik-native の generateBundle は asset を直接出さない (配管に委ねる)', () => {
    const { main } = generateOf({ backend: 'qwik-native', diagnostics: 'silent' });
    main.buildStart();
    expect(
      main.transform(`export const A = () => <div css={{ display: 'flex' }} />;`, '/src/n.tsx'),
    ).not.toBeNull();
    const { emitted, emitFile } = collectEmit();
    main.generateBundle.call({ emitFile });
    const names: string[] = emitted.map((e) => e.fileName);
    expect(names).not.toContain('qstyle.units.json');
    expect(names.filter((n) => n.startsWith('assets/qstyle.'))).toHaveLength(0);
    expect(names).toContain('qstyle.routes.json');
    expect(names).toContain('qstyle-manifest.json');
  });

  it('BLD-103: 同一 unit 集合の module は同一 pack を共有する', () => {
    const p = plugin();
    const code = `export const A = () => <div css={{ display: 'flex' }} />;`;
    const a = p.transform(code, '/src/s1.tsx');
    const b = p.transform(code, '/src/s2.tsx');
    const packOf = (c: string): string =>
      (c.match(/virtual:qstyle\/pack\/(q_[0-9a-f]+\.css)/) ?? [])[1] ?? '';
    expect(packOf(a?.code ?? '')).not.toBe('');
    expect(packOf(a?.code ?? '')).toBe(packOf(b?.code ?? ''));
    expect(p.load(`virtual:qstyle/pack/${packOf(a?.code ?? '')}`)).toContain('display:flex');
  });

  it('BLD-104: buildStart で dev 状態は消え HMR は未管理扱いに戻る', async () => {
    const p = devPlugin();
    const file = '/src/reset.tsx';
    const v1 = p.transform(`export const A = () => <div css={{ display: 'flex' }} />;`, file);
    const key: string = devKeyOf(v1?.code ?? '');
    expect(p.load(`virtual:qstyle/dev/${key}`)).toContain('display:flex');
    p.buildStart();
    // devCss/devKeys が消えている (stale を link しない)。
    expect(p.load(`virtual:qstyle/dev/${key}`)).toBe('');
    const { server, invalidated, sent } = trackingServer();
    await p.handleHotUpdate({
      file,
      read: async () => `export const A = () => <div css={{ display: 'flex' }} />;`,
      server,
    });
    // 未管理として扱われ、css-update を送る (古い devCode 比較はしない。
    // DOM 側は qwik:hmr が追随させる)。
    expect(invalidated).toHaveLength(1);
    expect(sentTypes(sent)).toEqual(['update']);
  });

  it('BLD-105: rebuild しても pack css と manifest は同一になる (stale 混入なし)', () => {
    const p = plugin();
    const a = `export const A = () => <div css={{ display: 'flex', gap: 8 }} />;`;
    const b = `export const B = () => <span css={{ color: 'red' }} />;`;
    const snapshot = (): { pack: string; manifest: string; registry: string } => {
      const oa = p.transform(a, '/src/rb-a.tsx');
      const ob = p.transform(b, '/src/rb-b.tsx');
      if (oa === null || ob === null) throw new Error('transform failed');
      const packOf = (c: string): string =>
        (c.match(/virtual:qstyle\/pack\/(q_[0-9a-f]+\.css)/) ?? [])[1] ?? '';
      const pack: string =
        (p.load(`virtual:qstyle/pack/${packOf(oa.code)}`) ?? '') +
        (p.load(`virtual:qstyle/pack/${packOf(ob.code)}`) ?? '');
      return {
        pack,
        manifest: p.load('virtual:qstyle/manifest') ?? '',
        registry: p.load('virtual:qstyle/registry') ?? '',
      };
    };
    const first = snapshot();
    p.buildStart();
    const second = snapshot();
    expect(second.pack).toBe(first.pack);
    expect(second.manifest).toBe(first.manifest);
    expect(second.registry).toBe(first.registry);
  });

  it('BLD-106: css-asset の units.json は収集 unit を漏れなく指す', () => {
    const { main, cssAsset } = generateOf({ backend: 'css-asset', diagnostics: 'silent' });
    main.buildStart();
    expect(
      main.transform(`export const A = () => <div css={{ display: 'flex' }} />;`, '/src/u1.tsx'),
    ).not.toBeNull();
    expect(
      main.transform(`export const B = () => <span css={{ color: 'blue' }} />;`, '/src/u2.tsx'),
    ).not.toBeNull();
    const { emitted, emitFile } = collectEmit();
    main.generateBundle.call({ emitFile });
    cssAsset.generateBundle.call({ emitFile });
    const units = JSON.parse(
      emitted.find((e) => e.fileName === 'qstyle.units.json')?.source ?? '{}',
    ) as { version: number; units: Record<string, string[]> };
    expect(units.version).toBe(1);
    const manifest = JSON.parse(
      emitted.find((e) => e.fileName === 'qstyle-manifest.json')?.source ?? '{}',
    ) as { manifest: Record<string, string[]> };
    const allUnits: string[] = Object.values(manifest.manifest).flat();
    expect(allUnits.length).toBeGreaterThan(0);
    for (const unit of allUnits) {
      expect(units.units[unit]).toBeDefined();
      // 指す先の asset が実際に emit されている。
      for (const file of units.units[unit] ?? []) {
        expect(emitted.some((e) => e.fileName === file)).toBe(true);
      }
    }
  });

  it('BLD-107: resolveId は virtual のみ解決し load の未知系は空/NULL で落とさない', () => {
    const p = plugin();
    expect(p.resolveId('virtual:qstyle/registry')).toBe('\0virtual:qstyle/registry');
    expect(p.resolveId('/virtual:qstyle/registry')).toBe('\0virtual:qstyle/registry');
    expect(p.resolveId('./foo')).toBeNull();
    expect(p.resolveId('virtual:other/x')).toBeNull();
    expect(p.resolveId('@qstyle/qwik')).toBeNull();
    // 未知 pack / 未知 dev key は空 CSS (404 ではなく後続配管を壊さない)。
    expect(p.load('virtual:qstyle/pack/deadbeef.css')).toBe('');
    expect(p.load('virtual:qstyle/dev/deadbeef.css')).toBe('');
    expect(p.load('virtual:qstyle/nope')).toBeNull();
    expect(p.load('./foo')).toBeNull();
  });

  it('BLD-108: dedup plugin は非 string source と非 css asset を素通しする', () => {
    const { dedup } = generateOf({ backend: 'qwik-native', diagnostics: 'silent' });
    const cssObj = { type: 'asset', fileName: 'assets/app.css', source: '.q_aaaaaaaa{color:red}' };
    const bufObj = {
      type: 'asset',
      fileName: 'assets/other.css',
      source: { toString: (): string => 'x' },
    };
    const jsObj = { type: 'chunk', fileName: 'assets/app.js', source: '.q_aaaaaaaa{color:red}' };
    const bundle: Record<string, unknown> = { a: cssObj, b: bufObj, c: jsObj };
    dedup.generateBundle({}, bundle);
    // css asset は通常処理、他は同一参照のまま。
    expect((bundle['b'] as { source: unknown }).source).toBe(bufObj.source);
    expect((bundle['c'] as { source: unknown }).source).toBe(jsObj.source);
  });
});
