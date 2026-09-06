import { describe, expect, it } from 'vitest';
import {
  buildGlobalAtRule,
  buildKeyframesRule,
  normalizeFrameSelector,
  parseGlobalAtRuleKey,
  parseKeyframesKey,
  parseLayerKey,
  rewriteAnimationValue,
  serializeGlobalAtRuleCss,
  serializeKeyframesCss,
} from './keyframes.js';

const PROV = [{ source: 'test', line: 1, column: 1 }] as const;

describe('keyframes at-rule helpers', () => {
  it('parses @keyframes keys (case-insensitive prefix, ident only)', () => {
    expect(parseKeyframesKey('@keyframes fade')).toBe('fade');
    expect(parseKeyframesKey('@KEYFRAMES slide-in')).toBe('slide-in');
    expect(parseKeyframesKey('@keyframes')).toBeNull();
    expect(parseKeyframesKey('@keyframes "quoted"')).toBeNull();
    expect(parseKeyframesKey('@keyframes a b')).toBeNull();
    expect(parseKeyframesKey('@media (x)')).toBeNull();
  });

  it('parses @font-face / @property keys', () => {
    expect(parseGlobalAtRuleKey('@font-face')).toEqual({ at: 'font-face', prelude: '' });
    expect(parseGlobalAtRuleKey('@property --brand')).toEqual({ at: 'property', prelude: '--brand' });
    expect(parseGlobalAtRuleKey('@property brand')).toBeNull();
    expect(parseGlobalAtRuleKey('@font-face x')).toBeNull();
  });

  it('parses @layer keys (dotted + anonymous)', () => {
    expect(parseLayerKey('@layer base')).toBe('base');
    expect(parseLayerKey('@LAYER base.components')).toBe('base.components');
    expect(parseLayerKey('@layer')).toBe('');
    expect(parseLayerKey('@layer base; x')).toBeNull();
    expect(parseLayerKey('@media (x)')).toBeNull();
  });

  it('normalizes frame selectors', () => {
    expect(normalizeFrameSelector('from')).toBe('from');
    expect(normalizeFrameSelector('TO')).toBe('to');
    expect(normalizeFrameSelector('0%')).toBe('0%');
    expect(normalizeFrameSelector('0%,  100%')).toBe('0%, 100%');
    expect(normalizeFrameSelector('50')).toBeNull();
    expect(normalizeFrameSelector('from, bogus')).toBeNull();
    expect(normalizeFrameSelector('')).toBeNull();
  });

  it('builds a content-hashed keyframes rule (order-insensitive identity)', () => {
    const a = buildKeyframesRule(
      'fade',
      { from: { opacity: 0 }, to: { opacity: 1 } },
      [...PROV],
    );
    const b = buildKeyframesRule(
      'other-name',
      { to: { opacity: 1 }, from: { opacity: 0 } },
      [...PROV],
    );
    if (!('rule' in a) || !('rule' in b)) throw new Error('expected rules');
    // 別名・順序違いでも同一内容は同一確定名。
    expect(a.rule.name).toBe(b.rule.name);
    expect(a.rule.name).toMatch(/^qkf_[0-9a-f]{8}$/);
    expect(a.rule.sourceName).toBe('fade');
    expect(serializeKeyframesCss(a.rule)).toBe(
      `@keyframes ${a.rule.name}{from{opacity:0}to{opacity:1}}`,
    );
  });

  it('rejects dynamic values and bad frames as failures (no throw)', () => {
    expect(
      buildKeyframesRule('fade', { from: { opacity: {} } }, [...PROV]),
    ).toMatchObject({ reason: 'unsupported-value' });
    expect(buildKeyframesRule('fade', { middle: { opacity: 0 } }, [...PROV])).toMatchObject({
      reason: 'unsupported-syntax',
    });
    expect(buildKeyframesRule('fade', {}, [...PROV])).toMatchObject({
      reason: 'unsupported-syntax',
    });
  });

  it('builds global at-rules with stable ids', () => {
    const a = buildGlobalAtRule(
      'font-face',
      '',
      { fontFamily: 'MyFont', src: 'url(/a.woff2)' },
      [...PROV],
    );
    const b = buildGlobalAtRule(
      'font-face',
      '',
      { src: 'url(/a.woff2)', fontFamily: 'MyFont' },
      [...PROV],
    );
    if (!('rule' in a) || !('rule' in b)) throw new Error('expected rules');
    expect(a.rule.id).toBe(b.rule.id);
    expect(serializeGlobalAtRuleCss(a.rule)).toBe('@font-face{font-family:MyFont;src:url(/a.woff2)}');
    const p = buildGlobalAtRule('property', '--brand', { syntax: '"<color>"', inherits: 'false' }, [...PROV]);
    if (!('rule' in p)) throw new Error('expected rule');
    expect(serializeGlobalAtRuleCss(p.rule).startsWith('@property --brand{')).toBe(true);
  });

  it('rewrites only exact animation-name tokens', () => {
    const map = new Map([['fade', 'qkf_12345678']]);
    expect(rewriteAnimationValue('fade 1s ease', map)).toBe('qkf_12345678 1s ease');
    expect(rewriteAnimationValue('fade, slide 2s', map)).toBe('qkf_12345678, slide 2s');
    // CSS-wide keyword / none は書換えない。
    expect(rewriteAnimationValue('none', map)).toBe('none');
    expect(rewriteAnimationValue('inherit', map)).toBe('inherit');
    // 部分一致・関数内は触らない。
    expect(rewriteAnimationValue('fadein 1s', map)).toBe('fadein 1s');
    expect(rewriteAnimationValue('var(--fade)', map)).toBe('var(--fade)');
    expect(rewriteAnimationValue('fade 1s', new Map())).toBe('fade 1s');
  });
});
