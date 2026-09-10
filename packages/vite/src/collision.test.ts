// Release blocker 1 (hash collision fail-closed) の vite 統合テスト。
//
// 32-bit hash (fnv1aHex) は変更しない。代わりに「異なる入力が同じ生成 id に
// なった場合」を成果物出力前に deterministic error にする。テストは確率的探索に
// 依存せず、birthday search で事前に特定した既知の FNV-1a 衝突ペア (固定値) を
// 使う — hash algorithm が不変である限り常に決定的に再現する。
//
// ペアの導出: scripts 側で createStaticAtom / hashStaticAtom / fnv1aHex /
// buildKeyframesRule (すべて @qstyle/core public API) を使った birthday search。
import { describe, expect, it } from 'vitest';
import { qstyle as qstyleFactory } from './index.js';

interface Transformable {
  readonly name?: string;
  configResolved: (config: { command: string; mode: string; root: string }) => void;
  buildStart: () => void;
  transform: (code: string, id: string) => { code: string } | null;
  generateBundle: (this: { emitFile: (f: { fileName: string; source: string }) => void }) => void;
}

type Plugins = readonly [Transformable, ...unknown[]];

const pluginsOf = (options: Parameters<typeof qstyleFactory>[0]): Plugins =>
  qstyleFactory(options) as unknown as Plugins;

/** 既知の atom-level 衝突ペア (hashStaticAtom が同一になる別々の color 値)。 */
const ATOM_PAIR = {
  a: 'shade-422789',
  b: 'shade-639192',
  id: 'q_4c05fbff',
} as const;

/** 既知の keyframes-level 衝突ペア (qkf_ 名が同一になる別々の frame 内容)。 */
const KEYFRAMES_PAIR = { a: 'step-32921', b: 'step-694620', name: 'qkf_f29b9284' } as const;

/** 既知の pack-level 衝突ペア (unit set hash が同一になる別々の unit)。 */
const PACK_PAIR = { a: 'tone-117446', b: 'tone-122155', packId: 'q_65d91672' } as const;

const colorModule = (value: string): string =>
  `export const A = () => <div css={{ color: '${value}' }} />;`;

const keyframesModule = (value: string): string => `export const A = () => (
  <div css={{ '@keyframes spin': { from: { opacity: 0 }, to: { opacity: '${value}' } }, animation: 'spin 1s' }} />
);`;

