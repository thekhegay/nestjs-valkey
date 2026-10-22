# nestjs-valkey

Valkey and Redis stores for [`@nestjs/locks`](https://docs.nestjs.com/reliability/locks) and
[`@nestjs/idempotency`](https://docs.nestjs.com/reliability/idempotency). Every method is one Lua script; the
stores work on a standalone server and in a cluster through [valkey-glide](https://github.com/valkey-io/valkey-glide),
ioredis or iovalkey, and behind Sentinel through ioredis. Both pass the official contract suites
(`lockStoreContract()`, `idempotencyStoreContract()`) on every one of those.

## Install

```sh
npm i nestjs-valkey @nestjs/locks @nestjs/idempotency
npm i @valkey/valkey-glide    # or ioredis / iovalkey, which you already have
```

Take only the official package you use: both are optional peers, and so is glide. The package is ESM-only, like
the official ones, and needs the same Node (20.19 or later). A CommonJS application loads it through
`require()` of ES modules, as it loads `@nestjs/locks`; Node 22.12 prints one `ExperimentalWarning` for that at
startup, whichever ES module comes first, and 20.19 and 22.13+ only under `--trace-require-module`. Servers:
Valkey 7.2+ or Redis 7.0+.

## Register the stores

`valkeyLockStore()` and `valkeyIdempotencyStore()` return providers that build the store, register it with
`LocksStorage` / `IdempotencyStorage` before the registry locks, and run a startup check. The stores never open
or close a connection: you hand them a runner over your client, and close the client in your module's
`onApplicationShutdown()`.

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
  inject: [STORE_REDIS], // useFactory: () => new Redis(process.env.REDIS_URL, { commandTimeout: 2000 })
  useFactory: (redis: Redis) => ({ runner: ioredisRunner(redis), prefix: 'billing:locks:' }),
});
```

`@nestjs/locks` bounds no store call, so `acquire()` and `release()` against a server that stops answering wait as
long as the client does; `ioredisRunner()` warns when the client has no `commandTimeout`. Keep that connection
apart from one that runs `XREADGROUP BLOCK` or `BLPOP`: a `commandTimeout` applies to blocking commands too
(`redis.duplicate({ commandTimeout: 2000 })` makes one). `ioredisRunner()` refuses a client with `stringNumbers`,
whose integer replies the stores cannot read, and `duplicate()` copies that option: pass `stringNumbers: false`
there if the client you start from has it. For glide, set `requestTimeout` above the slowest healthy script call
and below `@nestjs/idempotency`'s `storeTimeout` (10 s): the default, 250 ms, is shorter than a failover.

In a cluster, glide logs each `NOSCRIPT` (a replica promoted by a failover has no scripts cached) and each `MOVED`
(a slot that moved) it recovers from as a `WARN` line on stdout, while the store call succeeds:

```text
2026-10-14T16:54:07.841326Z  WARN logger_core: cluster - Received request error An error was signalled by the server: - Moved: 8125 127.0.0.1:17105 on node "127.0.0.1:17102".
```

To quiet them, set glide's own logger once at startup: `Logger.setLoggerConfig('error')`, with `Logger` from
`@valkey/valkey-glide` (`'off'` silences glide altogether).

Outside Nest, or as a class in your own code:

```ts
const store = new ValkeyLockStore(glideRunner(client), { prefix: 'billing:locks:' });
await store.checkServer();

@Injectable()
export class AppLockStore extends ValkeyLockStore {
  constructor(@Inject(REDIS) redis: Redis, storage: LocksStorage) {
    super(ioredisRunner(redis), { prefix: 'billing:locks:' });
    storage.registerSource(this);
  }
}
```

Options: `prefix` (default `locks:` and `idem:`; give every application on a shared server its own, inside its
ACL key pattern), `fenceRetention` for the lock store (ms, default a minute, see below) and `startupCheck`.

## Cluster

A lock lives at `<prefix>{<tag>}`, and the key's last fencing token at `<prefix>{<tag>}:fence`. The tag is the
key with `%`, `{` and `}` escaped, so both keys always hash to one slot, whatever braces the key holds, and locks
spread over the shards. (The documentation's Redis lock store increments one global counter next to the lock,
which a cluster refuses with `CROSSSLOT`.) An idempotency record is one key, the documentation's layout. A
prefix must not contain a brace, and neither must ioredis's `keyPrefix`, which applies on top of it. Every
script runs on the primary, whatever the client reads from.

## Fencing tokens

A token is the server's clock in microseconds (about 1.79 × 10^15 in 2026), or one more than the key's last
token when that is ahead, so tokens grow per key across releases, expiries and clock steps while the fence
lives, and after it expires across a clock that reads less than `fenceRetention` behind. They are safe integers,
but too large for a 32-bit column: store them as `bigint`. They are comparable per key only, as the contract
asks, and they do not start at 1.

The fence matters only for a clock that steps back. While it lives, tokens grow whatever the clock does; once it
has expired, a server clock (or, after a failover, the new primary's) that steps back by more than
`fenceRetention` past the last token hands out a smaller one. The default, a minute, is many times what a clock under NTP steps back (a
leap second, a correction of a second or so). A fence lost whole in an asynchronous failover is a different
case that no retention covers. Raise it where a clock can be minutes off: no NTP, a hardware clock kept in local time, VMs
restored from a snapshot.

Every key acquired within `fenceRetention` keeps its fence, and `noeviction` never frees one early. Measured as
`used_memory` growth over 100 000 fences named `locks:{<uuid>}:fence` (50 bytes): 108 bytes each on Valkey 8.1,
124 on Valkey 9.1, 141 on Valkey 7.2 and Redis 7.0 (`MEMORY USAGE` reports 80 to 96: it leaves out the key's
share of the keyspace and expiry tables); a longer prefix or key adds its length. An application that locks 1 000 distinct keys a
second holds 60 000 fences at the default, 6.5 to 8.5 MB, and 3.6 million at an hour, 390 to 510 MB. Locks on a
few fixed names (`@Locked('jobs:export')`) cost a few kilobytes either way.

## Server requirements

- **`maxmemory-policy noeviction`.** An evicted lock is taken by another instance while its holder still runs;
  an evicted idempotency record runs the handler again. A `volatile-*` policy evicts these keys too, since all of
  them expire.
- **ACL.** Keys `~<prefix>*`. Commands: glide sends `evalsha` and `script|load`, ioredis `evalsha` and `eval`
  (`+@scripting` covers both). Inside the scripts: `exists get set pexpire del hset hmget hget hdel`, which
  `+@read +@write` cover, plus **`time`**, which only `@fast` holds: the lock store draws tokens from it. A user
  without `+time` fails every `acquire()` inside the script, and `ACL DRYRUN` answers `OK` all the same, so the
  startup check refuses to start. `+info` lets the check read the eviction policy (glide's standalone client
  needs it to connect anyway).
- Clocks on NTP, which lock expiry relies on already. Persistence (AOF `everysec`) where losing idempotency
  records on a restart is not acceptable; tokens do not need it.

## Startup check

The stores' `onModuleInit()` runs one keyless script through the runner and waits at most 3 seconds. In a
cluster it reads one primary, never a replica: `glideRunner()` sends it to the primary that serves slot 0,
`ioredisRunner()` to any primary. Give every node the same ACL users and `maxmemory-policy`, since the check
reads only that one:

| Finding                                  | `'warn'` (default) | `'strict'`    |
| ---------------------------------------- | ------------------ | ------------- |
| the user may not run `TIME` (locks only) | startup fails      | startup fails |
| `maxmemory-policy` is not `noeviction`   | warning            | startup fails |
| `INFO` refused, policy unreadable        | warning            | startup fails |
| no answer within 3 s, or the call fails  | warning            | startup fails |

`startupCheck: false` skips it.

## Errors

The stores retry nothing (but resend a script on `NOSCRIPT`), set no timers and never wrap a client error:
timeouts, `NOPERM`, `OOM`, `READONLY` reach you as the client threw them. Bad arguments (a duration that is not a
whole number of milliseconds, a key with a lone surrogate, a prefix with a brace) throw before any call. A reply
the store cannot read, such as an idempotency record it did not write, throws `ValkeyStoreError` from
`nestjs-valkey`; the message never names a key, an owner or a stored response. `acquire()` that gets such a reply
releases the lock first (if it holds it), best-effort. So does a lock `acquire()` that fails on the client (its
timeout, a dropped connection): the script may still run on the server, and `@nestjs/locks` gives back no lock
whose `acquire()` rejected, so the store sends the owner-checked release behind it, without waiting for it, and
rethrows the error. A fence key that holds anything but a token the store wrote, or one at 2^53 - 2 or above,
fails `acquire()` with the script's own error (`locks.acquire: the fence holds no token this store can extend`)
before anything is written. Out of memory, only `acquire()` fails: see below.

## Out of memory

Under `noeviction`, a server at `maxmemory` refuses the writes that grow memory. The stores refuse what would start
something new and finish what has started:

- `acquire()`, in both stores, fails with `OOM` before anything is written.
- `renew()`, `release()` and `extend()` run: they grow nothing, and their scripts carry no `#!lua` flags, which
  would have the server refuse them whole.
- `complete()` stores the response past `maxmemory`: its script, alone, carries `#!lua flags=allow-oom`. The
  handler has already run; refused, the record would stay in flight until its lock expired, and
  `@nestjs/idempotency` would run the handler again on the retry, side effect included. Since `acquire()` stays
  refused, only requests already in flight complete that way, one record each: leave headroom above `maxmemory`
  (and below the memory limit of the server's container) for as many responses as you serve at once.

## Moving from the documentation's recipes

- **Idempotency:** the same hash at `idem:<key>`, with the same fields and scripts (`complete()`'s has one line
  more, its `allow-oom` flag), so instances on the recipe and on this store read each other's records; switch at
  any time, during a rolling deploy too.
- **Locks:** the keys differ (`locks:key:<key>` and `locks:fencing-token` there), so old and new instances do not
  exclude each other. Stop every instance, then start them on this store. Its tokens are far above any value the
  recipe's counter reached, so resources fenced with old tokens accept the new ones.

## Another client

A runner is one method, so any client fits:

```ts
import type { ScriptRunner } from 'nestjs-valkey';

// node-redis: a sketch, not covered by this package's tests.
const runner: ScriptRunner = {
  async run(script, keys, args) {
    const options = { keys: [...keys], arguments: [...args] };
    try {
      return await client.evalSha(script.sha1, options);
    } catch (error) {
      if (!(error instanceof Error) || !/^NOSCRIPT\b/.test(error.message)) throw error;
      return client.eval(script.source, options);
    }
  },
};
```

Send every key as a script key, so a cluster client routes by them, and resend the source on `NOSCRIPT` only:
a call that failed otherwise may have run.

## Not included

- A connection module, a health indicator or a logger setup for glide; retries, timeouts or a circuit breaker
  (the client's and the official packages' job).
- Multi-key locks, Redlock across independent primaries, waking waiters through pub/sub: `@nestjs/locks`'
  level, or the application's.
- Valkey Functions, hash-field expiry, `SET IFEQ` / `DELIFEQ`, `WAIT`.
- A `/testing` entry point: run the official contract suites, as this package does.
- A CommonJS build, and stores for other contracts (throttler, cache, sessions).

## Development

```sh
pnpm install
pnpm servers:up          # Valkey standalone, a 3-primary cluster, Sentinel (Docker, ports on 127.0.0.1)
pnpm test                # unit tests, no server
pnpm test:servers        # contracts, cluster, tokens, NOSCRIPT, ACL, OOM, Nest apps
pnpm test:consumers      # packs the package into a Nest 11 CommonJS and a Nest 12 ESM application
pnpm test:chaos          # CLUSTER FAILOVER of each shard under load: tokens grow, no call fails (reshuffles the cluster)
pnpm servers:down
```

`docker compose -f docker/compose.yml --profile redis up -d` adds Redis 7.0; set `REDIS_URL=redis://127.0.0.1:16380`
to run the contracts on it. `VALKEY_IMAGE=valkey/valkey:7.2-alpine` picks another Valkey (CI runs 7.2, 8.1 and 9.1). `CONSUMER_NODES="22.12=/path/to/node,26=/path/to/node"` runs the consumer
applications on other Node versions.

## License

[MIT](LICENSE)
