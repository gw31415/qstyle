import { describe, expect, it } from 'vitest';
import { tokenizeClassAttr } from './tokenize.js';

describe('tokenizeClassAttr', () => {
  it('splits on whitespace runs', () => {
    expect(tokenizeClassAttr('flex  gap-4\nmd:grid\thover:bg-red-500')).toEqual([
      'flex',
      'gap-4',
      'md:grid',
      'hover:bg-red-500',
    ]);
  });

  it('returns empty for empty input', () => {
    expect(tokenizeClassAttr('')).toEqual([]);
    expect(tokenizeClassAttr('   ')).toEqual([]);
  });

  it('keeps duplicates (caller dedups via Set)', () => {
    expect(tokenizeClassAttr('flex flex')).toEqual(['flex', 'flex']);
  });
});
