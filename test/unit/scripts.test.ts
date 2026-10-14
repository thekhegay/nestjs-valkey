import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as idempotency from '../../src/idempotency/scripts.js';
import { PROBE } from '../../src/internal/server-check.js';
import * as locks from '../../src/locks/scripts.js';

const scripts = [...Object.values(locks), ...Object.values(idempotency), PROBE];

describe('scripts', () => {
  it('are eight, with distinct names and the SHA1 of their exact source', () => {
    expect(scripts).toHaveLength(8);
    expect(new Set(scripts.map((s) => s.name)).size).toBe(8);
    for (const script of scripts) {
      expect(script.sha1).toBe(createHash('sha1').update(script.source).digest('hex'));
      expect(Object.isFrozen(script)).toBe(true);
    }
  });

  it('carry no #!lua shebang, which under OOM would refuse renew() and release() whole', () => {
    for (const script of scripts) expect(script.source.startsWith('#!')).toBe(false);
  });

  it('write numbers through string.format, never through tostring()', () => {
    expect(locks.ACQUIRE.source).toContain("string.format('%.0f', token)");
    for (const script of scripts) expect(script.source).not.toContain('tostring');
  });

  it('read everything in acquire() before the first write', () => {
    const source = locks.ACQUIRE.source;
    expect(source.indexOf("redis.call('GET', KEYS[2])")).toBeLessThan(source.indexOf("redis.call('SET'"));
    expect(source.indexOf("redis.call('TIME')")).toBeLessThan(source.indexOf("redis.call('SET'"));
  });
});
