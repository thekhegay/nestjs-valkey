# Clients

## ioredis and iovalkey

Without a `commandTimeout`, a call against a server that stops answering stays pending in the client until the connection closes. `@nestjs/locks` 0.0.3 waits for it that long; from 0.0.4 it stops waiting after its `storeTimeout`, as `@nestjs/idempotency` does (10 s by default in both), but the command stays queued in the client, as does every later one. `ioredisRunner()` warns when the client has no `commandTimeout`. Keep that connection apart from one that runs `XREADGROUP BLOCK` or `BLPOP`: a `commandTimeout` applies to blocking commands too (`redis.duplicate({ commandTimeout: 2000 })` makes one). `ioredisRunner()` refuses a client with `stringNumbers`, whose integer replies the stores cannot read, and `duplicate()` copies that option: pass `stringNumbers: false` there if the client you start from has it. A client with `enableOfflineQueue: false` refuses commands until it has connected, and the startup check runs as the stores are built: have the factory hand over a connected client (`lazyConnect: true`, then `await redis.connect()`), or the check fails under `'strict'` and verifies nothing under `'warn'`.

## glide

For glide, set `requestTimeout` above the slowest healthy script call and below the official packages' `storeTimeout` (10 s): the default, 250 ms, is shorter than a failover. glide also refuses calls past its `inflightRequestsLimit` (1000 by default) with `Reached maximum inflight requests`, and counts a script call twice against it: set it to at least twice the store calls a client runs at once, or give the stores a client of their own. A refused `complete()` leaves its record in flight until `lockTtl`, and the retry then runs the handler again.

In a cluster, glide logs each `NOSCRIPT` (a replica promoted by a failover has no scripts cached) and each `MOVED` (a slot that moved) it recovers from as a `WARN` line on stdout, while the store call succeeds:

```text
2026-10-14T16:54:07.841326Z  WARN logger_core: cluster - Received request error An error was signalled by the server: - Moved: 8125 127.0.0.1:17105 on node "127.0.0.1:17102".
```

To quiet them, set glide's own logger once at startup: `Logger.setLoggerConfig('error')`, with `Logger` from `@valkey/valkey-glide` (`'off'` silences glide altogether).

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

Send every key as a script key, so a cluster client routes by them, and resend the source on `NOSCRIPT` only: a call that failed otherwise may have run.
