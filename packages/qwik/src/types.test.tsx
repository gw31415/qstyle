// TYP-001..013 (plan.md B-2): 型レベル期待の固定 (type harness)。
//
// この file の本体は tsc (package tsconfig: strict / exactOptionalPropertyTypes /
// noUncheckedIndexedAccess) で compile されること自体。`pnpm --filter @qstyle/qwik
// exec tsc --noEmit` が green なら全 TYP 期待が成立している。runtime (vitest) は
// no-op または軽い fs check のみで、ここでは CSS の意味検証を行わない。
//
// TYP-008/013: `css` prop は consumer 側 module augmentation
// (README「css prop の型」) で付与する。本 test file 内で同一の augmentation を
// 行い、(a) prop が StyleHandle を受けること (b) augmentation が package 全体の
// compile (links.tsx が @qwik.dev/core/internal を直接 import している) と衝突
// しないこと、を検証する。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JSXOutput } from '@qwik.dev/core';
import type { HTMLElementAttrs } from '@qwik.dev/core/internal';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { isStyleHandle } from './compose.js';
import { css } from './index.js';
import type { CssProp, StyleHandle, StyleObject } from './index.js';
import { QstyleLinks } from './links.js';
import type { QstyleLinksProps } from './links.js';

declare module '@qwik.dev/core/internal' {
  interface HTMLElementAttrs {
    css?: CssProp;
  }
}

