import { defineScript } from '../internal/script.js';

// No `#!lua` shebang, on purpose. Under `noeviction` and out of memory, a script with a shebang is
// refused whole (unless it says `allow-oom`), so renew() and release() would fail although they
// add nothing to memory: live holders would lose their locks, and the release that frees memory
// would be refused. A plain script refuses only the commands that grow memory (SET), and only
// before its first write. Only the idempotency store's COMPLETE carries a flag.

/**
 * KEYS: lock, fence (one slot). ARGV: owner, ttl ms, fence retention ms. Returns the fencing token,
 * or 0 when a live lock holds the key. Every read comes before the first write, so an error
 * (WRONGTYPE on foreign data under the fence key) leaves nothing behind.
 *
 * A fence is the decimal integer this script writes. One that is anything else (foreign data,
 * `1.5`, `0x10`), or at least 2^53 - 2, is refused with an error before the first write, so every
 * token stays below `Number.MAX_SAFE_INTEGER` and one more than it is still exact. Refused after
 * the write instead, the lock would be held by nobody until its ttl ran out.
 *
 * The token is the server's clock in microseconds, or one more than the key's last token when
 * that is ahead: it grows across releases and expiries while the fence lives, whatever the clocks
 * do. The fence expires `retention + ahead` ms after the acquisition, `ahead` being how far the
 * token ran ahead of the clock, so once it is gone the clock has passed the last token.
 */
export const ACQUIRE = defineScript(
  'locks.acquire',
  `if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
local now = redis.call('TIME')
local clock = tonumber(now[1]) * 1000000 + tonumber(now[2])
local token = clock
local fence = redis.call('GET', KEYS[2])
if fence then
  local last = string.match(fence, '^%d+$') and tonumber(fence)
  if not last or last >= 9007199254740990 then
    return redis.error_reply('ERR locks.acquire: the fence holds no token this store can extend (not a decimal integer, or at least 2^53 - 2)')
  end
  if last >= token then
    token = last + 1
  end
end
local ahead = math.ceil((token - clock) / 1000)
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SET', KEYS[2], string.format('%.0f', token), 'PX', string.format('%.0f', tonumber(ARGV[3]) + ahead))
return token
`,
);

/** KEYS: lock. ARGV: owner, ttl ms. Returns 1, or 0 when `owner` holds no live lock. */
export const RENEW = defineScript(
  'locks.renew',
  `if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`,
);

/** KEYS: lock. ARGV: owner. Returns 1, or 0. The fence keeps its expiry. */
export const RELEASE = defineScript(
  'locks.release',
  `if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`,
);
