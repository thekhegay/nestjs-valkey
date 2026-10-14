import { describe, expect, it } from 'vitest';
import { ValkeyStoreError } from '../../src/index.js';
import { describeReply, normalizeReply, readFlag } from '../../src/internal/replies.js';
import { defineScript } from '../../src/internal/script.js';

describe('normalizeReply()', () => {
  it('turns bytes into UTF-8 strings', () => {
    expect(normalizeReply(Buffer.from('ключ'))).toBe('ключ');
    expect(normalizeReply(new TextEncoder().encode('in-flight'))).toBe('in-flight');
  });

  it('turns a safe bigint into a number and leaves an unsafe one', () => {
    expect(normalizeReply(1791987506882969n)).toBe(1791987506882969);
    expect(normalizeReply(2n ** 53n)).toBe(2n ** 53n);
    expect(normalizeReply(-(2n ** 53n))).toBe(-(2n ** 53n));
  });

  it('turns undefined into null and walks nested arrays', () => {
    expect(normalizeReply(undefined)).toBeNull();
    expect(normalizeReply([0n, Buffer.from('a'), [undefined, [Buffer.from('b')]], null, 'c', 1])).toEqual([
      0,
      'a',
      [null, ['b']],
      null,
      'c',
      1,
    ]);
  });

  it('leaves anything else alone, for the store to refuse', () => {
    const map = new Map();
    expect(normalizeReply(map)).toBe(map);
    expect(normalizeReply(false)).toBe(false);
  });
});

describe('readFlag()', () => {
  const script = defineScript('locks.renew', 'return 1');

  it('reads 1 and 0, and refuses anything else naming the script but no data', () => {
    expect(readFlag(script, 1)).toBe(true);
    expect(readFlag(script, 0)).toBe(false);
    for (const reply of [2, '1', null, true, ['owner-secret']]) {
      expect(() => readFlag(script, reply)).toThrow(ValkeyStoreError);
    }
    expect(() => readFlag(script, ['owner-secret'])).toThrow(
      /^locks\.renew: unexpected reply \(an array of 1\)$/,
    );
  });

  it('describes a reply by its shape only', () => {
    expect(describeReply('secret')).toBe('a string');
    expect(describeReply(null)).toBe('null');
    expect(describeReply(1.5)).toBe('a non-integer number');
  });
});
