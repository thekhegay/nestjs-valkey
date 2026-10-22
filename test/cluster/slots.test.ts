import { randomUUID } from 'node:crypto';
import { Cluster } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ValkeyIdempotencyStore } from '../../src/idempotency/index.js';
import { hashTag } from '../../src/internal/keys.js';
import { defineScript } from '../../src/internal/script.js';
import { ioredisRunner } from '../../src/ioredis/index.js';
import { ValkeyLockStore } from '../../src/locks/index.js';
import { DOCS_LOCK_ACQUIRE } from '../support/docs-recipes.js';
import { recording } from '../support/recording.js';
import {
  admin,
  env,
  glideCluster,
  ioredisCluster,
  missing,
  type Connection,
  type Target,
} from '../support/servers.js';
import { HARD_KEYS, keySlot } from '../support/slot.js';

const skip = missing('VALKEY_CLUSTER_SEEDS');

describe(`in a cluster${skip ? ` (skipped: ${skip})` : ''}`, { skip: skip !== false }, () => {
  let server: Cluster;
  const connections: Connection[] = [];
  beforeAll(async () => {
    server = admin({ cluster: true }) as Cluster;
  });
  afterAll(async () => {
    await Promise.all(connections.map((c) => c.close()));
    await server.quit();
  });
  const connect = async (target: Target) => {
    const connection = await target.connect();
    connections.push(connection);
    return connection;
  };
  const slotOf = async (key: string) => Number(await server.call('CLUSTER', 'KEYSLOT', key));

  for (const target of [glideCluster(), ioredisCluster()]) {
    it(`every script call carries keys of one slot, for the hard keys too (${target.name})`, async () => {
      const runner = recording((await connect(target)).runner);
      const locks = new ValkeyLockStore(runner, { prefix: 'app:locks:', startupCheck: false });
      const idem = new ValkeyIdempotencyStore(runner, { prefix: 'app:idem:', startupCheck: false });
      const run = randomUUID();
      for (const hard of HARD_KEYS) {
        const key = `${hard}${run}`;
        const prefixed = `${run}${hard}`;
        for (const k of [hard, key, prefixed]) {
          const lock = await locks.acquire(k, 'a', 10_000);
          if (k !== hard) expect(lock.acquired).toBe(true);
          await locks.renew(k, 'a', 10_000);
          await locks.release(k, 'a');
        }
        expect((await idem.acquire(key, 'a', 'fp', 10_000)).state).toBe('acquired');
        expect(await idem.extend(key, 'a', 10_000)).toBe(true);
        expect(await idem.complete(key, 'a', { status: 200, headers: {}, body: null }, 10_000)).toBe(true);
        await idem.acquire(`${run}:${hard}`, 'b', 'fp', 10_000);
        expect(await idem.release(`${run}:${hard}`, 'b')).toBe(true);
      }
      expect(new Set(runner.calls.map((c) => c.script))).toEqual(
        new Set([
          'locks.acquire',
          'locks.renew',
          'locks.release',
          'idempotency.acquire',
          'idempotency.extend',
          'idempotency.complete',
          'idempotency.release',
        ]),
      );
      for (const call of runner.calls) {
        const slots = await Promise.all(call.keys.map(slotOf));
        expect(new Set(slots).size, `${call.script} with ${JSON.stringify(call.keys)}`).toBe(1);
        // The local CRC16 the unit tests rely on agrees with the server.
        expect(slots).toEqual(call.keys.map(keySlot));
      }
    });
  }

  it('gives every hard key its own tag, and a naive {key} tag would split three of them', async () => {
    const tags = HARD_KEYS.map(hashTag);
    expect(new Set(tags).size).toBe(HARD_KEYS.length);
    const split: string[] = [];
    for (const key of HARD_KEYS) {
      const ours = `locks:{${hashTag(key)}}`;
      expect(await slotOf(ours)).toBe(await slotOf(`${ours}:fence`));
      if ((await slotOf(`locks:{${key}}`)) !== (await slotOf(`locks:{${key}}:fence`))) split.push(key);
    }
    expect(split).toEqual(['', '}', '}{']);
  });

  it('spreads locks over every shard rather than one', async () => {
    const ranges = (await server.call('CLUSTER', 'SLOTS')) as [number, number, [string, number]][];
    const shardOf = (slot: number) => ranges.find(([from, to]) => slot >= from && slot <= to)![2][1];
    const run = randomUUID();
    const shards = new Set<number>();
    for (let i = 0; i < 64; i++) shards.add(shardOf(await slotOf(`locks:{${hashTag(`job:${run}:${i}`)}}`)));
    expect(shards.size).toBe(3);
  });

  it("refuses the documentation's lock recipe with CROSSSLOT, so this suite really runs on a cluster", async () => {
    for (let i = 0; i < 20; i++) {
      await expect(
        server.eval(DOCS_LOCK_ACQUIRE, 2, `locks:key:${randomUUID()}`, 'locks:fencing-token', 'owner', 1000),
      ).rejects.toThrow(/CROSSSLOT/);
    }
  });

  for (const target of [glideCluster('preferReplica'), ioredisCluster('ioredis', 'slave')]) {
    it(`runs every script on the primary even when the client reads from replicas (${target.name})`, async () => {
      const { runner } = await connect(target);
      const locks = new ValkeyLockStore(runner, { startupCheck: false });
      const idem = new ValkeyIdempotencyStore(runner, { startupCheck: false });
      const run = randomUUID();
      for (let i = 0; i < 50; i++) {
        const key = `${run}:${i}`;
        expect((await locks.acquire(key, 'a', 10_000)).acquired).toBe(true);
        expect(await locks.renew(key, 'a', 10_000)).toBe(true);
        expect(await locks.release(key, 'a')).toBe(true);
        expect((await idem.acquire(key, 'a', 'fp', 10_000)).state).toBe('acquired');
        expect(await idem.complete(key, 'a', { status: 200, headers: {}, body: i }, 10_000)).toBe(true);
      }
    });
  }

  // The probe reads one node's ACL and maxmemory-policy: a replica's may differ from the primaries'.
  const ROLE = defineScript(
    'test.role',
    "return string.match(redis.call('INFO', 'replication'), 'role:(%a+)')",
  );
  for (const target of [glideCluster(), glideCluster('preferReplica'), ioredisCluster('ioredis', 'slave')]) {
    it(`sends a keyless call, the startup probe, to a primary (${target.name})`, async () => {
      const { runner } = await connect(target);
      const roles = new Set<unknown>();
      for (let i = 0; i < 60; i++) roles.add(await runner.run(ROLE, [], []));
      expect(roles).toEqual(new Set(['master']));
      await new ValkeyLockStore(runner, { startupCheck: 'strict' }).checkServer();
    });
  }

  it('puts an ioredis keyPrefix in front of a lock and its fence alike, one slot each, and refuses one with a brace', async () => {
    const keyPrefix = `kp:${randomUUID()}:`;
    const client = new Cluster(env.cluster!, { keyPrefix, redisOptions: { commandTimeout: 5_000 } });
    try {
      const locks = new ValkeyLockStore(ioredisRunner(client), { startupCheck: false });
      const slots = new Set<number>();
      for (let i = 0; i < 16; i++) {
        const lock = `${keyPrefix}locks:{${hashTag(`job:${i}`)}}`;
        expect((await locks.acquire(`job:${i}`, 'a', 10_000)).acquired).toBe(true);
        expect(await server.get(lock)).toBe('a');
        expect(await server.exists(`${lock}:fence`)).toBe(1);
        expect(await slotOf(`${lock}:fence`)).toBe(await slotOf(lock));
        slots.add(await slotOf(lock));
        expect(await locks.release(`job:${i}`, 'a')).toBe(true);
      }
      expect(slots.size).toBe(16);
    } finally {
      client.disconnect();
    }
    for (const braced of [`{${keyPrefix}}`, `${keyPrefix}{}:`]) {
      const cluster = new Cluster(env.cluster!, {
        lazyConnect: true,
        keyPrefix: braced,
        redisOptions: { commandTimeout: 5_000 },
      });
      expect(() => ioredisRunner(cluster)).toThrow(/keyPrefix must not contain/);
      cluster.disconnect();
    }
  });

  it('refuses an ioredis Cluster whose node connections return integers as strings (redisOptions.stringNumbers)', async () => {
    const cluster = new Cluster(env.cluster!, {
      redisOptions: { commandTimeout: 5_000, stringNumbers: true },
    });
    try {
      expect(await cluster.eval('return 1', 1, randomUUID())).toBe('1');
      expect(() => ioredisRunner(cluster)).toThrow(/stringNumbers/);
    } finally {
      cluster.disconnect();
    }
  });
});
