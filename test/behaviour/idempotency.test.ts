import { randomUUID } from 'node:crypto';
import type { Cluster, Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ValkeyIdempotencyStore } from '../../src/idempotency/index.js';
import { admin, coreTargets, type Connection } from '../support/servers.js';
import { sleep } from '../support/sleep.js';

const response = {
  status: 201,
  headers: { location: '/charges/1' },
  body: { id: 'ch_1', n: 9007199254740991 },
};

for (const target of coreTargets()) {
  const title = target.skip ? `${target.name} (skipped: ${target.skip})` : target.name;
  describe(`ValkeyIdempotencyStore on ${title}`, { skip: target.skip !== false, concurrent: true }, () => {
    let server: Redis | Cluster;
    const pool: Connection[] = [];
    beforeAll(async () => {
      server = admin(target);
      for (let i = 0; i < 4; i++) pool.push(await target.connect());
    });
    afterAll(async () => {
      await Promise.all(pool.map((c) => c.close()));
      await server.quit();
    });
    const store = (at = 0) =>
      new ValkeyIdempotencyStore(pool[at % pool.length]!.runner, { startupCheck: false });

    it("writes the documentation's record: a hash with state, fp, owner and then resp", async () => {
      const key = `scope:${randomUUID()}`;
      const idem = store();
      expect(await idem.acquire(key, 'owner-a', 'fp-a', 30_000)).toEqual({ state: 'acquired' });
      expect(await server.hgetall(`idem:${key}`)).toEqual({
        state: 'in-flight',
        fp: 'fp-a',
        owner: 'owner-a',
      });
      expect(await server.pttl(`idem:${key}`)).toBeLessThanOrEqual(30_000);
      expect(await idem.complete(key, 'owner-a', response, 120_000)).toBe(true);
      expect(await server.hgetall(`idem:${key}`)).toEqual({
        state: 'completed',
        fp: 'fp-a',
        resp: JSON.stringify(response),
      });
      expect(await server.pttl(`idem:${key}`)).toBeGreaterThan(115_000);
    });

    it('completes, extends and releases for the owner only, and a completed record is final', async () => {
      const key = randomUUID();
      const idem = store();
      await idem.acquire(key, 'a', 'fp-a', 10_000);
      expect(await idem.extend(key, 'b', 60_000)).toBe(false);
      expect(await server.pttl(`idem:${key}`)).toBeLessThanOrEqual(10_000);
      expect(await idem.complete(key, 'b', response, 60_000)).toBe(false);
      expect(await idem.release(key, 'b')).toBe(false);
      expect(await idem.acquire(key, 'c', 'fp-c', 10_000)).toEqual({
        state: 'in-flight',
        fingerprint: 'fp-a',
      });
      expect(await idem.extend(key, 'a', 60_000)).toBe(true);
      expect(await server.pttl(`idem:${key}`)).toBeGreaterThan(55_000);
      expect(await idem.complete(key, 'a', response, 5_000)).toBe(true);
      expect(await idem.extend(key, 'a', 60_000)).toBe(false);
      expect(await idem.release(key, 'a')).toBe(false);
      expect(await idem.complete(key, 'a', { ...response, status: 500 }, 60_000)).toBe(false);
      expect(await server.pttl(`idem:${key}`)).toBeLessThanOrEqual(5_000);
      expect(await idem.acquire(key, 'd', 'fp-d', 10_000)).toEqual({
        state: 'completed',
        fingerprint: 'fp-a',
        response,
      });
    });

    it('expires an in-flight lock after lockTtl, and fences off its stale owner', async () => {
      const key = randomUUID();
      const idem = store();
      await idem.acquire(key, 'crashed', 'fp-a', 200);
      await sleep(350);
      expect(await idem.acquire(key, 'retry', 'fp-b', 10_000)).toEqual({ state: 'acquired' });
      expect(await idem.extend(key, 'crashed', 10_000)).toBe(false);
      expect(await idem.complete(key, 'crashed', response, 10_000)).toBe(false);
      expect(await idem.release(key, 'crashed')).toBe(false);
    });

    it('lets exactly one of many concurrent acquirers take a key; the rest see its fingerprint', async () => {
      const key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 32 }, (_, i) => store(i).acquire(key, `c${i}`, `fp-${i}`, 10_000)),
      );
      const winner = results.findIndex((r) => r.state === 'acquired');
      expect(results.filter((r) => r.state === 'acquired')).toHaveLength(1);
      for (const [i, r] of results.entries()) {
        if (i !== winner) expect(r).toEqual({ state: 'in-flight', fingerprint: `fp-${winner}` });
      }
    });
  });
}
