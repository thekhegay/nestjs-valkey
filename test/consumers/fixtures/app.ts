// The application both consumer fixtures build: a Nest 11 CommonJS one (TypeScript 5.9, node10
// resolution) and a Nest 12 ESM one (TypeScript 6.0, NodeNext). It registers both stores the
// way the README says, starts in production, takes a lock and serves an idempotent route twice.
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Body, Controller, Inject, Module, Post, type OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IdempotencyModule, IdempotencyStorage, Idempotent } from '@nestjs/idempotency';
import { Locks, LocksModule, LocksStorage } from '@nestjs/locks';
import { GlideClient } from '@valkey/valkey-glide';
import { Redis } from 'ioredis';
import { ValkeyStoreError } from 'nestjs-valkey';
import { glideRunner } from 'nestjs-valkey/glide';
import { ValkeyIdempotencyStore, valkeyIdempotencyStore } from 'nestjs-valkey/idempotency';
import { ioredisRunner } from 'nestjs-valkey/ioredis';
import { ValkeyLockStore, valkeyLockStore } from 'nestjs-valkey/locks';

const GLIDE = Symbol('GLIDE');
const REDIS = Symbol('REDIS');
const url = new URL(process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379');
const address = { host: url.hostname, port: Number(url.port || 6379) };
/** Which client the lock store gets; the idempotency store gets the other one. */
const locksOnGlide = process.env.LOCKS_CLIENT !== 'ioredis';

@Module({
  providers: [
    {
      provide: GLIDE,
      useFactory: () => GlideClient.createClient({ addresses: [address], requestTimeout: 5000 }),
    },
    { provide: REDIS, useFactory: () => new Redis({ ...address, commandTimeout: 2000 }) },
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
  providers: [
    valkeyLockStore({
      inject: [GLIDE, REDIS],
      useFactory: (glide: GlideClient, redis: Redis) => ({
        runner: locksOnGlide ? glideRunner(glide) : ioredisRunner(redis),
        prefix: 'consumer:locks:',
      }),
    }),
    valkeyIdempotencyStore({
      inject: [GLIDE, REDIS],
      useFactory: (glide: GlideClient, redis: Redis) => ({
        runner: locksOnGlide ? ioredisRunner(redis) : glideRunner(glide),
        prefix: 'consumer:idem:',
      }),
    }),
  ],
})
class AppModule {}

async function main() {
  const app = await NestFactory.create(AppModule, { abortOnError: false });
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');
  const charges = `${await app.getUrl()}/charges`;
  const key = `consumer-${Date.now()}-${Math.random()}`;
  const charge = () =>
    fetch(charges, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ amount: 42 }),
    }).then(async (response) => ({ status: response.status, body: await response.json() }));

  const first = await charge();
  const retry = await charge();
  const token = await app.get(Locks).withLock(`consumer:${key}`, (lock) => lock.fencingToken);
  const result = {
    nest: JSON.parse(readFileSync('node_modules/@nestjs/core/package.json', 'utf8')).version as string,
    node: process.versions.node,
    lockSource: app.get(LocksStorage).source.constructor.name,
    idempotencySource: app.get(IdempotencyStorage).source.constructor.name,
    sameLockStore: app.get(LocksStorage).source === app.get(ValkeyLockStore),
    sameIdempotencyStore: app.get(IdempotencyStorage).source === app.get(ValkeyIdempotencyStore),
    storeError: new ValkeyStoreError('test', 'x') instanceof Error,
    token,
    first,
    retry,
    calls: app.get(ChargesController).calls,
  };
  await app.close();
  console.log(`RESULT ${JSON.stringify(result)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
