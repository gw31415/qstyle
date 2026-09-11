import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unocss } from './native-config.js';

describe('native Uno config sessions', () => {
  it('watches absent default configs and resolves a newly created config in a new session', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'qstyle-uno-created-'));
    try {
      const factory = unocss();
      const before = await factory.create(root);
      const config = resolve(root, 'uno.config.ts');
      expect(before.watchFiles).toContain(config);
      await writeFile(config, "export default {rules:[['one',{color:'red'}]]}");
      const after = await factory.create(root);
      expect(JSON.stringify(await after.resolve([{id:'a',tokens:['one']}]))).toContain('red');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('tracks imported config dependencies and replaces a session only after successful loading', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'qstyle-uno-native-'));
    try {
      const config = resolve(root, 'uno.config.ts'); const dependency = resolve(root, 'palette.ts');
      await writeFile(dependency, "export const color = 'red';\n");
      await writeFile(config, "import {color} from './palette'; export default {rules:[['one',{color}]]};\n");
      const factory = unocss({ configFile: './uno.config.ts' });
      const first = await factory.create(root);
      expect(first.watchFiles).toContain(config);
      expect(first.watchFiles).toContain(dependency);
      const css = async (session: typeof first) => JSON.stringify(await session.resolve([{ id: 'a', tokens: ['one'] }]));
      expect(await css(first)).toContain('red');
      await writeFile(dependency, "export const color = 'blue';\n");
      const second = await factory.create(root);
      expect(await css(second)).toContain('blue');
      expect(await css(first)).toContain('red');
      await writeFile(config, 'export default {rules: [');
      await expect(factory.create(root)).rejects.toThrow();
      expect(await css(second)).toContain('blue');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('ignores erased type specifiers but tracks mixed runtime dependencies', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'qstyle-uno-types-'));
    try {
      const config = resolve(root, 'uno.config.ts');
      const palette = resolve(root, 'palette.ts');
      await writeFile(palette, "export const color='red'; export type Color=string;");
      await writeFile(config, `import { type Missing } from './types';
        export { type Other } from './other-types';
        import { color, type Color } from './palette';
        export default {rules:[['one',{color}]]};`);
      const session = await unocss({ configFile: './uno.config.ts' }).create(root);
      expect(session.watchFiles).toContain(palette);
      expect(session.watchFiles).not.toContain(resolve(root, 'types.ts'));
      expect(JSON.stringify(await session.resolve([{id:'a',tokens:['one']}]))).toContain('red');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a missing explicit config instead of silently selecting defaults', async () => {
    await expect(unocss({ configFile: './missing.config.ts' }).create('/nonexistent-qstyle-config')).rejects.toThrow();
  });
});
