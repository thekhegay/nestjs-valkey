import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { ValkeyStoreError } from '../../src/index.js';
import { hashTag } from '../../src/internal/keys.js';
import { ValkeyLockStore } from '../../src/locks/index.js';
import { env, glideCluster, ioredisCluster, missing, type Address } from '../support/servers.js';
import { keySlot } from '../support/slot.js';

// A slot migrating key by key (MIGRATE, valkey-cli's default reshard) refuses a script whose keys
// are not all on one side of the move with TRYAGAIN, or ASK and then TRYAGAIN. acquire() of a lock
// that is not held has a missing lock key, so it fails for as long as the slot stays open; a held
// lock answers where it is. The suite leaves a slot of the shared cluster open while it runs, so
// it runs alone, after the others, and closes the slot again whatever happens.
const skip = missing('VALKEY_CLUSTER_SEEDS');

interface Primary {
  id: string;
  address: Address;
  from: number;
  to: number;
}

async function primaries(seed: Address): Promise<Primary[]> {
  const client = new Redis({ ...seed, commandTimeout: 5_000 });
  try {
    const ranges = (await client.call('CLUSTER', 'SLOTS')) as [number, number, [string, number, string]][];
    return ranges.map(([from, to, [host, port, id]]) => ({ id, address: { host, port }, from, to }));
  } finally {
    client.disconnect();
  }
}

/** Another key whose lock lands in the same slot as `key`'s. */
function sameSlot(key: string, label: string): string {
  const slot = keySlot(`locks:{${hashTag(key)}}`);
  for (let i = 0; ; i++) {
    const other = `${key}:${label}:${i}`;
    if (keySlot(`locks:{${hashTag(other)}}`) === slot) return other;
  }
}

describe(
  `while a slot migrates key by key${skip ? ` (skipped: ${skip})` : ''}`,
  { skip: skip !== false },
  () => {
    for (const target of [glideCluster(), ioredisCluster()]) {
      it(`refuses acquire() of a lock that is not held there, and answers for a held one (${target.name})`, async () => {
        const held = `migration:${randomUUID()}`;
        const [free, released] = [sameSlot(held, 'free'), sameSlot(held, 'released')];
        const slot = keySlot(`locks:{${hashTag(held)}}`);
        const nodes = await primaries(env.cluster![0]!);
        const source = nodes.find(({ from, to }) => slot >= from && slot <= to)!;
        const destination = nodes.find(({ id }) => id !== source.id)!;
        const [from, to] = [source, destination].map(
          ({ address }) => new Redis({ ...address, commandTimeout: 5_000 }),
        ) as [Redis, Redis];
        const connection = await target.connect();
        const locks = new ValkeyLockStore(connection.runner, { startupCheck: false });
        try {
          expect((await locks.acquire(held, 'a', 60_000)).acquired).toBe(true);
          expect((await locks.acquire(released, 'a', 60_000)).acquired).toBe(true);
          expect(await locks.release(released, 'a')).toBe(true);

          await to.call('CLUSTER', 'SETSLOT', String(slot), 'IMPORTING', source.id);
          await from.call('CLUSTER', 'SETSLOT', String(slot), 'MIGRATING', destination.id);
          for (const key of [free, released]) {
            const error = await locks.acquire(key, 'b', 60_000).catch((e: unknown) => e);
            expect(error, key).toBeInstanceOf(Error);
            expect(error, key).not.toBeInstanceOf(ValkeyStoreError);
            expect(String((error as Error).message), key).toMatch(/try ?again|cluster redirections/i);
            // Nothing written on either side: the source sends a missing key on with ASK, and the
            // destination, asked, has none.
            await expect(from.exists(`locks:{${hashTag(key)}}`), key).rejects.toThrow(/^ASK /);
            await to.call('ASKING');
            expect(await to.exists(`locks:{${hashTag(key)}}`), key).toBe(0);
          }
          expect(await locks.acquire(held, 'b', 60_000)).toEqual({ acquired: false });
          expect(await locks.renew(held, 'a', 60_000)).toBe(true);
          expect(await locks.release(held, 'a')).toBe(true);
        } finally {
          await to.call('CLUSTER', 'SETSLOT', String(slot), 'STABLE');
          await from.call('CLUSTER', 'SETSLOT', String(slot), 'STABLE');
          from.disconnect();
          to.disconnect();
        }
        try {
          // Closed again, the slot serves every call.
          expect((await locks.acquire(free, 'c', 60_000)).acquired).toBe(true);
          expect(await locks.release(free, 'c')).toBe(true);
        } finally {
          await connection.close();
        }
      });
    }
  },
);
