import { hashStaticAtom, staticAtomIdentity } from './atom.js';
import { IdentityRegistry } from './collision.js';
import type { Provenance, StaticAtom } from './ir.js';

/** add() の戻り値。id は hashStaticAtom(atom)。 */
export interface DedupAddResult {
  readonly id: string;
  readonly deduped: boolean;
}

/** 同一 atom にマージ保持する provenance の上限 (inspector 表示・メモリの発散防止)。 */
const MAX_PROVENANCE: number = 16;

/**
 * Semantic dedup registry (plan.md §88: exact semantic dedup)。
 * key は semantic hash のみ。chunk membership は key に含めない。
 * 同一 hash の 2 回目以降は初回 atom を保持し、provenance のみマージする。
 *
 * release blocker 1: hash が同一でも論理入力 (staticAtomIdentity) が異なる場合は
 * 黙って初回を採用しない — IdentityRegistry が deterministic な衝突 error を投げる。
 * 同一論理入力の重複 (provenance 差のみ) は従来どおり dedupe する。
 */
export class DedupRegistry {
  private readonly atoms: Map<string, StaticAtom> = new Map<string, StaticAtom>();
  private readonly identities: IdentityRegistry = new IdentityRegistry();

  add(atom: StaticAtom): DedupAddResult {
    const id: string = hashStaticAtom(atom);
    this.identities.register(
      'atom',
      id,
      staticAtomIdentity(atom),
      atom.provenance[0]?.source ?? '<unknown>',
    );
    const existing: StaticAtom | undefined = this.atoms.get(id);
    if (existing === undefined) {
      this.atoms.set(id, atom);
      return { id, deduped: false };
    }
    const provenance: readonly Provenance[] = [...existing.provenance, ...atom.provenance].slice(
      0,
      MAX_PROVENANCE,
    );
    this.atoms.set(id, { ...existing, provenance });
    return { id, deduped: true };
  }

  size(): number {
    return this.atoms.size;
  }

  ids(): string[] {
    return [...this.atoms.keys()];
  }

  get(id: string): StaticAtom | undefined {
    return this.atoms.get(id);
  }
}
