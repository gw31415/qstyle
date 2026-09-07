/**
 * Generated identity の衝突検出 (release blocker 1)。
 *
 * 32-bit hash (fnv1aHex) は変更しない。代わりに、生成 identity (class/unit id・
 * asset fileName・pack id・keyframes/global id・slot 変数名) ごとに「論理入力の
 * canonical content」を登録しておき、同一 identity に異なる content が紐付いた
 * 場合を成果物出力前に deterministic error にする (fail-closed)。
 * 同一論理入力の重複 (dedupe) は許可する。
 */
import { fnv1aHex } from './atom.js';

/** 1 件の衝突の記述。全 field は入力から決定的に導かれる。 */
export interface StyleCollision {
  /** 衝突した identity の種別 (`'unit'` / `'asset'` / `'pack'` / `'atom'` / `'global'` / `'slot'` / ...)。 */
  readonly namespace: string;
  /** 衝突した生成 id (class id / asset fileName / keyframes 名 / slot 変数名など)。 */
  readonly id: string;
  /** 先に id を生成した入力の所在 (module path / chunk id など)。 */
  readonly firstSource: string;
  /** 同一 id を再度生成した入力の所在。 */
  readonly secondSource: string;
  /** 先の登録の canonical content (比較用。長い場合でもそのまま保持する)。 */
  readonly firstContent: string;
  /** 後の登録の canonical content。 */
  readonly secondContent: string;
}

/** 衝突時に投げる deterministic error。message は入力のみから決まる。 */
export class StyleCollisionError extends Error {
  readonly collision: StyleCollision;

  constructor(collision: StyleCollision) {
    super(formatCollision(collision));
    this.name = 'StyleCollisionError';
    this.collision = collision;
  }
}

function formatCollision(collision: StyleCollision): string {
  return (
    `[qstyle] hash collision in ${collision.namespace} namespace: generated id ` +
    `${JSON.stringify(collision.id)} is already used by ${JSON.stringify(collision.firstSource)} ` +
    `with different content; second source ${JSON.stringify(collision.secondSource)} ` +
    `(content fingerprints ${fnv1aHex(collision.firstContent)} vs ` +
    `${fnv1aHex(collision.secondContent)}). ` +
    `Different inputs must not share a generated identity; no artifact is emitted for this build.`
  );
}

export type IdentityRegisterResult = 'new' | 'duplicate' | 'updated';

export interface IdentityRegisterOptions {
  /**
   * true かつ同一 source からの再登録の場合のみ内容を上書きする。
   * dev の occurrence 固定 alias (qd_...) は同一 module の再変換で内容が変わる
   * (HMR) ため、alias 系 namespace のみ許可する。content-addressed な id
   * (atom id / keyframes 名 / asset fileName) では決して使わない。
   */
  readonly allowUpdate?: boolean | undefined;
}

/**
 * namespace ごとに (生成 id -> canonical content + source) を保持する registry。
 * - 同一 id + 同一 content: duplicate (dedupe 可能)。
 * - 同一 id + 異なる content: StyleCollisionError (警告ではなく必ず失敗)。
 * - allowUpdate && 同一 source: updated (dev alias の再変換)。
 */
export class IdentityRegistry {
  private readonly entries: Map<string, { content: string; source: string }> = new Map();

  register(
    namespace: string,
    id: string,
    content: string,
    source: string,
    options: IdentityRegisterOptions = {},
  ): IdentityRegisterResult {
    const key = `${namespace}\u0000${id}`;
    const existing = this.entries.get(key);
    if (existing === undefined) {
      this.entries.set(key, { content, source });
      return 'new';
    }
    if (existing.content === content) return 'duplicate';
    if (options.allowUpdate === true && existing.source === source) {
      this.entries.set(key, { content, source });
      return 'updated';
    }
    throw new StyleCollisionError({
      namespace,
      id,
      firstSource: existing.source,
      secondSource: source,
      firstContent: existing.content,
      secondContent: content,
    });
  }

  has(namespace: string, id: string): boolean {
    return this.entries.has(`${namespace}\u0000${id}`);
  }

  size(): number {
    return this.entries.size;
  }
}