describe('collision detection: unit collection (release blocker 1)', () => {
  it('同一入力の重複は dedupe され成功する', () => {
    const [main] = pluginsOf({});
    const outA = main.transform(colorModule('red'), '/src/dup-a.tsx');
    const outB = main.transform(colorModule('red'), '/src/dup-b.tsx');
    expect(outA).not.toBeNull();
    expect(outB).not.toBeNull();
    // 同一 unit にマージされる (class も同一)。
    const classOf = (code: string): string =>
      (code.match(/class="(q_[0-9a-f]{8})"/) ?? [])[1] ?? '';
    expect(classOf(outB?.code ?? '')).toBe(classOf(outA?.code ?? ''));
  });

  it('異なる入力が同一 atom/unit id になったら transform が失敗する (既知ペア)', () => {
    const [main] = pluginsOf({});
    expect(main.transform(colorModule(ATOM_PAIR.a), '/src/col-a.tsx')).not.toBeNull();
    expect(() => main.transform(colorModule(ATOM_PAIR.b), '/src/col-b.tsx')).toThrow(
      /hash collision/,
    );
    // error は id と両 module を含む (deterministic)。
    try {
      main.transform(colorModule(ATOM_PAIR.b), '/src/col-b.tsx');
      throw new Error('expected collision');
    } catch (error) {
      const message: string = (error as Error).message;
      expect(message).toContain(ATOM_PAIR.id);
      expect(message).toContain('/src/col-a.tsx');
      expect(message).toContain('/src/col-b.tsx');
    }
  });

  it('入力順に依存せず、後から登録した側で必ず失敗する', () => {
    const [main] = pluginsOf({});
    expect(main.transform(colorModule(ATOM_PAIR.b), '/src/col-b.tsx')).not.toBeNull();
    expect(() => main.transform(colorModule(ATOM_PAIR.a), '/src/col-a.tsx')).toThrow(
      /hash collision/,
    );
  });

  it('buildStart で registry は reset される (incremental build で決定的に再検出)', () => {
    const [main] = pluginsOf({});
    main.buildStart();
    expect(main.transform(colorModule(ATOM_PAIR.a), '/src/col-a.tsx')).not.toBeNull();
    expect(() => main.transform(colorModule(ATOM_PAIR.b), '/src/col-b.tsx')).toThrow(
      /hash collision/,
    );
    // 次の build pass では片方だけなら成功する。
    main.buildStart();
    expect(main.transform(colorModule(ATOM_PAIR.a), '/src/col-a.tsx')).not.toBeNull();
    // 両方なら再度失敗する (警告化・無視されない)。
    main.buildStart();
    expect(main.transform(colorModule(ATOM_PAIR.a), '/src/col-a.tsx')).not.toBeNull();
    expect(() => main.transform(colorModule(ATOM_PAIR.b), '/src/col-b.tsx')).toThrow(
      /hash collision/,
    );
  });

  it('diagnostics: silent でも衝突は警告化されず失敗する', () => {
    const [main] = pluginsOf({ diagnostics: 'silent' });
    expect(main.transform(colorModule(ATOM_PAIR.a), '/src/col-silent-a.tsx')).not.toBeNull();
    expect(() => main.transform(colorModule(ATOM_PAIR.b), '/src/col-silent-b.tsx')).toThrow(
      /hash collision/,
    );
  });

  it('dev の occurrence 固定 alias は同一 module の再変換 (HMR) で更新され衝突扱いしない', () => {
    const [main] = pluginsOf({});
    main.configResolved({ command: 'serve', mode: 'development', root: '/app' });
    main.buildStart();
    const first = main.transform(colorModule('red'), '/src/hmr.tsx');
    expect(first).not.toBeNull();
    const classOf = (code: string): string =>
      (code.match(/class="(qd_[0-9a-f]+a_0_0)"/) ?? [])[1] ?? '';
    const alias: string = classOf(first?.code ?? '');
    expect(alias).not.toBe('');
    // 値を変えて再変換 — 同一 alias に新しい内容が載る (衝突 error にしない)。
    const second = main.transform(colorModule('blue'), '/src/hmr.tsx');
    expect(second).not.toBeNull();
    expect(classOf(second?.code ?? '')).toBe(alias);
  });
});

describe('collision detection: global rules / packs', () => {
  it('異なる内容の keyframes が同名 (qkf_*) になったら失敗する (既知ペア)', () => {
    const [main] = pluginsOf({});
    expect(main.transform(keyframesModule(KEYFRAMES_PAIR.a), '/src/kf-a.tsx')).not.toBeNull();
    expect(() => main.transform(keyframesModule(KEYFRAMES_PAIR.b), '/src/kf-b.tsx')).toThrow(
      /hash collision/,
    );
    try {
      main.transform(keyframesModule(KEYFRAMES_PAIR.b), '/src/kf-b.tsx');
      throw new Error('expected collision');
    } catch (error) {
      expect((error as Error).message).toContain(KEYFRAMES_PAIR.name);
    }
  });

  it('同一内容の keyframes は別 module でも dedupe される', () => {
    const [main] = pluginsOf({});
    expect(main.transform(keyframesModule('fade-x'), '/src/kf-dup-a.tsx')).not.toBeNull();
    expect(main.transform(keyframesModule('fade-x'), '/src/kf-dup-b.tsx')).not.toBeNull();
  });

  it('異なる unit set が同一 pack id になったら失敗する (qwik-native, 既知ペア)', () => {
    const [main] = pluginsOf({});
    expect(main.transform(colorModule(PACK_PAIR.a), '/src/pack-a.tsx')).not.toBeNull();
    let message: string = '';
    try {
      main.transform(colorModule(PACK_PAIR.b), '/src/pack-b.tsx');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/hash collision/);
    expect(message).toContain(PACK_PAIR.packId);
    expect(message).toContain('/src/pack-a.tsx');
    expect(message).toContain('/src/pack-b.tsx');
  });
});
