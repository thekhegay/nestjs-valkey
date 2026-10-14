import { defineScript } from '../internal/script.js';

// The documentation's Redis recipe, field for field and argument for argument ("Store keys in
// Redis instead" in the idempotency guide): a hash at `idem:<key>` with `state`, `fp`, `owner` and
// `resp`. A record either one writes, the other reads, so an application moves from the recipe to
// this store, or back, without migrating anything, during a rolling deploy too. Every script
// touches one key, so the store works in a cluster with no hash tag. No `#!lua` shebang: see the
// lock scripts.

/** KEYS: record. ARGV: fingerprint, owner, lockTtl ms. Returns {1} when taken, else {0, state, fp, resp}. */
export const ACQUIRE = defineScript(
  'idempotency.acquire',
  `if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('HSET', KEYS[1], 'state', 'in-flight', 'fp', ARGV[1], 'owner', ARGV[2])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return {1}
end
local r = redis.call('HMGET', KEYS[1], 'state', 'fp', 'resp')
return {0, r[1], r[2], r[3]}
`,
);

/** KEYS: record. ARGV: owner, response JSON, ttl ms. Returns 1, or 0 when `owner` holds no live lock. */
export const COMPLETE = defineScript(
  'idempotency.complete',
  `if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] then
  return 0
end
redis.call('HSET', KEYS[1], 'state', 'completed', 'resp', ARGV[2])
redis.call('HDEL', KEYS[1], 'owner')
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`,
);

/** KEYS: record. ARGV: owner. A completed record has no owner, so it is never released. */
export const RELEASE = defineScript(
  'idempotency.release',
  `if redis.call('HGET', KEYS[1], 'owner') == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`,
);

/** KEYS: record. ARGV: owner, lockTtl ms. A completed record has no owner, so it keeps its ttl. */
export const EXTEND = defineScript(
  'idempotency.extend',
  `if redis.call('HGET', KEYS[1], 'owner') == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`,
);
