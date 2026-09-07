import { describe, expect, it } from 'vitest';
import { IdentityRegistry, StyleCollisionError } from './collision.js';

describe('IdentityRegistry (release blocker 1)', () => {
  it('同一 id × 同一 content は duplicate として許可する (dedupe)', () => {
    const registry = new IdentityRegistry();
    expect(registry.register('unit', 'q_abc', '.q_abc{color:red}', 'a.tsx')).toBe('new');
    expect(registry.register('unit', 'q_abc', '.q_abc{color:red}', 'b.tsx')).toBe('duplicate');
    expect(registry.size()).toBe(1);
  });

  it('同一 id × 異なる content は deterministic error (警告ではなく失敗)', () => {
    const registry = new IdentityRegistry();
    registry.register('unit', 'q_abc', '.q_abc{color:red}', 'a.tsx');
    expect(() => registry.register('unit', 'q_abc', '.q_abc{color:blue}', 'b.tsx')).toThrow(
      StyleCollisionError,
    );
    // 同一入力からは常に同一 message (決定性)。
    const messageOf = (): string => {
      try {
        registry.register('unit', 'q_abc', '.q_abc{color:blue}', 'b.tsx');
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    };
    expect(messageOf()).toBe(messageOf());
  });

  it('衝突 error は namespace・id・両 source を含む', () => {
    const registry = new IdentityRegistry();
    registry.register('asset', 'assets/qstyle.q_1.css', '.a{color:red}', 'chunk-a');
    try {
      registry.register('asset', 'assets/qstyle.q_1.css', '.b{color:blue}', 'chunk-b');
      throw new Error('expected StyleCollisionError');
    } catch (error) {
      expect(error).toBeInstanceOf(StyleCollisionError);
      const collision = (error as StyleCollisionError).collision;
      expect(collision.namespace).toBe('asset');
      expect(collision.id).toBe('assets/qstyle.q_1.css');
      expect(collision.firstSource).toBe('chunk-a');
      expect(collision.secondSource).toBe('chunk-b');
      const message: string = (error as Error).message;
      expect(message).toContain('asset');
      expect(message).toContain('assets/qstyle.q_1.css');
      expect(message).toContain('chunk-a');
      expect(message).toContain('chunk-b');
    }
  });

  it('namespace が異なれば同一 id でも衝突しない', () => {
    const registry = new IdentityRegistry();
    registry.register('unit', 'q_abc', 'unit-content', 'a.tsx');
    expect(registry.register('pack', 'q_abc', 'pack-content', 'a.tsx')).toBe('new');
  });

  it('allowUpdate: 同一 source からの再登録のみ内容を上書きできる', () => {
    const registry = new IdentityRegistry();
    registry.register('unit', 'qd_alias', 'old-css', 'a.tsx', { allowUpdate: true });
    expect(
      registry.register('unit', 'qd_alias', 'new-css', 'a.tsx', { allowUpdate: true }),
    ).toBe('updated');
    // 内容が戻れば duplicate 判定は更新後の内容で行われる。
    expect(
      registry.register('unit', 'qd_alias', 'new-css', 'a.tsx', { allowUpdate: true }),
    ).toBe('duplicate');
    // 異なる source からの「更新」はやはり衝突。
    expect(() =>
      registry.register('unit', 'qd_alias', 'other-css', 'b.tsx', { allowUpdate: true }),
    ).toThrow(StyleCollisionError);
    // allowUpdate なしの同一 source 再登録も content-addressed id では衝突。
    const strict = new IdentityRegistry();
    strict.register('global', 'qkf_abc', '@keyframes qkf_abc{...a}', 'a.tsx');
    expect(() => strict.register('global', 'qkf_abc', '@keyframes qkf_abc{...b}', 'a.tsx')).toThrow(
      StyleCollisionError,
    );
  });

  it('has は登録済み id のみ true', () => {
    const registry = new IdentityRegistry();
    registry.register('unit', 'q_abc', 'x', 'a.tsx');
    expect(registry.has('unit', 'q_abc')).toBe(true);
    expect(registry.has('unit', 'q_def')).toBe(false);
    expect(registry.has('pack', 'q_abc')).toBe(false);
  });
});
