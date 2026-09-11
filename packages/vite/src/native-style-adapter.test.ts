import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentOptions, Plugin, ResolvedConfig } from 'vite';
import { createNativeStyleAdapter } from './native-style-adapter.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(version = '2.0.0-beta.43') {
  const root = mkdtempSync(join(tmpdir(), 'qstyle-adapter-'));
  roots.push(root);
  const core = join(root, 'node_modules/@qwik.dev/core');
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, 'package.json'), JSON.stringify({ name: '@qwik.dev/core', version }));
  const plugin = createNativeStyleAdapter();
  const config = { root, command: 'build', plugins: [
    { name: 'qstyle-native' }, plugin, { name: 'vite-plugin-qwik' },
  ] } as unknown as ResolvedConfig;
  const configure = plugin.configResolved as (config: ResolvedConfig) => void;
  return { plugin, configure: () => configure(config) };
}

async function contextFor(plugin: Plugin, consumer: 'client' | 'server' = 'client') {
  const context = {
    environment: { name: consumer, config: { consumer } },
    resolve: vi.fn(async (source: string) => ({ id: source === '@qstyle/qwik/runtime'
      ? '/package/dist/runtime.mjs' : source === '@qstyle/qwik/server'
        ? '/package/dist/server.mjs' : '/package/styles.js' })),
    emitFile: vi.fn(() => 'css0'),
  };
  const hook = plugin.buildStart as { handler(this: unknown): Promise<void> };
  await hook.handler.call(context);
  return context;
}

function transform(plugin: Plugin, context: unknown, code: string, id: string) {
  const hook = plugin.transform as (this: unknown, code: string, id: string) => Promise<{ code: string } | undefined>;
  return hook.call(context, code, id);
}

describe('package-owned native style adapter', () => {
  it('rewrites application named imports without rewriting its own server implementation', async () => {
    const { plugin, configure } = setup();
    configure();
    const context = await contextFor(plugin, 'server');
    const source = `import {component$, useStyles$} from '@qwik.dev/core';
      import {renderToString} from '@qwik.dev/core/server';`;
    const result = await transform(plugin, context, source, '/app/src/entry.tsx');
    expect(result?.code).toContain(`import {component$} from "@qwik.dev/core"`);
    expect(result?.code).toContain(`import {useStyles$} from "/package/dist/runtime.mjs"`);
    expect(result?.code).toContain(`import {renderToString} from "/package/dist/server.mjs"`);
    expect(await transform(plugin, context, source, '/package/dist/server.mjs')).toBeUndefined();
    expect(await transform(plugin, context, source, '/package/dist/shared-server.mjs')).toBeUndefined();
    const client = await contextFor(plugin);
    const browser = await transform(plugin, client, source, '/app/src/shared.tsx');
    expect(browser?.code).toContain("from '@qwik.dev/core/server'");
    expect(browser?.code).not.toContain('/package/dist/server.mjs');
  });

  it('adds a retry URL only to a generated browser StylePack while retaining its static import', async () => {
    const { plugin, configure } = setup();
    configure();
    const source = `import {qrl} from '@qwik.dev/core';
      import {useStylesQrl} from '/package/dist/runtime.mjs';
      const style=qrl(()=>import('./styles.js'),'style');
      export const render=()=>{useStylesQrl(style,true);return null;};`;
    const id = '/app/.qstyle/native/12121212121212121212121212121212.tsx_StylePack_component_render.js';
    const client = await contextFor(plugin);
    const result = await transform(plugin, client, source, id);
    expect(result?.code).toContain("retryStyleImport(()=>import('./styles.js'), import.meta.ROLLUP_FILE_URL_css0)");
    expect(client.emitFile).toHaveBeenCalledWith({ type: 'chunk', id: '/package/styles.js' });
    expect(await transform(plugin, client, source, '/app/src/authored.js')).toBeUndefined();
    const server = await contextFor(plugin, 'server');
    expect(await transform(plugin, server, source, id)).toBeUndefined();
    expect(server.emitFile).not.toHaveBeenCalled();
  });

  it('bundles the server wrapper to share Qwik render context and rejects unverified Qwik versions', () => {
    const { plugin } = setup();
    const hook = plugin.configEnvironment as {
      handler(name: string, config: EnvironmentOptions): EnvironmentOptions | undefined;
    };
    expect(hook.handler('client', { consumer: 'client' })).toBeUndefined();
    expect(hook.handler('ssr', { consumer: 'server', resolve: { noExternal: true } })).toBeUndefined();
    expect(hook.handler('ssr', { consumer: 'server', resolve: { noExternal: ['existing'] } }))
      .toEqual({ resolve: { noExternal: ['existing', '@qstyle/qwik'] } });
    expect(setup('2.0.0-beta.44').configure).toThrow('requires @qwik.dev/core 2.0.0-beta.43');
  });
});
