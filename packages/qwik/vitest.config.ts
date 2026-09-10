import { defineConfig } from 'vitest/config';

// @qwik.dev/core の dist は bare global `__EXPERIMENTAL__` (通常は qwik vite plugin
// の optimizer が field 参照を true/false に置換する) を前提としており、qwik plugin
// を通らない vitest では実行時に ReferenceError になる。全 experimental feature を
// off にした object を define して供給する (test 対象は core runtime ではない)。
export default defineConfig({
  define: {
    __EXPERIMENTAL__: '{ "each": false, "errorBoundary": false, "show": false, "suspense": false }',
  },
});
