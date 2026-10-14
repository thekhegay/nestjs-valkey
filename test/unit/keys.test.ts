import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkDuration, checkKey, checkPrefix, hashTag } from '../../src/internal/keys.js';
import { HARD_KEYS, hashedPart, keySlot } from '../support/slot.js';

const braces = fc.string({
  unit: fc.constantFrom('{', '}', '%', '7', 'B', 'D', '2', '5', 'a', ':', 'é', '\u{1F512}'),
});

describe('hashTag()', () => {
  it('is injective, on strings full of braces and percent signs', () => {
    fc.assert(
      fc.property(braces, braces, (a, b) => {
        if (a !== b) expect(hashTag(a)).not.toBe(hashTag(b));
      }),
      { numRuns: 20_000 },
    );
  });

  it('is injective on arbitrary Unicode', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), fc.string({ unit: 'grapheme' }), (a, b) => {
        if (a !== b) expect(hashTag(a)).not.toBe(hashTag(b));
      }),
    );
  });

  it('never contains a brace and is never empty', () => {
    fc.assert(
      fc.property(braces, (key) => {
        const tag = hashTag(key);
        expect(tag).not.toMatch(/[{}]/);
        expect(tag.length).toBeGreaterThan(0);
      }),
    );
  });

  it('makes the tag the whole hashed part of a lock key and its fence, so both share a slot', () => {
    fc.assert(
      fc.property(braces, fc.constantFrom('locks:', 'coordinator:locks:', ''), (key, prefix) => {
        const lock = `${prefix}{${hashTag(key)}}`;
        const tag = Buffer.from(hashTag(key));
        expect(hashedPart(Buffer.from(lock)).equals(tag)).toBe(true);
        expect(hashedPart(Buffer.from(`${lock}:fence`)).equals(tag)).toBe(true);
        expect(keySlot(lock)).toBe(keySlot(`${lock}:fence`));
      }),
    );
  });

  it('keeps every hard key in one slot, where a naive {key} tag splits three of them', () => {
    const split = (lock: string) => keySlot(lock) !== keySlot(`${lock}:fence`);
    expect(HARD_KEYS.filter((key) => split(`locks:{${hashTag(key)}}`))).toEqual([]);
    expect(HARD_KEYS.filter((key) => split(`locks:{${key}}`))).toEqual(['', '}', '}{']);
    expect(new Set(HARD_KEYS.map(hashTag)).size).toBe(HARD_KEYS.length);
  });

  it('escapes the way the design fixes it, which is public API', () => {
    expect(hashTag('')).toBe('%');
    expect(hashTag('a{b}c%')).toBe('a%7Bb%7Dc%25');
    expect(hashTag('jobs:export')).toBe('jobs:export');
  });
});

describe('checks', () => {
  it('refuses a key with a lone surrogate, without naming it', () => {
    expect(() => checkKey('S', 'secret\uD800')).toThrow(TypeError);
    expect(() => checkKey('S', 'secret\uD800')).not.toThrow(/secret/);
    expect(() => checkKey('S', 'a\uDC00b')).toThrow(/lone surrogate/);
    expect(() => checkKey('S', 42)).toThrow(TypeError);
    expect(() => checkKey('S', '\u{1F512}')).not.toThrow();
    expect(() => checkKey('S', '')).not.toThrow();
  });

  it('refuses a prefix with a brace', () => {
    expect(() => checkPrefix('S', 'app{x}:')).toThrow(/must not contain/);
    expect(() => checkPrefix('S', 'app}:')).toThrow(TypeError);
    expect(() => checkPrefix('S', 'app:locks:')).not.toThrow();
    expect(() => checkPrefix('S', '')).not.toThrow();
    expect(() => checkPrefix('S', 1)).toThrow(TypeError);
  });

  it('takes whole milliseconds from 1 to weeks, and nothing else', () => {
    for (const ok of [1, 1000, 2_592_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(() => checkDuration('S', 'ttl', ok)).not.toThrow();
    }
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53, '100', null, undefined, 10n]) {
      expect(() => checkDuration('S', 'ttl', bad)).toThrow(RangeError);
    }
  });
});
