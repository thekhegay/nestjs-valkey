import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Inject,
  Injectable,
  Logger,
  Module,
  Post,
  type INestApplicationContext,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IdempotencyModule, IdempotencyStorage, Idempotent } from '@nestjs/idempotency';
import { Locks, LocksModule, LocksStorage, OnOneInstance } from '@nestjs/locks';
import { GlideClient } from '@valkey/valkey-glide';
import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { glideRunner } from '../../src/glide/index.js';
import { ValkeyIdempotencyStore, valkeyIdempotencyStore } from '../../src/idempotency/index.js';
import { ioredisRunner } from '../../src/ioredis/index.js';
import { ValkeyLockStore, valkeyLockStore } from '../../src/locks/index.js';
import { env, missing } from '../support/servers.js';
import { sleep } from '../support/sleep.js';

const GLIDE = Symbol('GLIDE');
const REDIS = Symbol('REDIS');

/** The application's own clients, closed in onApplicationShutdown(), after the packages are done. */
@Module({
  providers: [
    {
      provide: GLIDE,
      useFactory: () => GlideClient.createClient({ addresses: [env.standalone!], requestTimeout: 5_000 }),
    },
    { provide: REDIS, useFactory: () => new Redis({ ...env.standalone!, commandTimeout: 5_000 }) },
  ],
  exports: [GLIDE, REDIS],
})
class ValkeyModule implements OnApplicationShutdown {
  constructor(
    @Inject(GLIDE) private readonly glide: GlideClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown() {
    this.glide.close();
    await this.redis.quit();
  }
}

const stores = (prefix: string) => [
  valkeyLockStore({
    inject: [GLIDE],
    useFactory: (client: GlideClient) => ({ runner: glideRunner(client), prefix: `${prefix}:locks:` }),
  }),
  valkeyIdempotencyStore({
    inject: [REDIS],
    useFactory: (client: Redis) => ({ runner: ioredisRunner(client), prefix: `${prefix}:idem:` }),
  }),
];

const skip = missing('VALKEY_URL');

describe(`Nest applications on Valkey${skip ? ` (skipped: ${skip})` : ''}`, { skip: skip !== false }, () => {
  const apps: INestApplicationContext[] = [];
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('start in production with both stores registered, checked, and serving locks', async () => {
    const check = vi.spyOn(ValkeyLockStore.prototype, 'checkServer');
    @Module({
      imports: [ValkeyModule, LocksModule.forRoot(), IdempotencyModule.forRoot()],
      providers: stores('app'),
    })
    class AppModule {}
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
    apps.push(app);
    expect(app.get(LocksStorage).source).toBeInstanceOf(ValkeyLockStore);
    expect(app.get(IdempotencyStorage).source).toBeInstanceOf(ValkeyIdempotencyStore);
    expect(check).toHaveBeenCalledTimes(1);
    const tokens = await Promise.all(
      [1, 2, 3].map(() =>
        app.get(Locks).withLock(`app:${randomUUID()}`, (lock) => lock.fencingToken, { ttl: '10s' }),
      ),
    );
    for (const token of tokens) expect(token).toBeGreaterThan(2 ** 50);
  });

  it('run an @OnOneInstance() job on exactly one of three instances, and hand it over on shutdown', async () => {
    const key = `nightly-${randomUUID()}`;
    @Injectable()
    class Jobs {
      runs = 0;

      @OnOneInstance({ key, ttl: '5s' })
      async tick() {
        this.runs++;
        return 'ran';
      }
    }
    @Module({
      imports: [ValkeyModule, LocksModule.forRoot()],
      providers: [Jobs, ...stores('jobs').slice(0, 1)],
    })
    class AppModule {}

    for (let i = 0; i < 3; i++) {
      apps.push(
        await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false }),
      );
    }
    const jobs = apps.map((app) => app.get(Jobs));
    for (let round = 0; round < 5; round++) {
      const results = await Promise.all(jobs.map((job) => job.tick()));
      expect(results.filter((r) => r === 'ran')).toHaveLength(1);
    }
    const owner = jobs.findIndex((job) => job.runs > 0);
    expect(jobs.map((job) => job.runs)).toEqual(jobs.map((_, i) => (i === owner ? 5 : 0)));

    // The lease goes back on shutdown, after the second the package keeps for a run just started.
    await apps[owner]!.close();
    apps.splice(owner, 1);
    const rest = jobs.filter((_, i) => i !== owner);
    await sleep(1_200);
    const results = await Promise.all(rest.map((job) => job.tick()));
    expect(results.filter((r) => r === 'ran')).toHaveLength(1);
  });

  it('replay an @Idempotent() route over HTTP from the store instead of running it again', async () => {
    @Controller()
    class ChargesController {
      calls = 0;

      @Post('charges')
      @Idempotent()
      charge(@Body() body: { amount: number }) {
        this.calls++;
        return { id: `ch_${this.calls}`, amount: body.amount };
      }
    }
    @Module({
      imports: [ValkeyModule, LocksModule.forRoot(), IdempotencyModule.forRoot()],
      controllers: [ChargesController],
      providers: stores('http'),
    })
    class AppModule {}
    const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    apps.push(app);
    await app.listen(0, '127.0.0.1');
    const url = `${await app.getUrl()}/charges`;
    const charge = (key: string) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ amount: 42 }),
      }).then(async (response) => ({ status: response.status, body: await response.json() }));

    const key = randomUUID();
    const first = await charge(key);
    const retry = await charge(key);
    expect(first).toEqual({ status: 201, body: { id: 'ch_1', amount: 42 } });
    expect(retry).toEqual(first);
    expect(app.get(ChargesController).calls).toBe(1);
    expect((await charge(randomUUID())).body).toEqual({ id: 'ch_2', amount: 42 });

    const redis = new Redis({ ...env.standalone!, commandTimeout: 5_000 });
    try {
      const records = await redis.keys(`http:idem:*${key}*`);
      expect(records).toHaveLength(1);
      expect(await redis.hget(records[0]!, 'state')).toBe('completed');
    } finally {
      await redis.quit();
    }
  });
});
