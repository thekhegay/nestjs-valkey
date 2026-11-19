# nestjs-valkey

Valkey and Redis stores for [`@nestjs/locks`](https://docs.nestjs.com/reliability/locks) and [`@nestjs/idempotency`](https://docs.nestjs.com/reliability/idempotency).

[![npm version](https://img.shields.io/npm/v/nestjs-valkey?color=e21a62)](https://www.npmjs.com/package/nestjs-valkey)
[![nestjs peer](https://img.shields.io/npm/dependency-version/nestjs-valkey/peer/@nestjs/common)](https://www.npmjs.com/package/nestjs-valkey)
[![ci](https://img.shields.io/github/actions/workflow/status/thekhegay/nestjs-valkey/ci.yml?branch=main&label=ci)](https://github.com/thekhegay/nestjs-valkey/actions/workflows/ci.yml)
[![coverage](https://codecov.io/gh/thekhegay/nestjs-valkey/branch/main/graph/badge.svg)](https://codecov.io/gh/thekhegay/nestjs-valkey)
[![node](https://img.shields.io/node/v/nestjs-valkey)](https://www.npmjs.com/package/nestjs-valkey)
[![license](https://img.shields.io/npm/l/nestjs-valkey)](https://github.com/thekhegay/nestjs-valkey/blob/main/LICENSE)

[Setup](https://github.com/thekhegay/nestjs-valkey/blob/main/docs/setup.md) · [Clients](https://github.com/thekhegay/nestjs-valkey/blob/main/docs/clients.md) · [Cluster](https://github.com/thekhegay/nestjs-valkey/blob/main/docs/cluster.md) · [Fencing tokens](https://github.com/thekhegay/nestjs-valkey/blob/main/docs/fencing-tokens.md) · [Server](https://github.com/thekhegay/nestjs-valkey/blob/main/docs/server.md) · [Failures](https://github.com/thekhegay/nestjs-valkey/blob/main/docs/failures.md) · [Migration](https://github.com/thekhegay/nestjs-valkey/blob/main/docs/migration.md) · [Changelog](https://github.com/thekhegay/nestjs-valkey/blob/main/CHANGELOG.md)

Every method is one Lua script. The stores work on a standalone server and in a cluster through [valkey-glide](https://github.com/valkey-io/valkey-glide), ioredis or iovalkey, and behind Sentinel through ioredis. Both pass the official contract suites (`lockStoreContract()`, `idempotencyStoreContract()`) on every one of those.

## Install

```sh
npm i nestjs-valkey @nestjs/locks @nestjs/idempotency
npm i @valkey/valkey-glide    # or ioredis / iovalkey, which you already have
```

Take only the official package you use: both are optional peers, and so is glide. The package is ESM-only, like the official ones. A CommonJS application, Jest and TypeScript need a setting or two, listed in [Setup](https://github.com/thekhegay/nestjs-valkey/blob/main/docs/setup.md). Servers: Valkey 7.2+ or Redis 7.0+.

## Register the stores

`valkeyLockStore()` and `valkeyIdempotencyStore()` return providers that build the store, register it with `LocksStorage` / `IdempotencyStorage` before the registry locks, and run a startup check. The stores never open or close a connection: you hand them a runner over your client, and close the client in your module's `onApplicationShutdown()`.

With glide (a cluster here; `GlideClient`, or either typed as their `BaseClient`, works the same):

```ts
import { Module } from '@nestjs/common';
import { IdempotencyModule } from '@nestjs/idempotency';
import { LocksModule } from '@nestjs/locks';
import type { GlideClusterClient } from '@valkey/valkey-glide';
import { glideRunner } from 'nestjs-valkey/glide';
import { valkeyIdempotencyStore } from 'nestjs-valkey/idempotency';
import { valkeyLockStore } from 'nestjs-valkey/locks';
import { VALKEY, ValkeyModule } from './valkey.module';

@Module({
  imports: [ValkeyModule, LocksModule.forRoot(), IdempotencyModule.forRoot()],
  providers: [
    valkeyLockStore({
      inject: [VALKEY],
      useFactory: (client: GlideClusterClient) => ({ runner: glideRunner(client), prefix: 'billing:locks:' }),
    }),
    valkeyIdempotencyStore({
      inject: [VALKEY],
      useFactory: (client: GlideClusterClient) => ({ runner: glideRunner(client), prefix: 'billing:idem:' }),
    }),
  ],
})
export class AppModule {}
```

With ioredis (or iovalkey), give the stores a connection of their own with a `commandTimeout`:

```ts
import { Redis } from 'ioredis';
import { ioredisRunner } from 'nestjs-valkey/ioredis';

valkeyLockStore({
  inject: [STORE_REDIS], // useFactory: () => new Redis(process.env.REDIS_URL!, { commandTimeout: 2000 })
  useFactory: (redis: Redis) => ({ runner: ioredisRunner(redis), prefix: 'billing:locks:' }),
});
```

Why that timeout matters, and the glide settings to check, are in [Clients](https://github.com/thekhegay/nestjs-valkey/blob/main/docs/clients.md).

## Server

- `maxmemory-policy noeviction`: an evicted lock is taken by another instance while its holder still runs.
- An ACL user that may run `TIME` as well as the scripts.
- Clocks on NTP.

The full list, and what the startup check reports, are in [Server](https://github.com/thekhegay/nestjs-valkey/blob/main/docs/server.md).

## Not included

- A connection module, a health indicator or a logger setup for glide; retries, timeouts or a circuit breaker (the client's and the official packages' job).
- Multi-key locks, Redlock across independent primaries, waking waiters through pub/sub: `@nestjs/locks`' level, or the application's.
- Valkey Functions, hash-field expiry, `SET IFEQ` / `DELIFEQ`, `WAIT`.
- A `/testing` entry point: run the official contract suites, as this package does.
- A CommonJS build, and stores for other contracts (throttler, cache, sessions).

## Contributing

See [CONTRIBUTING.md](https://github.com/thekhegay/nestjs-valkey/blob/main/CONTRIBUTING.md).

## License

[MIT](https://github.com/thekhegay/nestjs-valkey/blob/main/LICENSE)
