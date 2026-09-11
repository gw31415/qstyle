import { createRequire } from 'node:module';
import type { ResolvedConfig } from 'vite';

export type CssNormalizer = (css: string) => string;
const browserNames: Record<string, string | false> = {
  chrome: 'chrome', edge: 'edge', firefox: 'firefox', ie: 'ie', ios: 'ios_saf',
  opera: 'opera', safari: 'safari', node: false, hermes: false, rhino: false,
};

/** Match Vite 8 browser targets; unknown/ES-year targets conservatively opt out. */
export function createCssNormalizer(config: ResolvedConfig): CssNormalizer | undefined {
  if (config.build.cssMinify === false) return (css) => css;
  if (config.build.cssMinify === 'esbuild' || config.css.transformer === 'lightningcss') return undefined;
  const targets: Record<string, number> = {};
  const configured = config.build.cssTarget;
  for (const entry of !configured ? [] : Array.isArray(configured) ? configured : [configured]) {
    if (entry === 'esnext') continue;
    const match = /^([a-z]+)(\d+)(?:\.(\d+))?(?:\.\d+)?$/.exec(entry);
    if (!match) return undefined;
    const browser = browserNames[match[1]!];
    if (browser === false) continue;
    if (!browser) return undefined;
    const version = Number(match[2]) << 16 | Number(match[3] ?? 0) << 8;
    targets[browser] = Math.min(targets[browser] ?? Infinity, version);
  }
  // Use the installed Vite peer's own minifier version, avoiding a second native
  // dependency whose canonicalization could differ from the actual build.
  try {
    const require = createRequire(import.meta.url);
    const lightningcss = createRequire(require.resolve('vite'))('lightningcss') as {
      transform(options: Record<string, unknown>): { code: Uint8Array };
    };
    return (css) => Buffer.from(lightningcss.transform({
      ...config.css.lightningcss,
      targets: Object.keys(targets).length ? targets : undefined,
      filename: 'style.css', code: Buffer.from(css), minify: true,
      cssModules: undefined, visitor: undefined, customAtRules: undefined,
    }).code).toString();
  } catch {
    return undefined;
  }
}
