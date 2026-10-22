# Contributing

## Before a change

Read [AGENTS.md](AGENTS.md). It holds the rules the stores are built on and why,
and a change that contradicts one needs to argue with the reason rather than
ignore it. Three of them decide most reviews:

- **Every store method is one Lua script.** A method that needs two round trips
  can be interleaved with another client between them.
- **All keys of a script share one cluster slot.** Lock keys carry the lock key
  as a hash tag; a script that touches two tags breaks in a cluster with
  `CROSSSLOT`, which is exactly where the docs' example store fails.
- **A store never owns a connection.** It runs scripts through the runner it is
  given and never opens, closes or reconfigures the client.

## Working on it

```sh
pnpm install
pnpm test             # unit suite, no server needed
pnpm servers:up       # Valkey standalone, a 3-primary cluster and Sentinel in Docker
pnpm test:servers     # both official contract suites and the behaviour tests
pnpm test:consumers   # Nest 11 CommonJS and Nest 12 ESM apps on the packed package
pnpm servers:down
pnpm lint
pnpm check:package    # publint, attw and the tarball contents
```

To run the server suite against Redis as well, start it with
`docker compose -f docker/compose.yml --profile redis up -d --wait` (Redis on 16380) and set `REDIS_URL=redis://127.0.0.1:16380`. A change to a script needs
a test that fails without it on a real server; a green test that would stay
green with the fix removed proves nothing.

## Commits and pull requests

Conventional commits, lowercase subject, one line. The pull request title is
checked by the same rule. Releases are cut from the Actions tab by the Release
PR workflow, never by hand.
