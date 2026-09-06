// '@qwik.dev/router' の unit test 用 stub (R1.4/R1.5 の links.tsx が使う surface のみ)。
//
// 実 router package (`lib/index.qwik.mjs`) は qwik city vite plugin が供給する
// virtual module (`@qwik-router-config`) を import するため、plugin を通らない
// vitest では module load 時に失敗する。qwik city との統合 (component の full render、
// SSG で link が焼かれる等) は QWK-001..004 / RTE-004..007 相当として C0.1/C0.2 の
// Playwright 基盤で検証するため、ここでは useLocation の最小実装のみ供給する。
// 型は tsc --noEmit が実 package の型に対して検証するため、stub の型の正確性は
// 重要でない (runtime 依存の解決のみが目的)。

interface StubRouteLocation {
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly isNavigating: boolean;
  readonly prevUrl: URL | undefined;
}

export const useLocation = (): StubRouteLocation => ({
  url: new URL('https://example.test/'),
  params: {},
  isNavigating: false,
  prevUrl: undefined,
});
