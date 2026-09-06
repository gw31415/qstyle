import { describe, expect, it } from 'vitest';
import { qstyle as qstyleFactory } from './index.js';
import type { QstyleSourceMap } from './index.js';

/**
 * plan.md B-4 の PERF 系 (vite transform level で検証できるもの) + DED-014。
 * 目的は回帰検知 (緩い assert + 計測 log)。数値は report にも記録する。
 */

interface Transformable {
  transform: (code: string, id: string) => { code: string; map: QstyleSourceMap } | null;
  load: (id: string) => string | null;
}

interface DevPlugin extends Transformable {
  configResolved: (config: { command: string; mode: string }) => void;
  handleHotUpdate: (ctx: {
    file: string;
    server: {
      moduleGraph: {
        getModuleById: (id: string) => { id: string } | undefined;
        invalidateModule: (mod: unknown) => void;
      };
    };
  }) => void;
}

const qstyle = (options: Parameters<typeof qstyleFactory>[0]): Transformable =>
  qstyleFactory(options)[0] as unknown as Transformable;

const plugin = (): Transformable => qstyle({ diagnostics: 'silent' }) as Transformable;

const parametricPlugin = (): Transformable =>
  qstyle({
    diagnostics: 'silent',
    runtimeStyles: { promotion: 'always' },
  }) as unknown as Transformable;

/** 出力 code の pack import から pack css を取る。 */
function packCssOf(p: { load: (id: string) => string | null }, code: string): string {
  const m: RegExpMatchArray | null = /import "virtual:qstyle\/pack\/(q_[0-9a-f]+)\.css"/.exec(code);
  return m === null ? '' : (p.load(`virtual:qstyle/pack/${m[1]}.css`) ?? '');
}

/** registry の unit 数 (q_ を含む行数)。 */
function unitCount(p: { load: (id: string) => string | null }): number {
  return (p.load('virtual:qstyle/registry') ?? '').split('\n').filter((l) => l.includes('q_'))
    .length;
}

/** code 中の attr 出力の合計 bytes。 */
function attrBytes(code: string, re: RegExp): number {
  return [...code.matchAll(re)].reduce((sum, m) => sum + (m[0]?.length ?? 0), 0);
}

