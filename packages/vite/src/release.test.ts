// Release blocker 3 (unsupported Qwik style の fail-closed) のテスト。
//
// Qwik には runtime `css` prop 実装が存在しないため、transform で untouched として
// 残った `css={...}` は「style が黙って消える」fallback にはならない。build
// (publishable output) では既定 (diagnostics 'error') で compile error にする。
// 'warning' / 'silent' は migration 用の legacy mode として明示指定のみ残る。
import { describe, expect, it, vi } from 'vitest';
import { qstyle as qstyleFactory } from './index.js';

interface Transformable {
  readonly name?: string;
  configResolved: (config: { command: string; mode: string; root: string }) => void;
  buildStart: () => void;
  transform: (code: string, id: string) => { code: string } | null;
}

type Plugins = readonly [Transformable, ...unknown[]];

const pluginsOf = (options: Parameters<typeof qstyleFactory>[0]): Plugins =>
  qstyleFactory(options) as unknown as Plugins;

const buildPlugin = (options: Parameters<typeof qstyleFactory>[0] = {}): Transformable => {
  const [main] = pluginsOf(options);
  main.configResolved({ command: 'build', mode: 'production', root: '/app' });
  main.buildStart();
  return main;
};

const devPlugin = (options: Parameters<typeof qstyleFactory>[0] = {}): Transformable => {
  const [main] = pluginsOf(options);
  main.configResolved({ command: 'serve', mode: 'development', root: '/app' });
  main.buildStart();
  return main;
};

describe('release build の既定は fail-closed (release blocker 3)', () => {
  it('spread を含む css prop は compile error になる (既定 diagnostics = error)', () => {
    const p = buildPlugin({ backend: 'qwik-native' });
    expect(() =>
      p.transform(`export const A = () => <div css={{ ...base }} />;`, '/src/rel-1.tsx'),
    ).toThrow(/\[qstyle\] \/src\/rel-1\.tsx: /);
  });

  it('call 式の動的値は compile error になる', () => {
    const p = buildPlugin({ backend: 'qwik-native' });
    expect(() =>
      p.transform(
        `export const A = () => <div css={{ display: getWidth() }} />;`,
        '/src/rel-2.tsx',
      ),
    ).toThrow(/\[qstyle\]/);
  });

  it('未解決 (cross-module) handle 参照は compile error になる', () => {
    const p = buildPlugin({ backend: 'qwik-native' });
    expect(() =>
      p.transform(
        `import { base } from './styles';\nexport const A = () => <div css={base} />;`,
        '/src/rel-3.tsx',
      ),
    ).toThrow(/\[qstyle\]/);
  });

  it('動的 animation とローカル @keyframes の併用は compile error になる', () => {
    const p = buildPlugin({ backend: 'qwik-native' });
    expect(() =>
      p.transform(
        `export const A = () => <div css={{ '@keyframes spin': { from: { opacity: 0 }, to: { opacity: 1 } }, animation: props.dur }} />;`,
        '/src/rel-4.tsx',
      ),
    ).toThrow(/\[qstyle\]/);
  });

  it('不正な custom property 名は residual 経由で compile error になる (release blocker 2 との連動)', () => {
    const p = buildPlugin({ backend: 'qwik-native' });
    expect(() =>
      p.transform(
        `export const A = () => <div css={{ '--x}body{color:red': 'red' }} />;`,
        '/src/rel-5.tsx',
      ),
    ).toThrow(/unsafe to atomicize/);
  });

  it('サポート済みの static / dynamic 値は build 既定でも成功する', () => {
    const p = buildPlugin({ backend: 'qwik-native' });
    const staticOut = p.transform(
      `export const A = () => <div css={{ display: 'flex' }} />;`,
      '/src/rel-ok-1.tsx',
    );
    expect(staticOut?.code).toMatch(/class="q_[0-9a-f]{8}"/);
    const dynamicOut = p.transform(
      `export const A = (props: { w: string }) => <div css={{ width: props.w }} />;`,
      '/src/rel-ok-2.tsx',
    );
    expect(dynamicOut?.code).not.toContain('css={{');
    expect(dynamicOut?.code).toMatch(/style=\{\{/);
  });

  it('genuinely no-op な css prop は成功する (NotNeeded 分類)', () => {
    const p = buildPlugin({ backend: 'qwik-native' });
    // falsy 値のみ (適用すべき style が存在しない)。
    expect(p.transform(`export const A = () => <div css={false} />;`, '/src/noop-1.tsx')).toBeNull();
    expect(p.transform(`export const A = () => <div css={{}} />;`, '/src/noop-2.tsx')).toBeNull();
    expect(
      p.transform(`export const A = () => <div css={{ color: null }} />;`, '/src/noop-3.tsx'),
    ).toBeNull();
    expect(
      p.transform(`export const A = () => <div css={{ color: false }} />;`, '/src/noop-4.tsx'),
    ).toBeNull();
    // `undefined` 値は identifier として動的扱い (既存動作): css prop は外れ、
    // slot var 経由で unset 相当になる — 失敗ではなく適用済み。
    const undef = p.transform(
      `export const A = () => <div css={{ color: undefined }} />;`,
      '/src/noop-5.tsx',
    );
    expect(undef?.code).not.toContain('css={{');
  });
});

describe('legacy warning mode と dev の互換性', () => {
  it("明示指定した diagnostics: 'warning' は legacy mode として動作し styles が失われ得る旨を警告する", () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const p = buildPlugin({ backend: 'qwik-native', diagnostics: 'warning' });
      const out = p.transform(
        `export const A = () => <div css={{ ...base }} />;`,
        '/src/legacy-1.tsx',
      );
      expect(out).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toMatch(/untouched/);
    } finally {
      spy.mockRestore();
    }
  });

  it("明示指定した diagnostics: 'silent' も legacy として成功する", () => {
    const p = buildPlugin({ backend: 'qwik-native', diagnostics: 'silent' });
    expect(
      p.transform(`export const A = () => <div css={{ ...base }} />;`, '/src/legacy-2.tsx'),
    ).toBeNull();
  });

  it('dev (serve) の既定は従来どおり warning (HMR で復帰できる)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const p = devPlugin({ backend: 'qwik-native' });
      const out = p.transform(
        `export const A = () => <div css={{ ...base }} />;`,
        '/src/dev-1.tsx',
      );
      expect(out).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("明示指定の diagnostics: 'error' は dev でも従来どおり throw する (DIA-008 互換)", () => {
    const p = devPlugin({ backend: 'qwik-native', diagnostics: 'error' });
    expect(() =>
      p.transform(`export const A = () => <div css={{ ...base }} />;`, '/src/dev-2.tsx'),
    ).toThrow(/\[qstyle\]/);
  });
});