describe('TYP: authoring API 型の固定', () => {
  it('TYP-001: css({ display: "flex" }) の property を許容する', () => {
    const style: StyleObject = { display: 'flex' };
    expectTypeOf(css(style)).toEqualTypeOf<StyleHandle>();
    // property 値は string | number primitive (boolean/null/undefined は falsy 消化)。
    const mixed: StyleObject = { zIndex: 10, color: 'red', opacity: 0.5, gap: undefined };
    expectTypeOf(css(mixed)).toEqualTypeOf<StyleHandle>();
  });

  it('TYP-002 (現状固定): typo property は型 error にならない (free-form)', () => {
    // 現状の StyleObject は任意 string key を許容する index signature のため、
    // `displayy` のような typo は compile を通ってしまう。CSX 的な既知 property
    // 集合による制約導入は src 側の型変更を要するため、ここでは「現状の挙動」を
    // 固定するのみ (制約導入は課題として記録。report 参照)。
    // 制約を導入した際はこの test を `// @ts-expect-error` 付きの error 期待へ反転
    // させること。
    const withTypo: StyleObject = { displayy: 'flex' };
    expectTypeOf(withTypo).toMatchTypeOf<StyleObject>();
    // runtime 側も落とされず atom 化される (property 名として構文は正当なため)。
    expect(isStyleHandle(css(withTypo))).toBe(true);
  });

  it('TYP-003: custom property (--x) を許容する', () => {
    const style: StyleObject = { '--qstyle-gap': '8px' };
    expectTypeOf(css(style)).toEqualTypeOf<StyleHandle>();
  });

  it('TYP-004: nested selector key (&:hover) を許容する', () => {
    const style: StyleObject = {
      '&:hover': { backgroundColor: 'var(--surface-hover)' },
      '& .tile': { padding: 4 },
    };
    expectTypeOf(css(style)).toEqualTypeOf<StyleHandle>();
  });

  it('TYP-005: at-rule key (@media / @supports / @container) を許容する', () => {
    const style: StyleObject = {
      '@media (width >= 768px)': { padding: 16 },
      '@supports (display: grid)': { display: 'grid' },
      '@container card (min-width: 400px)': { flexDirection: 'row' },
    };
    expectTypeOf(css(style)).toEqualTypeOf<StyleHandle>();
  });

  it('TYP-006: css(object) は StyleHandle を推論する', () => {
    expectTypeOf(css({ display: 'flex' })).toEqualTypeOf<StyleHandle>();
    expectTypeOf(css({ display: 'flex' }).atoms).toEqualTypeOf<readonly import('./index.js').StyleHandle['atoms'][number][]>();
  });

  it('TYP-007: css`...` (tagged template) は StyleHandle を推論する', () => {
    expectTypeOf(css`display:flex;`).toEqualTypeOf<StyleHandle>();
    const dynamic = (w: number): StyleHandle => css`
      width: ${w}px;
    `;
    expectTypeOf(dynamic(10)).toEqualTypeOf<StyleHandle>();
  });

  it('TYP-008: css prop (module augmentation 経由) は handle を受け取れる', () => {
    expectTypeOf<HTMLElementAttrs['css']>().toEqualTypeOf<CssProp | undefined>();
    // render 関数は型検証専用で呼ばない (JSX runtime 実行を伴わせない)。
    const renderWithHandle = (): JSXOutput => <div css={css({ display: 'flex' })} />;
    expectTypeOf(renderWithHandle).toBeFunction();
  });

  it('TYP-009: css prop は array / falsy を受け取れる', () => {
    const base: StyleHandle = css({ display: 'flex' });
    const selected: StyleHandle = css({ color: 'red' });
    const renderWithArray = (): JSXOutput => (
      <div css={[base, false && selected, null, undefined, [{ padding: 0 }]]} />
    );
    const renderWithFalsy = (): JSXOutput => <div css={false} />;
    const renderWithObject = (cond: boolean): JSXOutput => (
      <div css={cond ? selected : null} />
    );
    expectTypeOf(renderWithArray).toBeFunction();
    expectTypeOf(renderWithFalsy).toBeFunction();
    expectTypeOf(renderWithObject).toBeFunction();
  });

  it('TYP-010: css prop に number 等の invalid primitive は型 error', () => {
    // CssProp = StyleObject | StyleHandle | false | null | undefined | readonly CssProp[]
    // のため、5 のような truthy primitive は含まれない (falsy のみ例外的に許容)。
    // @ts-expect-error number primitive は CssProp に割り当てられない
    const invalidPrimitive: CssProp = 5;
    // JSX 属性位置でも同様に error になること。
    const renderWithInvalid = (): JSXOutput => (
      <div
        // @ts-expect-error number primitive は css prop に割り当てられない
        css={5}
      />
    );
    // (5 が割り当てられるのは @ts-expect-error で示した通り error であること自体が期待)
    expectTypeOf(renderWithInvalid).toBeFunction();
  });

  describe('TYP-011: declaration file emit (dist/*.d.ts)', () => {
    const here: string = dirname(fileURLToPath(import.meta.url));
    const distDir: string = join(here, '..', 'dist');
    // dist は gitignore されているため、build 未実行環境では skip する。
    const maybe = distDir.startsWith('/') && existsSync(distDir) ? it : it.skip;

    const EXPECTED_DECLARATIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
      [
        'index.d.mts',
        [
          'css',
          'StyleHandle',
          'StyleObject',
          'CssProp',
          'lowerStyleObject',
          'lowerTaggedTemplate',
          'composeCssProp',
          'flattenCssProp',
          'isStyleHandle',
          'parseNestedKey',
        ],
      ],
      [
        'index.d.cts',
        ['css', 'StyleHandle', 'CssProp', 'lowerStyleObject', 'lowerTaggedTemplate'],
      ],
      ['client.d.mts', ['ensureModuleStyles', 'ensureStylesheet', 'resolveAssetUrl']],
      ['links.qwik.d.mts', ['QstyleLinks']],
    ];

    it('主要 API 型が dist の .d.ts に含まれる', () => {
      for (const [fileName, markers] of EXPECTED_DECLARATIONS) {
        const filePath: string = join(distDir, fileName);
        expect(existsSync(filePath), `${fileName} が build 成果物に存在する`).toBe(true);
        const text: string = readFileSync(filePath, 'utf8');
        for (const marker of markers) {
          expect(text, `${fileName} に ${marker} が含まれる`).toContain(marker);
        }
      }
    });
  });

  it('TYP-012: strict mode (package tsconfig) で型 error なし', () => {
    // 本 file 自体が strict / exactOptionalPropertyTypes / noUncheckedIndexedAccess
    // で compile される (typecheck script = tsc --noEmit が通ること自体が検証)。
    // ここでは設定が strict であることを追加確認する。
    const here: string = dirname(fileURLToPath(import.meta.url));
    const baseConfig: { compilerOptions?: { strict?: unknown } } = JSON.parse(
      readFileSync(join(here, '..', '..', '..', 'tsconfig.base.json'), 'utf8'),
    ) as { compilerOptions?: { strict?: unknown } };
    expect(baseConfig.compilerOptions?.strict).toBe(true);
    const pkgConfig: { extends?: unknown; compilerOptions?: { strict?: unknown } } = JSON.parse(
      readFileSync(join(here, '..', 'tsconfig.json'), 'utf8'),
    ) as { extends?: unknown; compilerOptions?: { strict?: unknown } };
    expect(pkgConfig.compilerOptions?.strict).toBeUndefined();
  });

  it('TYP-013: css prop augmentation は package 全体 compile と衝突しない', () => {
    // augmentation (冒頭の declare module) は package 全体の tsc compile に載る。
    // 同一 compile 内で @qwik.dev/core/internal を直接使う links.tsx (QstyleLinks) と
    // 共存することを型レベルで確認する (tsc --noEmit が green なら衝突なし)。
    expectTypeOf<HTMLElementAttrs['css']>().toEqualTypeOf<CssProp | undefined>();
    const props: QstyleLinksProps = {};
    const renderAugmented = (): JSXOutput => (
      <QstyleLinks prefetch="hover" {...props} />
    );
    const renderTogether = (): JSXOutput => (
      <main css={css({ display: 'flex' })}>
        <QstyleLinks prefetch="hover" {...props} />
      </main>
    );
    expectTypeOf(renderAugmented).toBeFunction();
    expectTypeOf(renderTogether).toBeFunction();
  });
});
