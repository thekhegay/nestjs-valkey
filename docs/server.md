# Server

## Requirements

- **`maxmemory-policy noeviction`.** An evicted lock is taken by another instance while its holder still runs; an evicted idempotency record runs the handler again. A `volatile-*` policy evicts these keys too, since all of them expire.
- **ACL.** Keys `~<prefix>*`. Commands: glide sends `evalsha` and `script|load`, ioredis `evalsha` and `eval` (`+@scripting` covers both). Inside the scripts: `exists get set pexpire del hset hmget hget hdel`, which `+@read +@write` cover, plus **`time`**, which only `@fast` holds: the lock store draws tokens from it. A user without `+time` fails every `acquire()` inside the script, and `ACL DRYRUN` answers `OK` all the same, so the startup check refuses to start. `+info` lets the check read the eviction policy and the server's role (glide's standalone client needs it to connect anyway). In a cluster the clients need a few more to find the slots: `+ping +cluster|slots` for glide, `+cluster|slots +cluster|info` for an ioredis `Cluster`.
- Clocks on NTP, which lock expiry relies on already. Persistence (AOF `everysec`) where losing idempotency records on a restart is not acceptable; tokens do not need it.

## Startup check

The stores' `onModuleInit()` runs one keyless script through the runner and waits at most 3 seconds. In a cluster it reads one primary, never a replica: `glideRunner()` sends it to the primary that serves slot 0, `ioredisRunner()` to any primary. Give every node the same ACL users and `maxmemory-policy`, since the check reads only that one:

| Finding                                  | `'warn'` (default) | `'strict'`    |
| ---------------------------------------- | ------------------ | ------------- |
| the user may not run `TIME` (locks only) | startup fails      | startup fails |
| the server is a replica (`role:slave`)   | warning            | startup fails |
| `maxmemory-policy` is not `noeviction`   | warning            | startup fails |
| `INFO` refused, policy unreadable        | warning            | startup fails |
| no answer within 3 s, or the call fails  | warning            | startup fails |

`startupCheck: false` skips it.
