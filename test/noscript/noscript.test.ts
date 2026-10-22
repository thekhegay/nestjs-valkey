import { randomUUID } from 'node:crypto';
import type { Cluster, Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as idempotencyScripts from '../../src/idempotency/scripts.js';
import { ValkeyIdempotencyStore } from '../../src/idempotency/index.js';
import { PROBE } from '../../src/internal/server-check.js';
import * as lockScripts from '../../src/locks/scripts.js';
import { ValkeyLockStore } from '../../src/locks/index.js';
import { admin, coreTargets, everyNode, type Connection } from '../support/servers.js';

const SHAS = [...Object.values(lockScripts), ...Object.values(idempotencyScripts), PROBE].map((s) => s.sha1);

for (const target of coreTargets()) {
  const title = target.skip ? `${target.name} (skipped: ${target.skip})` : target.name;
  describe(`after SCRIPT FLUSH, ${title}`, { skip: target.skip !== false }, () => {
    let server: Redis | Cluster;
    let connection: Connection;
    beforeAll(async () => {
      server = admin(target);
      connection = await target.connect();
    });
    afterAll(async () => {
      await connection.close();
      await server.quit();
    });

    it('sends each script again and every method keeps working, round after round', async () => {
      const locks = new ValkeyLockStore(connection.runner, { startupCheck: 'strict' });
      const idem = new ValkeyIdempotencyStore(connection.runner, { startupCheck: 'strict' });
      const nodes = await everyNode(server);
      for (let round = 0; round < 30; round++) {
        await Promise.all(nodes.map((node) => node.script('FLUSH')));
        const key = `${randomUUID()}:${round}`;
        expect((await locks.acquire(key, 'a', 10_000)).acquired).toBe(true);
        expect(await locks.renew(key, 'a', 10_000)).toBe(true);
        expect(await locks.release(key, 'a')).toBe(true);
        expect(await idem.acquire(key, 'a', 'fp', 10_000)).toEqual({ state: 'acquired' });
        expect(await idem.extend(key, 'a', 10_000)).toBe(true);
        // Every other round a response large enough for glideRunner() to send it as a command.
        const body = round % 2 === 0 ? round : 'x'.repeat(70 * 1024);
        expect(await idem.complete(key, 'a', { status: 200, headers: {}, body }, 10_000)).toBe(true);
        expect(await idem.release(key, 'a')).toBe(false);
        await locks.checkServer();
        await idem.checkServer();
      }
      if (!target.cluster) {
        expect(await (server as Redis).script('EXISTS', ...SHAS)).toEqual(SHAS.map(() => 1));
      }
    });
  });
}
