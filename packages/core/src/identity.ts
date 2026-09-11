import { createHash } from 'node:crypto';
import { CANONICAL_VERSION } from './canonical.js';
import { NativeStyleError } from './native-diagnostic.js';
import type { SourceSpan } from './native-ir.js';

export type NativeIdentityNamespace =
  | 'rule' | 'declaration' | 'class' | 'slot-schema' | 'keyframes' | 'global' | 'pack';

export type NativeHasher = (input: string) => string;

export function sha256Prefix128(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32);
}

/** Owned by one graph generation; content-addressed entries can never be updated in place. */
export class NativeIdentityRegistry {
  private readonly entries: Map<string, { payload: string; source?: SourceSpan }> = new Map();
  private readonly hasher: NativeHasher;

  constructor(hasher: NativeHasher = sha256Prefix128) {
    this.hasher = hasher;
  }

  identify(namespace: NativeIdentityNamespace, payload: string, source?: SourceSpan): string {
    const digest = this.hasher(`${namespace}\0${CANONICAL_VERSION}\0${payload}`);
    if (!/^[a-f0-9]{32}$/.test(digest)) {
      throw new NativeStyleError({ code: 'QS1301', message: 'The identity hasher must return 128 bits as 32 lowercase hexadecimal digits.' });
    }
    const key = `${namespace}:${digest}`;
    const existing = this.entries.get(key);
    if (existing && existing.payload !== payload) {
      throw new NativeStyleError({
        code: 'QS1301', message: `Different ${namespace} contents produced the same identity ${digest}.`,
        ...(source ? { source } : {}),
        ...(existing.source ? { related: [existing.source] } : {}),
      });
    }
    if (!existing) this.entries.set(key, { payload, ...(source ? { source } : {}) });
    return digest;
  }

  get size(): number { return this.entries.size; }
}

export function nativeClassName(
  declarations: readonly string[], registry: NativeIdentityRegistry,
): string {
  return `q1_${registry.identify('class', JSON.stringify([...new Set(declarations)].sort()))}`;
}

export function nativeSlotName(schema: string, index: number, registry: NativeIdentityRegistry): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new NativeStyleError({ code: 'QS1102', message: 'A runtime slot index must be a nonnegative safe integer.' });
  }
  return `--qstyle-1-${registry.identify('slot-schema', schema)}-${index}`;
}
