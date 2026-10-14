import { idempotencyStoreContract } from '@nestjs/idempotency/testing';
import { lockStoreContract } from '@nestjs/locks/testing';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { ValkeyIdempotencyStore } from '../../src/idempotency/index.js';
import type { ScriptRunner } from '../../src/index.js';
import { ValkeyLockStore } from '../../src/locks/index.js';
import type { Connection, Target } from './servers.js';

/** Connections per target, so the contracts' concurrent cases really overlap on the server. */
const POOL = 4;

/**
 * Both official contract suites, with their concurrency cases on, against each target. The cases
 * run concurrently: each uses a key prefix of its own, which the suites allow.
 */
export function contractSuites(targets: Target[]): void {
  for (const target of targets) {
    const name = target.skip ? `${target.name} (skipped: ${target.skip})` : target.name;
    describe(name, { skip: target.skip !== false, concurrent: true }, () => {
      const pool: Connection[] = [];
      beforeAll(async () => {
        for (let i = 0; i < POOL; i++) pool.push(await target.connect());
      });
      afterAll(async () => {
        await Promise.all(pool.map((connection) => connection.close()));
      });
      let next = 0;
      const runner = (): ScriptRunner => pool[next++ % pool.length]!.runner;

      describe('lockStoreContract', () => {
        const cases = lockStoreContract(() => new ValkeyLockStore(runner(), { startupCheck: false }), {
          concurrent: true,
        });
        for (const c of cases) it(c.name, c.run);
      });

      describe('idempotencyStoreContract', () => {
        const cases = idempotencyStoreContract(
          () => new ValkeyIdempotencyStore(runner(), { startupCheck: false }),
          { concurrent: true },
        );
        for (const c of cases) it(c.name, c.run);
      });
    });
  }
}
