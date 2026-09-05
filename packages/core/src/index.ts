// @qstyle/core — Style IR / canonicalization / hashing / dedup / chunk planning
// plan.md Part III, IV, VIII, IX の実装起点。Milestone 1 以降で拡張する。
export const VERSION: string = '0.0.0-m0';

export type { StyleNode } from './ir.js';
export { createStaticAtom, hashStaticAtom } from './atom.js';
