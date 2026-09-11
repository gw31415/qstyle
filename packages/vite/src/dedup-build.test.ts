import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { qstyle } from './index.js';
import { measureCss } from './dedup.js';

describe('build CSS compression delivery', () => {
  it.each([false, true])('optimizes before hashing and shares inline output with cssMinify=%s', async (cssMinify) => {
    const root = mkdtempSync(join(tmpdir(), 'qstyle-compression-'));
    const smallSource = Array.from({ length: 8 }, (_, i) =>
      `.q_${i.toString(16).padStart(8, '0')}{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:rebeccapurple;font-weight:700}`,
    ).join('');
    const source = cssMinify ? readFileSync(new URL('./fixtures/compression-studio.css', import.meta.url), 'utf8') : smallSource;
    const entry = join(root, 'entry.js');
    writeFileSync(entry, 'import "virtual:qstyle/pack/q_aaaaaaaa.css";' +
      'export {default as css} from "virtual:qstyle/pack/q_aaaaaaaa.css?inline";');
    const run = async (optimize: boolean) => {
      const result = await build({
        configFile: false, root, logLevel: 'silent',
        plugins: [
          { name: 'fixture-pack', enforce: 'pre', load(id) {
            return id.startsWith('\0virtual:qstyle/pack/q_aaaaaaaa.css') ? source : null;
          } },
          ...qstyle({ diagnostics: 'silent' }).filter((plugin) => optimize || plugin.name !== 'qstyle:dedup'),
        ],
        build: {
          write: false, minify: false, cssMinify,
          lib: { entry, formats: ['es'], fileName: 'entry', cssFileName: 'style' },
          rolldownOptions: { output: { assetFileNames: 'assets/[name]-[hash][extname]' } },
        },
      });
      if (!Array.isArray(result)) throw new Error('Expected library outputs');
      const files = result.flatMap((output) => output.output);
      const css = files.find((file) => file.type === 'asset' && file.fileName.endsWith('.css'));
      const js = files.find((file) => file.type === 'chunk' && file.isEntry);
      if (css?.type !== 'asset' || typeof css.source !== 'string' || js?.type !== 'chunk') {
        throw new Error('Missing CSS or JS output');
      }
      return { css: css.source.trim(), fileName: css.fileName, code: js.code };
    };
    try {
      const original = await run(false);
      const optimized = await run(true);
      expect(optimized.css).not.toBe(original.css);
      // Vite's minifier can independently reach the same output. Identical content
      // must retain its name; changed content must get a different name.
      expect(optimized.fileName === original.fileName).toBe(optimized.css === original.css);
      // Vite may append a bookkeeping comment to an unminified library CSS asset.
      const inlineCss = optimized.css.replace(/\/\*\$vite\$:\d+\*\//g, '').trim();
      expect(optimized.code).toContain(JSON.stringify(inlineCss));
      const before = measureCss(original.css);
      const after = measureCss(optimized.css);
      expect(after.raw).toBeLessThanOrEqual(before.raw);
      expect(after.gzip).toBeLessThanOrEqual(before.gzip);
      expect(after.brotli).toBeLessThanOrEqual(before.brotli);
      if (cssMinify) expect(after.gzip + after.brotli).toBeLessThan(before.gzip + before.brotli);
      expect(await run(true)).toEqual(optimized);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
