import { describe, expect, it } from 'vitest';
import { resolveConfig } from 'vite';
import { createCssNormalizer } from './css-minifier.js';

describe('minifier-aware compression configuration', () => {
  it('measures source directly when minification is disabled', async () => {
    const config = await resolveConfig({ configFile: false, build: { cssMinify: false } }, 'build');
    const css = '.q_aaaaaaaa { color: red; }';
    expect(createCssNormalizer(config)?.(css)).toBe(css);
  });

  it.each([
    { build: { cssMinify: 'esbuild' as const } },
    { build: { cssMinify: true as const, cssTarget: 'es2020' } },
    { css: { transformer: 'lightningcss' as const }, build: { cssMinify: true as const } },
  ])('opts out when it cannot model downstream processing: %j', async (options) => {
    const config = await resolveConfig({ configFile: false, ...options }, 'build');
    expect(createCssNormalizer(config)).toBeUndefined();
  });
});
