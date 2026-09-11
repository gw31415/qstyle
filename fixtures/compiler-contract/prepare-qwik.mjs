import { existsSync, mkdirSync, symlinkSync, realpathSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export async function prepareQwik(root, mode = process.env.COMPILER_CONTRACT_QWIK ?? 'stock') {
  const link = resolve(root, 'node_modules/@qwik.dev/core');
  if (mode !== 'stock' && mode !== 'candidate') throw new Error('COMPILER_CONTRACT_QWIK must be stock or candidate');
  const stock = resolve(root, '../../packages/qwik/node_modules/@qwik.dev/core');
  let core = stock;
  if (mode === 'candidate') {
    const { patchQwikCore } = await import('../../patches/qwik-style-reuse/apply.mjs');
    core = resolve(root, 'node_modules/.cache/native-candidate/core');
    patchQwikCore({ sourceRoot: stock, outputRoot: core });
    const dependencies = resolve(realpathSync(stock), '../..');
    for (const name of ['csstype', 'launch-editor', 'magic-string', '@qwik.dev/optimizer']) {
      const dependencyLink = resolve(core, 'node_modules', name);
      mkdirSync(dirname(dependencyLink), { recursive: true });
      symlinkSync(resolve(dependencies, name), dependencyLink, 'dir');
    }
  }
  if (existsSync(link) && realpathSync(link) !== realpathSync(core)) {
    if (!lstatSync(link).isSymbolicLink()) throw new Error('Refusing to replace an actual installed package');
    unlinkSync(link);
  }
  if (!existsSync(link)) { mkdirSync(dirname(link), { recursive: true }); symlinkSync(core, link, 'dir'); }
  return mode;
}
