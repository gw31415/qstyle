import { NativeIdentityRegistry, NativeStyleError, sha256Prefix128, type NativeStylePack, type OptimizedStyleProgram } from '@qstyle/core';

export interface NativeModule {
  readonly id: string;
  readonly packId: string;
  readonly source: string;
}

const developmentKey = (pack: NativeStylePack): string => pack.devKey
  ?? JSON.stringify(['local', ...[...pack.demandIds].sort()]);

/** Keep removed dev owners alive with an empty payload so native HMR clears their CSS. */
export function retainDevelopmentOwners(
  current: OptimizedStyleProgram, previous?: OptimizedStyleProgram,
): OptimizedStyleProgram {
  const identities = new NativeIdentityRegistry();
  const packs = new Map(current.packs.map((pack) => [developmentKey(pack), pack]));
  for (const pack of previous?.packs ?? []) {
    const key = developmentKey(pack);
    if (!packs.has(key)) packs.set(key, {
      id: identities.identify('pack', JSON.stringify(['dev-empty', key])),
      devKey: key, demandIds: pack.demandIds, declarationIds: [], css: '', cssBytes: 0,
    });
  }
  const ordered = [...packs].sort(([a], [b]) => a === 'foundation' ? -1 : b === 'foundation' ? 1 : a.localeCompare(b)).map(([, pack]) => pack);
  const packsByDemand = new Map([...current.packsByDemand.keys()].map((demand) => [demand,
    ordered.filter((pack) => pack.demandIds.includes(demand)).map((pack) => pack.id),
  ]));
  return { ...current, packs: ordered, packsByDemand };
}

/** The public Qwik optimizer owns QRL extraction, SSR inlining and final asset URLs. */
export function createNativeModules(packs: readonly NativeStylePack[], dev: boolean): readonly NativeModule[] {
  return packs.map((pack) => {
    if (!/^[a-f0-9]{32}$/.test(pack.id)) throw new NativeStyleError({ code: 'QS1301', message: 'Invalid native pack identity.' });
    const identity = dev ? sha256Prefix128(developmentKey(pack)) : pack.id;
    return { id: `virtual:qstyle-native:${identity}.tsx`, packId: pack.id,
      source: `import {component$,useStyles$} from '@qwik.dev/core';\n`
        + `export const StylePack=component$(()=>{useStyles$(${JSON.stringify(pack.css)});return null;});\n` };
  });
}
