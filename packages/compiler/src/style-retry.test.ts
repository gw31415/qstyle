import { describe, expect, it } from 'vitest';
import { planStyleImportRetry } from './style-retry.js';

const runtime = '/runtime/style-runtime.js';

describe('generated StylePack import retry planning', () => {
  it('recognizes aliased generated bindings and preserves the literal import edge', () => {
    const source = `import {qrl as makeQrl} from '@qwik.dev/core';
      import {useStylesQrl as useGenerated} from ${JSON.stringify(runtime)};
      const pack = makeQrl(() => import('./styles.js'), 'pack');
      useGenerated(pack, true);`;
    const plan = planStyleImportRetry(source, 'owner.tsx', runtime);
    expect(plan?.dependency).toBe('./styles.js');
    const rendered = plan!.render('import.meta.url');
    expect(rendered.code).toContain(`import {useStylesQrl as useGenerated, retryStyleImport} from ${JSON.stringify(runtime)}`);
    expect(rendered.code).toContain('retryStyleImport(()=>import(\'./styles.js\'), import.meta.url)');
    expect(rendered.code).toContain("const pack = makeQrl(() => retryStyleImport(()=>import('./styles.js'), import.meta.url), 'pack')");
    expect(rendered.map.sourcesContent).toEqual([source]);
  });

  it('accepts a block-bodied arrow with only a returned literal import', () => {
    const source = `import {qrl} from '@qwik.dev/core';
      import {useStylesQrl} from ${JSON.stringify(runtime)};
      const pack = qrl(() => { return import("./styles.js"); }, 'pack');
      useStylesQrl(pack, true);`;
    const plan = planStyleImportRetry(source, 'owner.tsx', runtime);
    expect(plan?.dependency).toBe('./styles.js');
    expect(plan!.render('url').code).toContain('retryStyleImport(()=>import("./styles.js"), url)');
  });

  it('ignores authored hooks and unproven qrl bindings', () => {
    const authored = `import {qrl} from '@qwik.dev/core';
      import {useStylesQrl} from ${JSON.stringify(runtime)};
      const pack = qrl(() => import('./styles.js'), 'pack');
      useStylesQrl(pack);`;
    expect(planStyleImportRetry(authored, 'owner.tsx', runtime)).toBeUndefined();

    const localQrl = `import {useStylesQrl} from ${JSON.stringify(runtime)};
      const qrl = (load: () => unknown) => load();
      const pack = qrl(() => import('./styles.js'));
      useStylesQrl(pack, true);`;
    expect(planStyleImportRetry(localQrl, 'owner.tsx', runtime)).toBeUndefined();

    const namespaceQrl = `import * as core from '@qwik.dev/core';
      import {useStylesQrl} from ${JSON.stringify(runtime)};
      const pack = core.qrl(() => import('./styles.js'));
      useStylesQrl(pack, true);`;
    expect(planStyleImportRetry(namespaceQrl, 'owner.tsx', runtime)).toBeUndefined();
  });

  it('fails closed for a malformed marked hook and shadowed imports', () => {
    const malformed = `import {qrl} from '@qwik.dev/core';
      import {useStylesQrl} from ${JSON.stringify(runtime)};
      const pack = qrl(() => './styles.js');
      useStylesQrl(pack, true);`;
    expect(() => planStyleImportRetry(malformed, 'owner.tsx', runtime))
      .toThrow('Generated StylePack has a malformed marked useStylesQrl hook.');

    const shadowed = `import {qrl} from '@qwik.dev/core';
      import {useStylesQrl} from ${JSON.stringify(runtime)};
      const pack = qrl(() => import('./styles.js'));
      function owner(useStylesQrl: (pack: unknown, generated: boolean) => void) {
        useStylesQrl(pack, true);
      }`;
    expect(planStyleImportRetry(shadowed, 'owner.tsx', runtime)).toBeUndefined();
  });

  it('chooses a collision-free retry binding', () => {
    const source = `import {qrl} from '@qwik.dev/core';
      import {useStylesQrl, retryStyleImport} from ${JSON.stringify(runtime)};
      const retryStyleImport_1 = () => 'local';
      const pack = qrl(() => import('./styles.js'));
      useStylesQrl(pack, true);`;
    const plan = planStyleImportRetry(source, 'owner.tsx', runtime);
    expect(plan!.render('url').code).toContain('retryStyleImport(()=>import(\'./styles.js\'), url)');
  });

  it('does not capture free identifiers when adding the retry import', () => {
    const source = `import {qrl} from '@qwik.dev/core';
      import {useStylesQrl} from ${JSON.stringify(runtime)};
      const retryStyleImport_1 = 0;
      export const external = retryStyleImport;
      const pack = qrl(() => import('./styles.js'));
      useStylesQrl(pack, true);`;
    const rendered = planStyleImportRetry(source, 'owner.tsx', runtime)!.render('url');
    expect(rendered.code).toContain('retryStyleImport as retryStyleImport_2');
    expect(rendered.code).toContain("retryStyleImport_2(()=>import('./styles.js'), url)");
    expect(rendered.code).toContain('export const external = retryStyleImport;');
  });
});
