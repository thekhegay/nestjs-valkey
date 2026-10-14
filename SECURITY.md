# Security policy

## Supported versions

The latest minor of the current major receives fixes. Older lines do not.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |

## Reporting a vulnerability

Report privately through GitHub's [security advisories](https://github.com/thekhegay/nestjs-valkey/security/advisories/new)
rather than in an issue.

The stores decide who holds a lock and whether a request already ran, so the
interesting reports are the ones where two owners can hold the same lock, a
fencing token repeats or goes backwards, a non-owner can release or extend a
lock, or an idempotency key lets a handler run twice. Include the server
version, the client (glide or ioredis), standalone or cluster, and a script or
test that shows it.

Expect a first reply within a week.
