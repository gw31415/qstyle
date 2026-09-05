import type { Plugin, ResolvedConfig } from 'vite';
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
 * qstyle Vite plugin — Milestone 0 minimal production proof (plan.md §87)。
 * - virtual modules: registry / pack/<id> / manifest
 * - transform: .tsx/.jsx 内の css={{ prop: 'value' }} という単一
 *   string-literal declaration のみ atom 化→hash→ class="HASH" へ rewrite し、
 *   モジュール先頭へ side-effect import "virtual:qstyle/pack/HASH" を注入する。
 *   複雑ケース (複数 declaration / 非 string-literal / css={handle} 等) は
 *   null を返して触らない (correctness first)。
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

    configResolved(config: ResolvedConfig): void {
      log(`optimization=${optimization} backend=${backend} mode=${config.mode}`);
    },

    buildStart(): void {
      collected.clear();
      moduleToAtoms.clear();
    },

    resolveId(id: string): string | null {
      return resolveQstyleId(id);
    },

    load(id: string): string | null {
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
        // side-effect import だけでも CSS 文字列が bundle に残るよう、
        // export に加えて globalThis への代入 (side effect) を emit する。
        const cssJson: string = JSON.stringify(style.cssText);
        const idJson: string = JSON.stringify(packId);
        return (
          `globalThis.__qstyle_packs ??= {};\n` +
          `globalThis.__qstyle_packs[${idJson}] = ${cssJson};\n` +
          `export default ${cssJson};\n`
        );
      }
      return null;
    },

    transform(code: string, id: string): { code: string; map: null } | null {
      if (!id.endsWith('.tsx') && !id.endsWith('.jsx')) return null;
      if (!code.includes('css')) return null;
      // 単一 string-literal declaration のみ対象。
      // 例: css={{ display: 'flex' }} / css={{display:"flex"}}。
      // 複数 declaration (カンマ含み) や非 string 値はマッチさせない。
      const singleDecl: RegExp =
        /css\s*=\s*\{\{\s*([A-Za-z0-9_-]+)\s*:\s*(['"])([^'"]*)\2\s*\}\}/g;
      const matches: RegExpMatchArray[] = [...code.matchAll(singleDecl)];
      if (matches.length === 0) return null;
      // 単一形を除去しても css={ が残る場合は複雑ケースを含むので触らない。
      const stripped: string = code.replace(singleDecl, '');
      if (/css\s*=\s*\{/.test(stripped)) return null;
      const seen = new Set<string>();
      const rewritten: string = code.replace(
        singleDecl,
        (_full: string, property: string, _quote: string, value: string): string => {
          const atom = createStaticAtom({
            property,
            value,
            provenance: [{ source: id, line: 1, column: 1 }],
          });
          const atomId: string = hashStaticAtom(atom);
          const cssText: string = `.${atomId}{${atom.property}:${atom.value}}`;
          if (!collected.has(atomId)) {
            collected.set(atomId, { id: atomId, cssText, sourceId: id });
          }
          const list: string[] = moduleToAtoms.get(id) ?? [];
          if (!list.includes(atomId)) {
            moduleToAtoms.set(id, [...list, atomId]);
          }
          seen.add(atomId);
          log(`collected ${atomId} from ${id}`);
          return `class="${atomId}"`;
        },
      );
      const header: string = [...seen]
        .map((atomId: string): string => `import "virtual:qstyle/pack/${atomId}";`)
        .join('\n');
      return { code: `${header}\n${rewritten}`, map: null };
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
