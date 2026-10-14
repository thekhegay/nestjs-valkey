import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { Logger } from '@nestjs/common';
import { GlideClient } from '@valkey/valkey-glide';
import { Redis } from 'ioredis';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { glideRunner } from '../../src/glide/index.js';
import { ValkeyIdempotencyStore } from '../../src/idempotency/index.js';
import { COMPLETE } from '../../src/idempotency/scripts.js';
import { ValkeyStoreError, type ScriptRunner } from '../../src/index.js';
import { hashTag } from '../../src/internal/keys.js';
import { ACQUIRE, RENEW } from '../../src/locks/scripts.js';
import { ValkeyLockStore } from '../../src/locks/index.js';
import { ioredisRunner } from '../../src/ioredis/index.js';
import { env, missing } from '../support/servers.js';

const skip = missing('VALKEY_SCRATCH_URL');
/** The grants of rk's service users (nl/redis-users.acl), which have no +time. */
const SERVICE_GRANTS = [
  '~coordinator:*',
  '+@read',
  '+@write',
  '+@pubsub',
  '+@scripting',
  '+ping',
  '+client',
  '+info',
];

describe(
  `against a server the tests reconfigure${skip ? ` (skipped: ${skip})` : ''}`,
  { skip: skip !== false },
  () => {
    let server: Redis;
    let warn: MockInstance;
    const closers: (() => Promise<void> | void)[] = [];
    const users: string[] = [];

    beforeAll(async () => {
      server = new Redis({ ...env.scratch!, commandTimeout: 5_000 });
    });
    beforeEach(() => {
      warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await Promise.all(closers.splice(0).map((close) => close()));
      await server.config('SET', 'maxmemory', '0');
      await server.config('SET', 'maxmemory-policy', 'noeviction');
      for (const user of users.splice(0)) await server.acl('DELUSER', user);
    });
    afterAll(async () => {
      await server.quit();
    });

    /** A user with these grants, and a glide and an ioredis runner logged in as it. */
    async function as(grants: string[]): Promise<{ user: string; runners: [string, ScriptRunner][] }> {
      const user = `nvk-${randomUUID()}`;
      const password = randomUUID();
      users.push(user);
      await server.acl('SETUSER', user, 'reset', 'on', `>${password}`, ...grants);
      return { user, runners: await runnersFor({ username: user, password }) };
    }

    async function runnersFor(credentials?: {
      username: string;
      password: string;
    }): Promise<[string, ScriptRunner][]> {
      const glide = await GlideClient.createClient({
        addresses: [env.scratch!],
        requestTimeout: 5_000,
        ...(credentials && { credentials }),
      });
      const ioredis = new Redis({
        ...env.scratch!,
        ...credentials,
        commandTimeout: 5_000,
        enableReadyCheck: false,
      });
      closers.push(
        () => glide.close(),
        () => ioredis.disconnect(),
      );
      return [
        ['glide', glideRunner(glide)],
        ['ioredis', ioredisRunner(ioredis)],
      ];
    }

    it('passes the strict check on a healthy server, for both stores and both clients', async () => {
      for (const [, runner] of await runnersFor()) {
        await new ValkeyLockStore(runner, { startupCheck: 'strict' }).checkServer();
        await new ValkeyIdempotencyStore(runner, { startupCheck: 'strict' }).checkServer();
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns about an eviction policy other than noeviction, and fails on it under strict', async () => {
      await server.config('SET', 'maxmemory-policy', 'volatile-lru');
      for (const [, runner] of await runnersFor()) {
        await new ValkeyLockStore(runner).checkServer();
        await new ValkeyIdempotencyStore(runner).checkServer();
        await expect(new ValkeyLockStore(runner, { startupCheck: 'strict' }).checkServer()).rejects.toThrow(
          /maxmemory-policy is volatile-lru/,
        );
      }
      expect(warn).toHaveBeenCalledTimes(4);
      expect(String(warn.mock.calls[0]![0])).toMatch(/volatile-lru, not noeviction/);
    });

    it('fails acquire() inside the script under service grants without +time, which ACL DRYRUN cannot see', async () => {
      const { user, runners } = await as(SERVICE_GRANTS);
      for (const [name, runner] of runners) {
        const locks = new ValkeyLockStore(runner, { prefix: 'coordinator:locks:' });
        const key = randomUUID();
        const error = await locks.acquire(key, 'a', 10_000).catch((e: unknown) => e);
        expect(error, name).toBeInstanceOf(Error);
        expect(error, name).not.toBeInstanceOf(ValkeyStoreError);
        expect(String((error as Error).message), name).toMatch(/'time' command/);
        // TIME comes before the first write: nothing is left behind.
        expect(await server.exists(`coordinator:locks:{${hashTag(key)}}`)).toBe(0);
        await expect(locks.checkServer(), name).rejects.toThrow(/grant \+time to the ACL user/);
        await expect(new ValkeyLockStore(runner, { startupCheck: 'strict' }).checkServer()).rejects.toThrow(
          /grant \+time/,
        );

        const idem = new ValkeyIdempotencyStore(runner, {
          prefix: 'coordinator:idem:',
          startupCheck: 'strict',
        });
        await idem.checkServer();
        expect(await idem.acquire(key, 'a', 'fp', 10_000)).toEqual({ state: 'acquired' });
        expect(await idem.release(key, 'a')).toBe(true);
      }
      const dryRun = await server.acl(
        'DRYRUN',
        user,
        'EVALSHA',
        ACQUIRE.sha1,
        '2',
        'coordinator:a',
        'coordinator:b',
        'o',
        '1000',
        '1',
      );
      expect(dryRun).toBe('OK');

      await server.acl('SETUSER', user, '+time');
      for (const [, runner] of runners) {
        const locks = new ValkeyLockStore(runner, { prefix: 'coordinator:locks:', startupCheck: 'strict' });
        await locks.checkServer();
        expect((await locks.acquire(randomUUID(), 'a', 10_000)).acquired).toBe(true);
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns that it could not read the policy without +info, and fails on it under strict', async () => {
      // glide's standalone client reads INFO REPLICATION to connect at all, so only ioredis
      // (without its ready check) can run as a user without +info.
      const user = `nvk-${randomUUID()}`;
      users.push(user);
      await server.acl(
        'SETUSER',
        user,
        'reset',
        'on',
        '>pw',
        '~*',
        '+@read',
        '+@write',
        '+@scripting',
        '+time',
      );
      const client = new Redis({
        ...env.scratch!,
        username: user,
        password: 'pw',
        commandTimeout: 5_000,
        enableReadyCheck: false,
      });
      closers.push(() => client.disconnect());
      const runner = ioredisRunner(client);
      await new ValkeyLockStore(runner).checkServer();
      await expect(
        new ValkeyIdempotencyStore(runner, { startupCheck: 'strict' }).checkServer(),
      ).rejects.toThrow(/could not read maxmemory-policy \(.*info/i);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/Grant \+info/);
    });

    it('refuses an ioredis client with stringNumbers before any call, and runs on its duplicate without it', async () => {
      const parent = new Redis({ ...env.scratch!, commandTimeout: 5_000, stringNumbers: true });
      closers.push(() => parent.disconnect());
      // The scripts' integer replies, as such a client returns them.
      expect(await parent.eval('return {1, 0}', 0)).toEqual(['1', '0']);
      const key = randomUUID();
      expect(() => new ValkeyLockStore(ioredisRunner(parent))).toThrow(/stringNumbers/);
      const inherited = parent.duplicate();
      closers.push(() => inherited.disconnect());
      expect(() => ioredisRunner(inherited)).toThrow(/stringNumbers/);
      expect(await server.exists(`locks:{${hashTag(key)}}`, `idem:${key}`)).toBe(0);

      const client = parent.duplicate({ stringNumbers: false });
      closers.push(() => client.disconnect());
      const runner = ioredisRunner(client);
      const locks = new ValkeyLockStore(runner, { startupCheck: 'strict' });
      await locks.checkServer();
      expect((await locks.acquire(key, 'a', 60_000)).acquired).toBe(true);
      expect(await locks.acquire(key, 'b', 60_000)).toEqual({ acquired: false });
      expect(await locks.renew(key, 'a', 60_000)).toBe(true);
      expect(await locks.release(key, 'a')).toBe(true);
      const idem = new ValkeyIdempotencyStore(runner, { startupCheck: 'strict' });
      expect(await idem.acquire(key, 'a', 'fp', 60_000)).toEqual({ state: 'acquired' });
      expect(await idem.acquire(key, 'b', 'fp', 60_000)).toEqual({ state: 'in-flight', fingerprint: 'fp' });
      expect(await idem.release(key, 'a')).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it('works inside an ACL key pattern, and passes NOPERM through for a key outside it', async () => {
      const { runners } = await as([...SERVICE_GRANTS, '+time']);
      for (const [name, runner] of runners) {
        const key = randomUUID();
        const inside = new ValkeyLockStore(runner, { prefix: 'coordinator:locks:' });
        expect((await inside.acquire(key, 'a', 10_000)).acquired, name).toBe(true);
        expect(await inside.release(key, 'a')).toBe(true);
        const outside = new ValkeyLockStore(runner);
        const error = await outside.acquire(key, 'a', 10_000).catch((e: unknown) => e);
        expect(error, name).not.toBeInstanceOf(ValkeyStoreError);
        expect(String((error as Error).message), name).toMatch(/NOPERM|no permissions/i);
        await expect(new ValkeyIdempotencyStore(runner).acquire(key, 'a', 'fp', 1000)).rejects.toThrow(
          /NOPERM|no permissions/i,
        );
      }
    });

    it('under OOM refuses new locks and records with no partial write, and still renews, releases and completes', async () => {
      const response = { status: 200, headers: {}, body: 'x'.repeat(1_000) };
      for (const [name, runner] of await runnersFor()) {
        const run = randomUUID();
        const locks = new ValkeyLockStore(runner, { prefix: `oom:${run}:`, startupCheck: false });
        const idem = new ValkeyIdempotencyStore(runner, { prefix: `oom:${run}:`, startupCheck: false });
        expect((await locks.acquire('held', 'a', 60_000)).acquired).toBe(true);
        expect((await locks.acquire('control', 'a', 60_000)).acquired).toBe(true);
        expect(await idem.acquire('record', 'a', 'fp', 60_000)).toEqual({ state: 'acquired' });
        expect(await idem.acquire('plain', 'a', 'fp', 60_000)).toEqual({ state: 'acquired' });

        const used = Number(/used_memory:(\d+)/.exec(await server.info('memory'))![1]);
        await server.config('SET', 'maxmemory', String(Math.floor(used / 2)));
        try {
          await expect(locks.acquire('new', 'a', 60_000), name).rejects.toThrow(/OOM/);
          expect(await server.exists(`oom:${run}:{new}`, `oom:${run}:{new}:fence`)).toBe(0);
          expect(await locks.renew('held', 'a', 60_000), name).toBe(true);
          expect(await locks.release('held', 'a'), name).toBe(true);

          await expect(idem.acquire('new', 'a', 'fp', 60_000), name).rejects.toThrow(/OOM/);
          expect(await server.exists(`oom:${run}:new`)).toBe(0);
          expect(await idem.extend('record', 'a', 60_000), name).toBe(true);
          // The handler has run: complete() stores its response (allow-oom) rather than leave the
          // record to expire and a retry to run the handler again.
          expect(await idem.complete('record', 'a', response, 60_000), name).toBe(true);
          expect(await server.hgetall(`oom:${run}:record`)).toEqual({
            state: 'completed',
            fp: 'fp',
            resp: JSON.stringify(response),
          });
          expect(await idem.acquire('record', 'b', 'fp', 60_000), name).toEqual({
            state: 'completed',
            fingerprint: 'fp',
            response,
          });
          // The same script without its flag is refused, and leaves the record in flight.
          const plain = COMPLETE.source.replace(/^#!lua[^\n]*\n/, '');
          await expect(
            server.eval(plain, 1, `oom:${run}:plain`, 'a', JSON.stringify(response), '60000'),
          ).rejects.toThrow(/OOM/);
          expect(await server.hget(`oom:${run}:plain`, 'state')).toBe('in-flight');
          expect(await idem.release('plain', 'a'), name).toBe(true);

          // A #!lua script without allow-oom is refused whole, renew() included.
          await expect(
            server.eval(`#!lua\n${RENEW.source}`, 1, `oom:${run}:{control}`, 'a', '60000'),
          ).rejects.toThrow(/OOM/);
          expect(await locks.renew('control', 'a', 60_000), name).toBe(true);
        } finally {
          await server.config('SET', 'maxmemory', '0');
        }
      }
    });

    describe('a server that accepts connections and never answers', () => {
      let silent: Server;
      const sockets: Socket[] = [];
      beforeAll(async () => {
        silent = createServer((socket) => sockets.push(socket));
        await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
      });
      afterAll(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => silent.close(resolve));
      });

      it('warns after 3 s under warn and fails under strict, while the store itself sets no timeout', async () => {
        const { port } = silent.address() as { port: number };
        const client = new Redis({
          host: '127.0.0.1',
          port,
          enableReadyCheck: false,
          maxRetriesPerRequest: null,
        });
        closers.push(() => client.disconnect());
        const runner = ioredisRunner(client);
        warn.mockClear();
        const started = Date.now();
        const [warned, strict] = await Promise.allSettled([
          new ValkeyLockStore(runner).checkServer(),
          new ValkeyIdempotencyStore(runner, { startupCheck: 'strict' }).checkServer(),
        ]);
        expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
        expect(warned.status).toBe('fulfilled');
        expect(String(warn.mock.calls[0]![0])).toMatch(/did not complete \(no answer within 3000ms\)/);
        expect(strict.status).toBe('rejected');
        expect(String((strict as PromiseRejectedResult).reason)).toMatch(/did not complete/);
      });
    });
  },
);
