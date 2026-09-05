import { describe, expect, it } from 'vitest';
import { formatAtomReport } from './index.js';

describe('inspector', () => {
  it('formats atom report', () => {
    const out = formatAtomReport({
      atomId: 'q_a81d',
      semantic: 'display:flex',
      usedBy: ['Button'],
      routes: ['/'],
      chunk: 'style.71bc9.css',
      sources: ['button.tsx:42'],
    });
    expect(out).toContain('Atom: q_a81d');
    expect(out).toContain('style.71bc9.css');
  });
});
