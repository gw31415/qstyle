import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// links.tsx (R1.4/R1.5) の unit test が '@qwik.dev/core' / '@qwik.dev/router' を
// import するための設定。
//
// - @qwik.dev/core の dist は bare global `__EXPERIMENTAL__` (通常は qwik vite plugin
//   の optimizer が field 参照を true/false に置換する) を前提としており、qwik plugin
//   を通らない vitest では実行時に ReferenceError になる。全 experimental feature を
//   off にした object を define して供給する (test 対象は core runtime ではない)。
// - @qwik.dev/router の runtime は qwik city vite plugin が供給する virtual module
//   (`@qwik-router-config`) に依存するため、plugin を通らない vitest では load でき
//   ない。links.tsx が使う useLocation のみの stub (./test-stubs/router.ts) に差し
//   替える。型は tsc --noEmit が実 package に対して検証する。
export default defineConfig({
  define: {
    __EXPERIMENTAL__: '{ "each": false, "errorBoundary": false, "show": false, "suspense": false }',
  },
  resolve: {
    alias: {
      '@qwik.dev/router': fileURLToPath(new URL('./test-stubs/router.ts', import.meta.url)),
    },
  },
});
