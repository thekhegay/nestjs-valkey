import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { hashTag } from '../../src/internal/keys.js';
import { ValkeyLockStore } from '../../src/locks/index.js';
import {
  env,
  glideCluster,
  ioredisCluster,
  missing,
  type Address,
  type Connection,
} from '../support/servers.js';
import { sleep } from '../support/sleep.js';
import { keySlot } from '../support/slot.js';

// Opt-in (NVK_CHAOS=1, `pnpm test:chaos`): it promotes replicas of the shared cluster, so it runs
// alone, after every other suite.
const skip = process.env.NVK_CHAOS ? missing('VALKEY_CLUSTER_SEEDS') : 'NVK_CHAOS is not set';
const WORKERS = 16;
const KEYS = 32;
const RUN_FOR = 9_000;

interface ClusterNode {
  id: string;
  address: Address;
  /** The primary's id, for a replica. */
  primary: string | null;
  flags: string[];
  slots: string[];
}

async function clusterNodes(seed: Address): Promise<ClusterNode[]> {
  const client = new Redis({ ...seed, commandTimeout: 5_000 });
  try {
    return String(await client.call('CLUSTER', 'NODES'))
      .trim()
      .split('\n')
      .map((line) => {
        const [id, address, flags, primary, , , , , ...slots] = line.split(' ');
        const [host, port] = address!.split('@')[0]!.split(':');
        return {
          id: id!,
          address: { host: host!, port: Number(port) },
          primary: primary === '-' ? null : primary!,
          flags: flags!.split(','),
          slots,
        };
      });
  } finally {
    client.disconnect();
  }
}

/** A shard is named by its slot range, which moves with it from a primary to the replica it promotes. */
const bounds = (range: string) => range.split('-').map(Number) as [number, number];

/**
 * Promotes a replica of the shard that serves `range` with a coordinated CLUSTER FAILOVER, and
 * waits until the cluster names that replica as the range's primary.
 */
async function failOver(seed: Address, range: string): Promise<string> {
  const nodes = await clusterNodes(seed);
  const primary = nodes.find((node) => node.slots.includes(range));
  const replica = nodes.find((node) => node.primary === primary?.id && !node.flags.includes('fail'));
  if (!primary || !replica) throw new Error(`slots ${range} have no primary with a healthy replica`);
  const node = new Redis({ ...replica.address, commandTimeout: 5_000 });
  try {
    await node.call('CLUSTER', 'FAILOVER');
    for (let i = 0; i < 100; i++) {
      const owner = (await clusterNodes(seed)).find((n) => n.slots.includes(range));
      if (owner?.id === replica.id) return `${range} from ${primary.address.port} to ${replica.address.port}`;
      await sleep(100);
    }
    throw new Error(`no replica took over slots ${range}`);
  } finally {
    node.disconnect();
  }
}

describe(
  `fencing tokens through failovers${skip ? ` (skipped: ${skip})` : ''}`,
  { skip: skip !== false },
  () => {
    const connections: Connection[] = [];
    afterAll(async () => {
      await Promise.all(connections.map((c) => c.close()));
    });

    it(
      'never hand out a token that did not grow, nor fail a call, while CLUSTER FAILOVER moves each shard under load',
      { timeout: 120_000 },
      async () => {
        const seed = env.cluster![0]!;
        const ranges = (await clusterNodes(seed))
          .flatMap((node) => (node.slots.length > 0 ? [node.slots[0]!] : []))
          .toSorted((a, b) => bounds(a)[0] - bounds(b)[0]);
        expect(ranges).toHaveLength(3);

        const run = randomUUID();
        const keys = Array.from({ length: KEYS }, (_, i) => `chaos:${run}:${i}`);
        // Every shard holds some of the locks, so every failover moves locks under load.
        const slots = keys.map((key) => keySlot(`locks:{${hashTag(key)}}`));
        for (const range of ranges) {
          const [from, to] = bounds(range);
          expect(
            slots.some((slot) => slot >= from && slot <= to),
            range,
          ).toBe(true);
        }

        const targets = [glideCluster(), ioredisCluster()];
        for (let i = 0; i < 8; i++) connections.push(await targets[i % targets.length]!.connect());
        const last = new Map<string, number>();
        const stats = { cycles: 0, errors: 0, regressions: 0 };
        const failures = new Set<string>();
        const deadline = Date.now() + RUN_FOR;

        const worker = async (w: number) => {
          const store = new ValkeyLockStore(connections[w % connections.length]!.runner, {
            startupCheck: false,
          });
          for (let n = 0; Date.now() < deadline; n++) {
            const key = keys[(w * 7 + n) % keys.length]!;
            const owner = `${w}:${n}`;
            try {
              const result = await store.acquire(key, owner, 5_000);
              if (!result.acquired) continue;
              if (result.fencingToken <= (last.get(key) ?? 0)) stats.regressions++;
              last.set(key, result.fencingToken);
              await store.renew(key, owner, 5_000);
              await store.release(key, owner);
              stats.cycles++;
            } catch (error) {
              stats.errors++;
              failures.add(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
              await sleep(50);
            }
          }
        };
        // One failover per shard, in turn, 2 s apart.
        const failovers: string[] = [];
        const rotate = async () => {
          for (const range of ranges) {
            await sleep(2_000);
            failovers.push(await failOver(seed, range));
          }
        };
        await Promise.all([...Array.from({ length: WORKERS }, (_, w) => worker(w)), rotate()]);

        console.info(`failover run: ${JSON.stringify(stats)}; failed over slots ${failovers.join(', ')}`);
        for (const failure of failures) console.info(`  a call failed: ${failure}`);
        expect(failovers).toHaveLength(ranges.length);
        expect(stats.regressions).toBe(0);
        expect(stats.errors, [...failures].join('\n')).toBe(0);
        expect(stats.cycles).toBeGreaterThan(1_000);
      },
    );
  },
);
