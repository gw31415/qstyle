import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ResolvedConfig } from 'vite';
import { NativeStyleError } from '@qstyle/core';
import { planStyleImportRetry, rewriteStyleImports } from '@qstyle/compiler';

const importer = fileURLToPath(import.meta.url);
const runtimeSpecifier = '@qstyle/qwik/runtime';
const serverSpecifier = '@qstyle/qwik/server';
const supportedQwik = '2.0.0-beta.43';

interface RuntimeModules {
  readonly runtime: string;
  readonly server: string;
  readonly directories: readonly string[];
}

/** Package-owned native hook and SSR adapter; used together with the compiler. */
export function createNativeStyleAdapter(): Plugin {
  let config: ResolvedConfig;
  const modules = new Map<string, RuntimeModules>();
  return {
    name: 'qstyle-native-style-adapter',
    enforce: 'pre',
    // Dev SSR has its own resolver; Vite otherwise runs buildStart only for client.
    perEnvironmentStartEndDuringDev: true,
    configEnvironment: { order: 'post', handler(name, environment) {
      const consumer = environment.consumer ?? (name === 'client' ? 'client' : 'server');
      if (consumer !== 'server' || environment.resolve?.noExternal === true) return;
      // An external server wrapper would import a second Qwik runtime beside
      // the renderer bundle and lose the active render context.
      const existing = environment.resolve?.noExternal;
      return { resolve: { noExternal: [
        ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
        '@qstyle/qwik',
      ] } };
    } },
    configResolved(resolved) {
      config = resolved;
      let version: unknown;
      try { version = createRequire(resolve(config.root, 'package.json'))('@qwik.dev/core/package.json').version; }
      catch { version = 'unresolved'; }
      if (version !== supportedQwik) throw new NativeStyleError({ code: 'QS1501',
        message: `The native style adapter requires @qwik.dev/core ${supportedQwik}; found ${String(version)}.`,
      });
      const compiler = config.plugins.findIndex((plugin) => plugin.name === 'qstyle-native');
      const adapter = config.plugins.findIndex((plugin) => plugin.name === 'qstyle-native-style-adapter');
      const qwik = config.plugins.findIndex((plugin) => plugin.name === 'vite-plugin-qwik');
      if (compiler < 0 || adapter <= compiler || qwik <= adapter) throw new NativeStyleError({ code: 'QS1501',
        message: 'Place the native compiler and style adapter before qwikVite, in that order.',
      });
    },
    buildStart: { order: 'pre', sequential: true, async handler() {
      const runtime = await this.resolve(runtimeSpecifier, importer, { skipSelf: true });
      const server = await this.resolve(serverSpecifier, importer, { skipSelf: true });
      if (!runtime || runtime.external || !server || server.external) throw new NativeStyleError({ code: 'QS1501',
        message: 'The native style adapter requires bundled @qstyle/qwik/runtime and @qstyle/qwik/server entries.',
      });
      modules.set(this.environment.name, {
        runtime: runtime.id, server: server.id,
        directories: [...new Set([dirname(runtime.id), dirname(server.id)])],
      });
    } },
    async transform(code, id) {
      const current = modules.get(this.environment.name);
      if (!current) throw new NativeStyleError({ code: 'QS1401', message: 'Native runtime entries are not resolved for this environment.' });
      if (config.command === 'build' && this.environment.config.consumer === 'client'
        && /\/\.qstyle\/native\/[a-f0-9]{32}\.tsx_StylePack_component_[^/]+\.js$/.test(id)) {
        const plan = planStyleImportRetry(code, id, current.runtime);
        if (plan) {
          const dependency = await this.resolve(plan.dependency, id);
          if (!dependency || dependency.external) throw new NativeStyleError({ code: 'QS1401',
            message: 'Generated CSS retry requires a bundled module.',
          });
          const reference = this.emitFile({ type: 'chunk', id: dependency.id });
          return plan.render(`import.meta.ROLLUP_FILE_URL_${reference}`);
        }
      }
      if (current.directories.some((directory) => id.startsWith(`${directory}/`))
        || id.includes('/node_modules/') || !/\.[cm]?[jt]sx?$/.test(id)) return;
      return rewriteStyleImports(code, id, current.runtime,
        /\/\.qstyle\/native\/[a-f0-9]{32}\.tsx$/.test(id),
        this.environment.config.consumer === 'server' ? current.server : undefined);
    },
  };
}