describe('qstyle PERF 系 (vite transform level)', () => {
  it(
    'PERF-002: 1000 identical static styles produce one class kind and one pack unit',
    () => {
      const p = plugin();
      const elements: string = Array.from(
        { length: 1000 },
        (_, i) => `<div css={{ display: 'flex', gap: 8 }} key={i} />`,
      ).join('');
      const code = `export const A = () => (<section>${elements}</section>);`;
      const started: number = Date.now();
      const out = p.transform(code, '/src/perf002.tsx');
      const ms: number = Date.now() - started;
      console.log(`[PERF-002] 1000 static occurrences transform: ${ms}ms`);
      expect(out).not.toBeNull();
      // 緩い回帰 guard (線形性の大幅悪化を検知する)。
      expect(ms).toBeLessThan(10_000);
      // 出力 class は 1 種類 (pack import の id は数えない)。
      const classes: Set<string> = new Set(
        [...(out?.code.matchAll(/class="([^"]*)"/g) ?? [])].flatMap((m) =>
          (m[1] ?? '').split(/\s+/).filter(Boolean),
        ),
      );
      expect(classes.size).toBe(1);
      // pack css は 1 unit。
      expect(unitCount(p)).toBe(1);
      const pack: string = packCssOf(p, out?.code ?? '');
      expect((pack.match(/display:flex/g) ?? []).length).toBe(1);
      expect(pack.length).toBeLessThan(200);
    },
    30_000,
  );

  it(
    'PERF-003: 1000 dynamic widths share one parametric structure (CSS stays 1 unit)',
    () => {
      const p = parametricPlugin();
      const elements: string = Array.from(
        { length: 1000 },
        (_, i) => `<div css={{ width: props.w${i} }} key={i} />`,
      ).join('');
      const code = `export const A = () => (<section>${elements}</section>);`;
      const started: number = Date.now();
      const out = p.transform(code, '/src/perf003.tsx');
      const ms: number = Date.now() - started;
      console.log(`[PERF-003] 1000 dynamic occurrences transform: ${ms}ms`);
      expect(out).not.toBeNull();
      expect(ms).toBeLessThan(10_000);
      const code2: string = out?.code ?? '';
      // class は 1 種類、serialize される CSS も 1 unit (pack import の id は数えない)。
      expect(
        new Set(
          [...code2.matchAll(/class="([^"]*)"/g)].flatMap((m) =>
            (m[1] ?? '').split(/\s+/).filter(Boolean),
          ),
        ),
      ).toHaveLength(1);
      expect(unitCount(p)).toBe(1);
      const pack: string = packCssOf(p, code2);
      expect(pack.match(/width:var\(--qstyle-[0-9a-f]{6}-0\)/g)).toHaveLength(1);
      // style var は要素毎 (1000 個)。
      expect((code2.match(/'--qstyle-[0-9a-f]{6}-0': props\.w\d+/g) ?? []).length).toBe(1000);
    },
    30_000,
  );

  it('PERF-007: a local module edit does not invalidate other modules devCss', () => {
    const p = qstyle({ diagnostics: 'silent' }) as unknown as DevPlugin;
    p.configResolved({ command: 'serve', mode: 'development' });
    const devCssOf = (code: string): string => {
      const key: string = (code.match(/virtual:qstyle\/dev\/([\w.]+)/) ?? [])[1] ?? '';
      expect(key).not.toBe('');
      return p.load(`virtual:qstyle/dev/${key}`) ?? '';
    };
    const a1 = p.transform(
      `export const A = () => <div css={{ display: 'flex' }} />;`,
      '/src/perf007-a.tsx',
    );
    const b = p.transform(
      `export const B = () => <span css={{ color: 'red' }} />;`,
      '/src/perf007-b.tsx',
    );
    expect(a1).not.toBeNull();
    expect(b).not.toBeNull();
    const cssB1: string = devCssOf(b?.code ?? '');
    expect(cssB1).toContain('color:red');
    // module A を局所変更 (再 transform)。
    const a2 = p.transform(
      `export const A = () => <div css={{ display: 'block' }} />;`,
      '/src/perf007-a.tsx',
    );
    expect(a2).not.toBeNull();
    expect(devCssOf(a2?.code ?? '')).toContain('display:block');
    // hot update は A の virtual css のみ無効化する。
    const requested: string[] = [];
    const invalidated: unknown[] = [];
    p.handleHotUpdate({
      file: '/src/perf007-a.tsx',
      server: {
        moduleGraph: {
          getModuleById: (id: string): { id: string } | undefined => {
            requested.push(id);
            return { id };
          },
          invalidateModule: (mod: unknown): void => {
            invalidated.push(mod);
          },
        },
      },
    });
    expect(requested).toHaveLength(1);
    // canonical dev id (`\0` 付き正規形)。
    expect(requested[0]?.startsWith('\0virtual:qstyle/dev/')).toBe(true);
    expect(invalidated).toHaveLength(1);
    // B の devCss は無効化されず同一内容のまま。
    expect(devCssOf(b?.code ?? '')).toBe(cssB1);
  });

  it(
    'PERF-008: a 10k-declaration composite module transforms within the time guard',
    () => {
      const p = plugin();
      // 2000 要素 x 5 宣言 = 10k 宣言。marginTop で unit を全て固有にする。
      const elements: string = Array.from(
        { length: 2000 },
        (_, i) =>
          `<div css={{ display: 'flex', gap: 8, marginTop: ${i}, color: 'red', opacity: 0.5 }} key={i} />`,
      ).join('');
      const code = `export const A = () => (<section>${elements}</section>);`;
      const started: number = Date.now();
      const out = p.transform(code, '/src/perf008.tsx');
      const ms: number = Date.now() - started;
      console.log(`[PERF-008] 10k declarations (2000 units) transform: ${ms}ms`);
      expect(out).not.toBeNull();
      expect(ms).toBeLessThan(30_000);
      // 出力妥当: 2000 unit が全て pack に入る。
      expect(unitCount(p)).toBe(2000);
      const pack: string = packCssOf(p, out?.code ?? '');
      expect((pack.match(/\.q_[0-9a-f]{8}\{/g) ?? []).length).toBe(2000);
      expect(pack).toContain('margin-top:1999px');
      expect(pack).toContain('opacity:0.5');
    },
    60_000,
  );

  it(
    'PERF-009: 100k occurrence scale serialize/dedup completes within the guard',
    () => {
      const plugins = qstyleFactory({ backend: 'css-asset', diagnostics: 'silent' }) as unknown as (
        | Record<string, unknown>
        | undefined
      )[];
      const main: Record<string, unknown> | undefined = plugins.find(
        (x) => x?.['name'] === 'qstyle',
      );
      const cssAsset: Record<string, unknown> | undefined = plugins.find(
        (x) => x?.['name'] === 'qstyle:css-asset',
      );
      if (main === undefined || cssAsset === undefined) throw new Error('plugin not found');
      const buildStart = main['buildStart'] as () => void;
      const transform = main['transform'] as (
        code: string,
        id: string,
      ) => { code: string } | null;
      const mainGenerate = main['generateBundle'] as (
        this: { emitFile: (f: { fileName: string; source: string }) => void },
      ) => void;
      const cssGenerate = cssAsset['generateBundle'] as (
        this: { emitFile: (f: { fileName: string; source: string }) => void },
      ) => void;

      // 100k occurrence (同一宣言)。serialize/dedup 配線 (css-asset generateBundle) まで通す。
      const elements: string = Array.from(
        { length: 100_000 },
        (_, i) => `<div css={{ color: 'red' }} key={i} />`,
      ).join('');
      const code = `export const A = () => (<section>${elements}</section>);`;

      const started: number = Date.now();
      buildStart();
      const out = transform(code, '/src/perf009.tsx');
      const emitted: { fileName: string; source: string }[] = [];
      const emit = (f: { fileName: string; source: string }): void => {
        emitted.push(f);
      };
      mainGenerate.call({ emitFile: emit });
      cssGenerate.call({ emitFile: emit });
      const ms: number = Date.now() - started;
      console.log(`[PERF-009] 100k occurrences transform+serialize+dedup: ${ms}ms`);
      expect(out).not.toBeNull();
      expect(ms).toBeLessThan(60_000);
      // 出力 CSS は occurrence 数に比例しない (1 rule)。
      const cssAssets = emitted.filter((e) => /^assets\/qstyle\.q_[0-9a-f]+\.css$/.test(e.fileName));
      expect(cssAssets).toHaveLength(1);
      expect((cssAssets[0]?.source.match(/color:red/g) ?? []).length).toBe(1);
      const unitsAsset = emitted.find((e) => e.fileName === 'qstyle.units.json');
      const units: Record<string, string[]> = (
        JSON.parse(unitsAsset?.source ?? '{}') as { units: Record<string, string[]> }
      ).units;
      expect(Object.keys(units)).toHaveLength(1);
    },
    120_000,
  );

  it('PERF-010: promotion always vs never byte tradeoff (measurement log)', () => {
    const elements: string = Array.from(
      { length: 100 },
      (_, i) => `<div css={{ display: 'flex', width: props.w${i} }} key={i} />`,
    ).join('');
    const code = `export const A = () => (<section>${elements}</section>);`;

    const measure = (p: Transformable, label: string): void => {
      const out = p.transform(code, `/src/perf010-${label}.tsx`);
      expect(out).not.toBeNull();
      const code2: string = out?.code ?? '';
      const classBytes: number = attrBytes(code2, /class="[^"]*"/g);
      const styleBytes: number = attrBytes(code2, /style=\{\{[^}]*\}\}/g);
      const cssBytes: number = packCssOf(p, code2).length;
      console.log(
        `[PERF-010] promotion=${label}: classAttr=${classBytes}B styleAttr=${styleBytes}B css=${cssBytes}B`,
      );
    };
    measure(parametricPlugin(), 'always');
    measure(
      qstyle({
        diagnostics: 'silent',
        runtimeStyles: { promotion: 'never' },
      }) as unknown as Transformable,
      'never',
    );
    // snapshot 的 log であり厳密な assert はしない (回帰検知は log 値で行う)。
  });

  it(
    'DED-014: 10k occurrences of one declaration do not scale the output CSS',
    () => {
      const p = plugin();
      const elements: string = Array.from(
        { length: 10_000 },
        (_, i) => `<div css={{ color: 'red' }} key={i} />`,
      ).join('');
      const code = `export const A = () => (<section>${elements}</section>);`;
      const started: number = Date.now();
      const out = p.transform(code, '/src/ded014.tsx');
      const ms: number = Date.now() - started;
      console.log(`[DED-014] 10k identical occurrences transform: ${ms}ms`);
      expect(out).not.toBeNull();
      expect(ms).toBeLessThan(10_000);
      // 出力 CSS は occurrence 数に比例しない (1 unit + class 参照のみ)。
      expect(unitCount(p)).toBe(1);
      const pack: string = packCssOf(p, out?.code ?? '');
      expect((pack.match(/color:red/g) ?? []).length).toBe(1);
      expect(pack.length).toBeLessThan(100);
      expect(
        new Set(
          [...(out?.code.matchAll(/class="([^"]*)"/g) ?? [])].flatMap((m) =>
            (m[1] ?? '').split(/\s+/).filter(Boolean),
          ),
        ),
      ).toHaveLength(1);
    },
    30_000,
  );
});
