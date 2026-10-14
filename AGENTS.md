# AGENTS.md

Guidance for anyone, human or not, changing **nestjs-valkey**: Valkey and Redis
stores for the Nest team's `@nestjs/locks` and `@nestjs/idempotency`. What the
package does and how to use it is in [README.md](README.md); this file is about
how to work in the repository and why it is shaped the way it is.

## Layout

- `src/locks`, `src/idempotency`: the stores, their Lua scripts and the
  provider functions (`valkeyLockStore()`, `valkeyIdempotencyStore()`) that
  build a store and register it with `LocksStorage` / `IdempotencyStorage`.
- `src/glide`, `src/ioredis`: the two runners. A runner is one method,
  `run(script, keys, args)`; the stores know nothing else about the client.
- `src/internal`: key and hash-tag handling, reply normalisation, script
  caching and NOSCRIPT recovery, the startup server check.
- `test/unit` needs nothing. `test/server`, `test/cluster`, `test/behaviour` and
  `test/consumers` need the Docker stack (`pnpm servers:up`); `test/chaos` runs
  cluster failovers under load and is opt-in (`pnpm test:chaos`, nightly in CI).

Every subpath export imports only its own peer: `nestjs-valkey/locks` must not
pull in `@nestjs/idempotency`, and nothing outside `src/glide` imports glide.
All three peers are optional for that reason.

## Invariants

- **One Lua script per store method.** Two round trips can be interleaved by
  another client; the contract suites run with `concurrent: true` to catch it.
- **One slot per script.** A lock lives in `<prefix>{<tag>}` and
  `<prefix>{<tag>}:fence`; `<tag>` is the lock key with `%`, `{` and `}`
  escaped, so both keys hash to the same slot whatever the key contains. The
  docs' example store keeps a global fencing counter, which a cluster refuses
  with `CROSSSLOT`; the contract only asks for tokens that grow per key.
- **Fencing tokens never repeat or go backwards for a key** while its `:fence`
  key exists: the token is `max(server TIME in µs, last token + 1)`, and the
  fence is kept for `fenceRetention` after the lock is gone. Losing the fence
  key (eviction, a lost write in a failover) is the one way back, which is why
  the startup check warns when `maxmemory-policy` is not `noeviction`.
- **Only the owner token releases or extends a lock.** Every script that
  touches an existing lock compares the stored owner first.
- **Durations are milliseconds end to end** (`PX`, `PEXPIRE`), never seconds.
- **Scripts carry no `#!lua` shebang**, except where a flag is needed and
  documented at the script: under `noeviction` OOM a shebang script is refused
  whole, while a plain `EVAL` only fails at its first memory-growing write.
- **The stores never own the connection.** No connect, close, `SELECT` or config
  change; the application opens the client and closes it on shutdown.
- **The idempotency data layout matches the docs' recipe** (`hash` with
  `state`, `fp`, `owner`, `resp`), so moving between the recipe and the package
  needs no migration. Keep it that way.

## Packaging

ESM-only with `.d.ts`, like the official packages, and the same Node floor
(`engines`). CommonJS Nest 11 applications load it through `require()` of ES
modules; `test/consumers` proves that on every Node in the CI matrix. Peers:
`@nestjs/common` ^11 || ^12 and the two official packages within their 0.0.x
line; `ioredis` is not a peer at all, the runner is structural.

## Commits, pull requests and releases

- Conventional commits, lowercase subject, a single line, no body. The pull
  request title is checked on CI. No AI or assistant attribution anywhere: no
  `Co-Authored-By` trailers, no "generated with" lines, in commits, code or
  docs.
- `main` is protected: changes land through pull requests, rebase-merged, with
  the CI checks green.
- Releases: run the **Release PR** workflow from the Actions tab with the bump.
  It writes the CHANGELOG section with conventional-changelog and opens
  `chore(release): vX.Y.Z` with labels. Merging it runs `release.yml`, which
  refuses a changelog that misses a commit merged after the cut, stages the
  version on npm with provenance (`npm stage publish`), and tags it. The
  version goes live once the maintainer approves the staged version with 2FA.
  Never bump the version or edit CHANGELOG.md by hand.
