# Failures

## Errors

The stores retry nothing (but resend a script on `NOSCRIPT`), set no timers and never wrap a client error: timeouts, `NOPERM`, `OOM`, `READONLY` reach you as the client threw them. Bad arguments (a duration that is not a whole number of milliseconds, a key with a lone surrogate, a prefix with a brace) throw before any call. A reply the store cannot read, such as an idempotency record it did not write, throws `ValkeyStoreError` from `nestjs-valkey`; the message never names a key, an owner or a stored response. `acquire()` that gets such a reply releases the lock first (if it holds it), best-effort. So does a lock `acquire()` that fails on the client (its timeout, a dropped connection): the script may still run on the server, and `@nestjs/locks` gives back no lock whose `acquire()` rejected, so the store sends the owner-checked release behind it, without waiting for it, and rethrows the error. A fence key holding a string that is not a token the store wrote, or one at 2^53 - 2 or above, fails `acquire()` with the script's own error (`locks.acquire: the fence holds no token this store can extend`) before anything is written; a key of another type where the store expects its own (a hash or a list under a fence, a string under an idempotency record) fails the call with the server's `WRONGTYPE`, also before anything is written. Out of memory, only `acquire()` fails: see below.

An ioredis error from the server carries the command it answered (`error.command.args`): the keys, the owner and, for `complete()`, the stored response, which a logger that prints the error object writes out, as Nest's does for `@nestjs/idempotency`'s store failures. `@nestjs/idempotency`'s `encryption` keeps the response sealed there too. glide's errors carry no arguments.

## Out of memory

Under `noeviction`, a server at `maxmemory` refuses the writes that grow memory. The stores refuse what would start something new and finish what has started:

- `acquire()`, in both stores, fails with `OOM` before anything is written.
- `renew()`, `release()` and `extend()` run: they grow nothing, and their scripts carry no `#!lua` flags, which would have the server refuse them whole.
- `complete()` stores the response past `maxmemory`: its script, alone, carries `#!lua flags=allow-oom`. The handler has already run; refused, the record would stay in flight until its lock expired, and `@nestjs/idempotency` would run the handler again on the retry, side effect included. Since `acquire()` stays refused, only requests already in flight complete that way, one record each: leave headroom above `maxmemory` (and below the memory limit of the server's container) for as many responses as you serve at once.
