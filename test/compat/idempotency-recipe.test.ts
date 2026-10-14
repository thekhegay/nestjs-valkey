import { randomUUID } from 'node:crypto';
import type { Cluster, Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ValkeyIdempotencyStore } from '../../src/idempotency/index.js';
import {
  DOCS_IDEM_ACQUIRE,
  DOCS_IDEM_COMPLETE,
  DOCS_IDEM_EXTEND,
  DOCS_IDEM_RELEASE,
} from '../support/docs-recipes.js';
import { admin, glideCluster, glideStandalone, type Connection } from '../support/servers.js';

const response = {
  status: 201,
  headers: {},
  body: { receiptId: 'ch_0001', max: 9007199254740991, nul: '\u0000' },
};

// The recipe and the store share a record layout, so an application can move from one to the
// other (and back) during a rolling deploy: old instances run the recipe, new ones the store.
for (const target of [glideStandalone(), glideCluster()]) {
  const title = target.skip ? `${target.name} (skipped: ${target.skip})` : target.name;
  describe(
    `the documentation's idempotency recipe and the store, ${title}`,
    { skip: target.skip !== false },
    () => {
      let recipe: Redis | Cluster;
      let connection: Connection;
      let store: ValkeyIdempotencyStore;
      beforeAll(async () => {
        recipe = admin(target);
        connection = await target.connect();
        store = new ValkeyIdempotencyStore(connection.runner, { startupCheck: false });
      });
      afterAll(async () => {
        await connection.close();
        await recipe.quit();
      });

      it('the store reads what the recipe wrote, a 2^53 - 1 in the response included', async () => {
        const key = `scope:${randomUUID()}`;
        expect(
          await recipe.eval(DOCS_IDEM_ACQUIRE, 1, `idem:${key}`, 'fp-recipe', 'owner-recipe', 10_000),
        ).toEqual([1]);
        expect(await store.acquire(key, 'owner-store', 'fp-store', 10_000)).toEqual({
          state: 'in-flight',
          fingerprint: 'fp-recipe',
        });
        expect(await store.extend(key, 'owner-recipe', 10_000)).toBe(true);
        expect(
          await recipe.eval(
            DOCS_IDEM_COMPLETE,
            1,
            `idem:${key}`,
            'owner-recipe',
            JSON.stringify(response),
            10_000,
          ),
        ).toBe(1);
        const read = await store.acquire(key, 'owner-store', 'fp-store', 10_000);
        expect(read).toEqual({ state: 'completed', fingerprint: 'fp-recipe', response });
        expect((read as { response: typeof response }).response.body.max).toBe(Number.MAX_SAFE_INTEGER);
      });

      it("the recipe reads what the store wrote, and either side releases the other's lock", async () => {
        const key = `scope:${randomUUID()}`;
        expect(await store.acquire(key, 'owner-store', 'fp-store', 10_000)).toEqual({ state: 'acquired' });
        expect(
          await recipe.eval(DOCS_IDEM_ACQUIRE, 1, `idem:${key}`, 'fp-recipe', 'owner-recipe', 10_000),
        ).toEqual([0, 'in-flight', 'fp-store', null]);
        expect(await recipe.eval(DOCS_IDEM_EXTEND, 1, `idem:${key}`, 'owner-store', 10_000)).toBe(1);
        expect(await recipe.eval(DOCS_IDEM_RELEASE, 1, `idem:${key}`, 'owner-store')).toBe(1);

        expect(
          await recipe.eval(DOCS_IDEM_ACQUIRE, 1, `idem:${key}`, 'fp-recipe', 'owner-recipe', 10_000),
        ).toEqual([1]);
        expect(await store.release(key, 'owner-recipe')).toBe(true);

        expect(await store.acquire(key, 'owner-store', 'fp-store', 10_000)).toEqual({ state: 'acquired' });
        expect(await store.complete(key, 'owner-store', response, 10_000)).toBe(true);
        const [flag, state, fingerprint, json] = (await recipe.eval(
          DOCS_IDEM_ACQUIRE,
          1,
          `idem:${key}`,
          'fp-recipe',
          'owner-recipe',
          10_000,
        )) as [number, string, string, string];
        expect([flag, state, fingerprint]).toEqual([0, 'completed', 'fp-store']);
        expect(JSON.parse(json)).toEqual(response);
      });
    },
  );
}
