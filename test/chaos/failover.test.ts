import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { ValkeyLockStore } from '../../src/locks/index.js';
import { glideCluster, ioredisCluster, missing, type Connection } from '../support/servers.js';
import { sleep } from '../support/sleep.js';

// Opt-in (NVK_CHAOS=1, `pnpm test:chaos`): it promotes replicas of the shared cluster, so it runs
// alone, after every other suite.
const skip = process.env.NVK_CHAOS ? missing('VALKEY_CLUSTER_SEEDS') : 'NVK_CHAOS is not set';
const WORKERS = 16;
const KEYS = 32;
const RUN_FOR = 9_000;

/** Promotes one replica with a coordinated CLUSTER FAILOVER and waits until it is a primary. */
async function failOverOneShard(seed: { host: string; port: number }): Promise<void> {
  const any = new Redis({ ...seed, commandTimeout: 5_000 });
  try {
    const nodes = String(await any.call('CLUSTER', 'NODES'))
      .trim()
      .split('\n');
    const replica = nodes.map((line) => line.split(' ')).find((fields) => fields[2]!.includes('slave'));
    const [host, port] = replica![1]!.split('@')[0]!.split(':');
    const node = new Redis({ host: host!, port: Number(port), commandTimeout: 5_000 });
    try {
      await node.call('CLUSTER', 'FAILOVER');
      for (let i = 0; i < 100; i++) {
        const role = (await node.call('ROLE')) as unknown[];
        if (role[0] === 'master') return;
        await sleep(100);
      }
      throw new Error('the replica did not take over');
    } finally {
      node.disconnect();
    }
  } finally {
    any.disconnect();
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
      'never hand out a token that did not grow, while CLUSTER FAILOVER moves primaries under load',
      { timeout: 120_000 },
      async () => {
        const targets = [glideCluster(), ioredisCluster()];
        for (let i = 0; i < 8; i++) connections.push(await targets[i % targets.length]!.connect());
        const run = randomUUID();
        const keys = Array.from({ length: KEYS }, (_, i) => `chaos:${run}:${i}`);
        const last = new Map<string, number>();
        const stats = { cycles: 0, errors: 0, regressions: 0 };
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
            } catch {
              stats.errors++;
              await sleep(50);
            }
          }
        };
        const failovers = async () => {
          for (let i = 0; i < 3; i++) {
            await sleep(2_000);
            await failOverOneShard({
              host: '127.0.0.1',
              port: Number(process.env.VALKEY_CLUSTER_SEEDS!.split(',')[0]!.split(':')[1]),
            });
          }
        };
        await Promise.all([...Array.from({ length: WORKERS }, (_, w) => worker(w)), failovers()]);

        console.info(`failover run: ${JSON.stringify(stats)}`);
        expect(stats.regressions).toBe(0);
        expect(stats.cycles).toBeGreaterThan(1_000);
      },
    );
  },
);
