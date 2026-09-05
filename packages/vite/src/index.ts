import type { Plugin } from 'vite';
import { createStaticAtom, hashStaticAtom } from '@qstyle/core';

export type OptimizationLevel = 'preserve' | 'safe' | 'strict';
export type BackendKind = 'qwik-native' | 'css-asset';

export interface QstyleOptions {
  readonly optimization?: OptimizationLevel | undefined;
  readonly backend?: BackendKind | undefined;
  readonly runtimeStyles?: {
    readonly strategy?: 'custom-property' | undefined;
    readonly fallback?: 'inline' | undefined;
    readonly promotion?: 'never' | 'cost-based' | 'always' | undefined;
  } | undefined;
  readonly composition?: {
    readonly falsy?: 'ignore' | undefined;
  } | undefined;
  readonly chunking?: {
    readonly strategy?: 'usage-cluster' | undefined;
    readonly minChunkBytes?: number | undefined;
    readonly maxChunkBytes?: number | undefined;
  } | undefined;
  readonly diagnostics?: 'silent' | 'warning' | 'error' | undefined;
  readonly debug?: boolean | undefined;
}

export interface CollectedStyle {
  readonly id: string;
  readonly cssText: string;
  readonly sourceId: string;
}

const VIRTUAL_PREFIX = 'virtual:qstyle/';
const RESOLVED_PREFIX = '\0virtual:qstyle/';

function resolveQstyleId(id: string): string | null {
  if (id.startsWith(VIRTUAL_PREFIX)) {
    return `${RESOLVED_PREFIX}${id.slice(VIRTUAL_PREFIX.length)}`;
  }
  if (id.startsWith(RESOLVED_PREFIX)) {
    return id;
  }
  return null;
}

/**
 * qstyle Vite plugin — Milestone 0 skeleton (plan.md §51-54)。
 * - virtual modules: registry / pack/<id> / manifest
 * - transform: TSX 内の css prop 存在を検出し provenance を収集するのみ
 *   (rewrite は Milestone 2 以降。M0 では production proof の配線確認が目的)
 * - generateBundle: Route Style Manifest の雛形を emit
 */
export function qstyle(options: QstyleOptions = {}): Plugin {
  const optimization: OptimizationLevel = options.optimization ?? 'safe';
  const backend: BackendKind = options.backend ?? 'qwik-native';
  const debug = options.debug ?? false;

  const collected = new Map<string, CollectedStyle>();
  const moduleToAtoms = new Map<string, string[]>();

  const log = (...args: readonly unknown[]): void => {
    if (debug) {
      console.log('[qstyle]', ...args);
    }
  };

  return {
    name: 'qstyle',
    enforce: 'pre',

    configResolved(config): void {
      log(`optimization=${optimization} backend=${backend} mode=${config.mode}`);
    },

    buildStart(): void {
      collected.clear();
      moduleToAtoms.clear();
    },

    resolveId(id): string | null {
      return resolveQstyleId(id);
    },

    load(id): string | null {
      const resolved = resolveQstyleId(id);
      if (resolved === null) return null;
      const path = resolved.slice(RESOLVED_PREFIX.length);
      if (path === 'registry') {
        const entries = [...collected.values()]
          .map((s) => `  ${JSON.stringify(s.id)}: ${JSON.stringify(s.cssText)},`)
          .join('\n');
        return `export const registry = {\n${entries}\n};\n`;
      }
      if (path === 'manifest') {
        const manifest: Record<string, string[]> = {};
        for (const [mod, atoms] of moduleToAtoms) {
          manifest[mod] = atoms;
        }
        return `export const manifest = ${JSON.stringify(manifest, null, 2)};\n`;
      }
      if (path.startsWith('pack/')) {
        const packId = path.slice('pack/'.length);
        const style = collected.get(packId);
        if (!style) return `export default ${JSON.stringify('')};\n`;
        return `export default ${JSON.stringify(style.cssText)};\n`;
      }
      return null;
    },

    transform(code, id): { code: string; map: null } | null {
      if (!id.endsWith('.tsx') && !id.endsWith('.jsx')) return null;
      if (!code.includes('css')) return null;
      // M0 heuristic: css={{ display: 'flex' }} の display: value を1件拾う。
      // 本格 parser は Milestone 2 (OBJ-*) で置き換える。
      const m = /css\s*=\s*\{\{\s*([^:}\s]+)\s*:\s*['"]([^'"]+)['"]/.exec(code);
      if (!m) return null;
      const property = m[1] ?? 'display';
      const value = m[2] ?? 'flex';
      const atom = createStaticAtom({
        property,
        value,
        provenance: [{ source: id, line: 1, column: 1 }],
      });
      const atomId = hashStaticAtom(atom);
      const cssText = `.${atomId}{${atom.property}:${atom.value}}`;
      if (!collected.has(atomId)) {
        collected.set(atomId, { id: atomId, cssText, sourceId: id });
      }
      const list = moduleToAtoms.get(id) ?? [];
      if (!list.includes(atomId)) {
        moduleToAtoms.set(id, [...list, atomId]);
      }
      log(`collected ${atomId} from ${id}`);
      // M0 では rewrite しない。pack import を促す dev hint コメントのみ。
      return { code, map: null };
    },

    generateBundle(): void {
      const manifest: Record<string, string[]> = {};
      for (const [mod, atoms] of moduleToAtoms) {
        manifest[mod] = atoms;
      }
      this.emitFile({
        type: 'asset',
        fileName: 'qstyle-manifest.json',
        source: JSON.stringify(
          {
            version: 0,
            optimization,
            backend,
            manifest,
            packs: [...collected.values()],
          },
          null,
          2,
        ),
      });
    },
  };
}

export default qstyle;
