import { hashStaticAtom } from './atom.js';
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
 */
export class DedupRegistry {
  private readonly atoms: Map<string, StaticAtom> = new Map<string, StaticAtom>();

  add(atom: StaticAtom): DedupAddResult {
    const id: string = hashStaticAtom(atom);
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
