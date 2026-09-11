import { implicit$FirstArg, useConstant, useServerData, type QRL } from '@qwik.dev/core';
import { isBrowser, isDev } from '@qwik.dev/core/build';
import { useStylesQrl as nativeStyles, useStylesScopedQrl as nativeScoped } from '@qwik.dev/core/internal';

// Qstyle's generated StylePack has exactly one hook, always at sequential index 0.
// Authored hooks (including scoped styles) keep the native resolution behavior.
type CollectedStyle = { text?: string; pending?: Promise<void> };
let retrySequence = 0;
// Only compiler-proven CSS modules use this fallback. Each failed invocation
// gets a fresh URL because browsers cache rejected dynamic module imports.
export async function retryStyleImport<T>(load: () => Promise<T>, href: string): Promise<T> {
  try { return await load(); }
  catch {
    const url = new URL(href, import.meta.url);
    url.searchParams.set('qstyle-retry', String(++retrySequence));
    return import(/* @vite-ignore */ url.href);
  }
}
export function useStyles(styles: QRL<string>, generatedPack = false): { styleId: string } {
  if (generatedPack) {
    let hash = 0;
    const symbol = styles.getHash();
    for (let i = 0; i < symbol.length; i++) hash = (Math.imul(hash, 31) + symbol.charCodeAt(i)) | 0;
    const id = `${Math.abs(hash).toString(36)}-0`;
    if (!isBrowser) {
      const collector = useServerData<Map<string, CollectedStyle> | undefined>('qstyle:collected-styles');
      if (collector) {
        // Dev HMR needs the native saved hook slot. Production generated packs
        // have no other hooks: a fresh client slot derives this same index-0 ID.
        if (isDev) useConstant(id);
        let entry = collector.get(id);
        if (!entry) { entry = {}; collector.set(id, entry); }
        if (typeof entry.text === 'string') return { styleId: id };
        if (entry.pending) throw entry.pending;
        if (typeof styles.resolved === 'string') {
          entry.text = styles.resolved;
          return { styleId: id };
        }
        const target = entry;
        target.pending = styles.resolve().then((text: unknown) => {
          if (typeof text !== 'string') throw new TypeError('Generated StylePack must resolve to CSS text.');
          target.text = text;
          delete target.pending;
        }).catch((error: unknown) => { collector.delete(id); throw error; });
        throw target.pending;
      }
      return nativeStyles(styles);
    }
    if (isDev) return nativeStyles(styles);
    const existing = document.querySelector(`style[q\\:style="${id}"]`);
    if (existing) {
      const text = existing.textContent ?? '';
      const cached = new Proxy(styles, {
        get(target, key, receiver) {
          if (key === 'resolved') return text;
          if (key === 'resolve') return () => Promise.resolve(text);
          return Reflect.get(target, key, receiver);
        },
      });
      return nativeStyles(cached);
    }
    // Native beta.43 may retain an applied ID after its DOM style was removed.
    // Resolve through Qwik as usual, then repair only a missing generated style.
    const restore = () => {
      if (!document.querySelector(`style[q\\:style="${id}"]`) && typeof styles.resolved === 'string') {
        const element = document.createElement('style');
        element.setAttribute('q:style', id);
        element.textContent = styles.resolved;
        document.head.appendChild(element);
      }
    };
    try {
      const result = nativeStyles(styles);
      restore();
      return result;
    } catch (pending) {
      if (pending && (typeof pending === 'object' || typeof pending === 'function')
        && 'then' in pending && typeof pending.then === 'function') {
        throw Promise.resolve(pending).then(restore);
      }
      throw pending;
    }
  }
  return nativeStyles(styles);
}
export const useStylesQrl: (styles: QRL<string>, generatedPack?: boolean) => { styleId: string } = useStyles;
export const useStylesScoped: (styles: QRL<string>) => { scopeId: string } = nativeScoped;
export const useStylesScopedQrl: (styles: QRL<string>) => { scopeId: string } = nativeScoped;
export const useStyles$: (styles: string, generatedPack?: boolean) => { styleId: string } = implicit$FirstArg(useStyles);
export const useStylesScoped$: (styles: string) => { scopeId: string } = implicit$FirstArg(useStylesScoped);
