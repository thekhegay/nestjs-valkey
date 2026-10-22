import { randomUUID } from 'node:crypto';
import { GlideClient, Decoder } from '@valkey/valkey-glide';
import type { Cluster, Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { glideRunner } from '../../src/glide/index.js';
import { ValkeyStoreError, type ScriptRunner } from '../../src/index.js';
import { hashTag } from '../../src/internal/keys.js';
import { ValkeyLockStore, type ValkeyLockStoreOptions } from '../../src/locks/index.js';
import { admin, coreTargets, env, missing, type Connection } from '../support/servers.js';
import { sleep } from '../support/sleep.js';

const DAY = 86_400_000;

for (const target of coreTargets()) {
  const title = target.skip ? `${target.name} (skipped: ${target.skip})` : target.name;
  describe(`ValkeyLockStore on ${title}`, { skip: target.skip !== false, concurrent: true }, () => {
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
    const store = (options: ValkeyLockStoreOptions = {}, at = 0) =>
      new ValkeyLockStore(pool[at % pool.length]!.runner, { startupCheck: false, ...options });
    const lockKey = (key: string, prefix = 'locks:') => `${prefix}{${hashTag(key)}}`;
    const serverClock = async () => {
      const [seconds, micros] = (await server.call('TIME')) as [string, string];
      return Number(seconds) * 1_000_000 + Number(micros);
    };
    const token = async (locks: ValkeyLockStore, key: string, owner: string, ttl = 10_000) => {
      const result = await locks.acquire(key, owner, ttl);
      if (!result.acquired) throw new Error(`acquire() by ${owner} was refused`);
      return result.fencingToken;
    };

    it('stores the token it hands out as the fence, expiring fenceRetention after the acquisition', async () => {
      const key = randomUUID();
      const locks = store({ fenceRetention: 120_000 });
      const before = await serverClock();
      const first = await token(locks, key, 'a');
      expect(first).toBeGreaterThanOrEqual(before);
      expect(first).toBeLessThan(before + 5_000_000);
      expect(await server.get(`${lockKey(key)}:fence`)).toBe(String(first));
      expect(await server.get(lockKey(key))).toBe('a');
      const pttl = await server.pttl(`${lockKey(key)}:fence`);
      expect(pttl).toBeGreaterThan(115_000);
      expect(pttl).toBeLessThanOrEqual(120_000);
    });

    it('hands out strictly growing tokens per key across releases, expiries and re-acquisitions', async () => {
      const key = randomUUID();
      const locks = store();
      const tokens: number[] = [];
      for (let i = 0; i < 5; i++) {
        tokens.push(await token(store({}, i), key, `released-${i}`));
        expect(await locks.release(key, `released-${i}`)).toBe(true);
      }
      tokens.push(await token(locks, key, 'expires', 100));
      await sleep(250);
      expect(await locks.renew(key, 'expires', 10_000)).toBe(false);
      tokens.push(await token(locks, key, 'after-expiry', 100));
      await sleep(250);
      tokens.push(await token(locks, key, 'again'));
      for (let i = 1; i < tokens.length; i++) expect(tokens[i]!).toBeGreaterThan(tokens[i - 1]!);
      expect(tokens.every((t) => Number.isSafeInteger(t))).toBe(true);
    });

    it('keeps growing when the fence is lost between acquisitions', async () => {
      const key = randomUUID();
      const locks = store();
      const first = await token(locks, key, 'a');
      await locks.release(key, 'a');
      await server.del(`${lockKey(key)}:fence`);
      expect(await token(locks, key, 'b')).toBeGreaterThan(first);
    });

    it('gives exactly one more than a fence that is a day ahead, and keeps that fence a day longer', async () => {
      const key = randomUUID();
      const ahead = (await serverClock()) + DAY * 1000;
      await server.set(`${lockKey(key)}:fence`, String(ahead), 'PX', 60_000);
      const next = await token(store({ fenceRetention: 60_000 }), key, 'a');
      expect(next).toBe(ahead + 1);
      const pttl = await server.pttl(`${lockKey(key)}:fence`);
      expect(pttl).toBeGreaterThan(DAY + 55_000);
      expect(pttl).toBeLessThanOrEqual(DAY + 61_000);
    });

    it('keeps growing after the fence expired (fenceRetention: 1)', async () => {
      const key = randomUUID();
      const locks = store({ fenceRetention: 1 });
      const tokens = [await token(locks, key, 'a')];
      for (let i = 0; i < 5; i++) {
        await locks.release(key, i === 0 ? 'a' : `o-${i - 1}`);
        await sleep(15);
        expect(await server.exists(`${lockKey(key)}:fence`)).toBe(0);
        tokens.push(await token(locks, key, `o-${i}`));
      }
      for (let i = 1; i < tokens.length; i++) expect(tokens[i]!).toBeGreaterThan(tokens[i - 1]!);
    });

    it('refuses a fence it cannot extend before the first write, and leaves that fence as it was', async () => {
      const locks = store();
      const unreadable = ['1.5', 'abc', '0x10', '-5', '', '1e3', String(2 ** 53 - 2), String(2 ** 53 - 1)];
      for (const fence of [...unreadable, '9007199254740993', '1'.repeat(400)]) {
        const key = randomUUID();
        await server.set(`${lockKey(key)}:fence`, fence, 'PX', 60_000);
        const error = await locks.acquire(key, 'a', 10_000).catch((e: unknown) => e);
        expect(error, fence).toBeInstanceOf(Error);
        expect(error, fence).not.toBeInstanceOf(ValkeyStoreError);
        expect(String((error as Error).message), fence).toMatch(/locks\.acquire: the fence holds no token/);
        expect(String((error as Error).message), fence).not.toContain(key);
        expect(await server.exists(lockKey(key)), fence).toBe(0);
        expect(await server.get(`${lockKey(key)}:fence`), fence).toBe(fence);
      }
      // The highest fence it extends gives 2^53 - 2, a safe integer.
      const key = randomUUID();
      await server.set(`${lockKey(key)}:fence`, String(2 ** 53 - 3), 'PX', 60_000);
      expect(await token(locks, key, 'a')).toBe(2 ** 53 - 2);
      expect(await server.get(`${lockKey(key)}:fence`)).toBe(String(2 ** 53 - 2));
    });

    it('frees the lock when acquire() fails on the client after its script ran (a lost reply)', async () => {
      const key = randomUUID();
      const { runner } = pool[0]!;
      const lost = new Error('Command timed out');
      const losing: ScriptRunner = {
        async run(script, keys, args) {
          const reply = await runner.run(script, keys, args);
          if (script.name === 'locks.acquire') throw lost;
          return reply;
        },
      };
      await expect(
        new ValkeyLockStore(losing, { startupCheck: false }).acquire(key, 'a', 60_000),
      ).rejects.toBe(lost);
      // The release goes out behind the failed call, unawaited.
      for (let i = 0; i < 50 && (await server.exists(lockKey(key))) === 1; i++) await sleep(20);
      expect(await server.exists(lockKey(key))).toBe(0);
      expect(await server.exists(`${lockKey(key)}:fence`)).toBe(1);
      expect((await store().acquire(key, 'b', 10_000)).acquired).toBe(true);
    });

    it("hands out tokens far above any value the documentation's shared counter reaches", async () => {
      expect(await token(store(), randomUUID(), 'a')).toBeGreaterThan(2 ** 50);
    });

    it('renews and releases for the owner only, and a refused call changes nothing', async () => {
      const key = randomUUID();
      const locks = store();
      await token(locks, key, 'a', 10_000);
      expect(await locks.renew(key, 'b', 60_000)).toBe(false);
      expect(await server.pttl(lockKey(key))).toBeLessThanOrEqual(10_000);
      expect(await locks.release(key, 'b')).toBe(false);
      expect(await server.get(lockKey(key))).toBe('a');
      expect(await locks.renew(key, 'a', 60_000)).toBe(true);
      expect(await server.pttl(lockKey(key))).toBeGreaterThan(55_000);
      expect(await locks.release(key, 'a')).toBe(true);
      expect(await server.exists(lockKey(key))).toBe(0);
      expect(await server.exists(`${lockKey(key)}:fence`)).toBe(1);
      expect(await locks.release(key, 'a')).toBe(false);
      expect(await locks.renew(key, 'a', 1000)).toBe(false);
    });

    it('expires a lock after its ttl on the server clock, and never brings it back', async () => {
      const key = randomUUID();
      const locks = store();
      await token(locks, key, 'a', 400);
      await sleep(150);
      expect(await locks.acquire(key, 'b', 400)).toEqual({ acquired: false });
      await sleep(400);
      expect(await locks.renew(key, 'a', 10_000)).toBe(false);
      expect(await locks.release(key, 'a')).toBe(false);
      expect((await locks.acquire(key, 'b', 10_000)).acquired).toBe(true);
    });

    it('lets exactly one of many concurrent acquirers win, round after round, with growing tokens', async () => {
      const key = randomUUID();
      const tokens: number[] = [];
      for (let round = 0; round < 20; round++) {
        const results = await Promise.all(
          Array.from({ length: 32 }, (_, i) => store({}, i).acquire(key, `r${round}-c${i}`, 10_000)),
        );
        const winners = results.flatMap((r, i) =>
          r.acquired ? [{ token: r.fencingToken, owner: `r${round}-c${i}` }] : [],
        );
        expect(winners).toHaveLength(1);
        tokens.push(winners[0]!.token);
        expect(await store().release(key, winners[0]!.owner)).toBe(true);
      }
      for (let i = 1; i < tokens.length; i++) expect(tokens[i]!).toBeGreaterThan(tokens[i - 1]!);
    });

    it('lets exactly one win an expired lock, while its stale owner is fenced off', async () => {
      const key = randomUUID();
      const stale = await token(store(), key, 'stale', 100);
      await sleep(200);
      const results = await Promise.all(
        Array.from({ length: 32 }, (_, i) => store({}, i).acquire(key, `c${i}`, 10_000)),
      );
      const winners = results.filter((r) => r.acquired);
      expect(winners).toHaveLength(1);
      expect((winners[0] as { fencingToken: number }).fencingToken).toBeGreaterThan(stale);
      expect(await store().renew(key, 'stale', 10_000)).toBe(false);
      expect(await store().release(key, 'stale')).toBe(false);
    });
  });
}

const skip = missing('VALKEY_URL');
describe(
  `a glide client on a bytes decoder${skip ? ` (skipped: ${skip})` : ''}`,
  { skip: skip !== false },
  () => {
    it('still gets strings and numbers back, since every call asks for strings', async () => {
      const client = await GlideClient.createClient({
        addresses: [env.standalone!],
        defaultDecoder: Decoder.Bytes,
        requestTimeout: 5_000,
        advancedConfiguration: { connectionTimeout: 5_000 },
      });
      try {
        const locks = new ValkeyLockStore(glideRunner(client), { startupCheck: false });
        const key = randomUUID();
        const result = await locks.acquire(key, 'a', 10_000);
        expect(result.acquired && Number.isSafeInteger(result.fencingToken)).toBe(true);
        expect(await locks.release(key, 'a')).toBe(true);
        await locks.checkServer();
      } finally {
        client.close();
      }
    });
  },
);
