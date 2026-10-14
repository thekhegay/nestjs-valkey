import type { OnModuleInit } from '@nestjs/common';
import type { LockAcquireResult, LockStore } from '@nestjs/locks';
import { ValkeyStoreError } from '../internal/errors.js';
import { checkDuration, checkKey, checkPrefix, checkText, hashTag } from '../internal/keys.js';
import { describeReply, normalizeReply, readFlag } from '../internal/replies.js';
import { runServerCheck } from '../internal/server-check.js';
import type { ScriptRunner, StartupCheck, ValkeyScript } from '../internal/types.js';
import { ACQUIRE, RELEASE, RENEW } from './scripts.js';

const STORE = 'ValkeyLockStore';

export interface ValkeyLockStoreOptions {
  /**
   * Prepended to every key, default `'locks:'`. No `{` or `}`. Give each application that shares
   * a server its own (`'coordinator:locks:'`), inside its ACL key pattern, or same-named jobs of
   * two applications exclude each other.
   */
  prefix?: string;
  /**
   * How long a key's fencing record outlives its last acquisition, in ms (a positive integer).
   * Tokens stay monotonic across any clock shift while the record lives; after it expires, across
   * a server clock (or, after a failover, a replica's) that reads less than this behind. Default
   * `60_000` (a minute), many times what a clock under NTP steps back (a leap second, a correction
   * of a second or so). Every key acquired within it keeps a record of 110 to 140 bytes.
   */
  fenceRetention?: number;
  /** `'warn'` (default), `'strict'`, or `false`. See `checkServer()`. */
  startupCheck?: StartupCheck;
}

/**
 * A `LockStore` for `@nestjs/locks` on Valkey or Redis, standalone or cluster, through a
 * `ScriptRunner` (`glideRunner(client)` or `ioredisRunner(client)`). Every method is one Lua
 * script. It never opens or closes a connection: the application owns the client.
 *
 * A lock lives at `<prefix>{<tag>}` with the owner as its value, and the key's last fencing token
 * at `<prefix>{<tag>}:fence`: one hash slot, so the store works in a cluster, and locks spread
 * over the shards. Fencing tokens are the server's clock in microseconds (about 1.79e15 in 2026,
 * a `bigint` column where a resource stores them), floored at one more than the key's last token.
 * The ACL user needs `+time`, which the startup check verifies.
 *
 * Register it with `valkeyLockStore()`, or extend it as an `@Injectable()` that calls
 * `storage.registerSource(this)` in its constructor.
 */
export class ValkeyLockStore implements LockStore, OnModuleInit {
  readonly #runner: ScriptRunner;
  readonly #prefix: string;
  readonly #fenceRetention: string;
  readonly #startupCheck: StartupCheck;

  constructor(runner: ScriptRunner, options: ValkeyLockStoreOptions = {}) {
    if (runner == null || typeof runner.run !== 'function') {
      throw new TypeError(`${STORE}: the first argument must be a ScriptRunner, such as glideRunner(client)`);
    }
    const { prefix = 'locks:', fenceRetention = 60_000, startupCheck = 'warn' } = options;
    checkPrefix(STORE, prefix);
    checkDuration(STORE, 'fenceRetention', fenceRetention);
    if (startupCheck !== 'warn' && startupCheck !== 'strict' && startupCheck !== false) {
      throw new TypeError(`${STORE}: startupCheck must be 'warn', 'strict' or false`);
    }
    this.#runner = runner;
    this.#prefix = prefix;
    this.#fenceRetention = String(fenceRetention);
    this.#startupCheck = startupCheck;
  }

  async acquire(key: string, owner: string, ttl: number): Promise<LockAcquireResult> {
    checkKey(STORE, key);
    checkText(STORE, 'owner', owner);
    checkDuration(STORE, 'ttl', ttl);
    const lock = this.#lockKey(key);
    const reply = await this.#run(
      ACQUIRE,
      [lock, `${lock}:fence`],
      [owner, String(ttl), this.#fenceRetention],
    );
    if (reply === 0) return { acquired: false };
    if (typeof reply === 'number' && Number.isSafeInteger(reply) && reply >= 1) {
      return { acquired: true, fencingToken: reply };
    }
    // Anything but 0 may mean the script took the lock: free it (only if `owner` holds it) rather
    // than leave it held by nobody until its ttl runs out. Best-effort: its outcome is ignored.
    await this.#run(RELEASE, [lock], [owner]).catch(() => undefined);
    throw new ValkeyStoreError(ACQUIRE.name, `unexpected reply (${describeReply(reply)})`);
  }

  async renew(key: string, owner: string, ttl: number): Promise<boolean> {
    checkKey(STORE, key);
    checkText(STORE, 'owner', owner);
    checkDuration(STORE, 'ttl', ttl);
    return readFlag(RENEW, await this.#run(RENEW, [this.#lockKey(key)], [owner, String(ttl)]));
  }

  async release(key: string, owner: string): Promise<boolean> {
    checkKey(STORE, key);
    checkText(STORE, 'owner', owner);
    return readFlag(RELEASE, await this.#run(RELEASE, [this.#lockKey(key)], [owner]));
  }

  /**
   * Runs one script without keys through the runner and acts per `startupCheck`: an ACL user
   * that may not run `TIME` fails it under both `'warn'` and `'strict'` (every `acquire()` would
   * fail); a `maxmemory-policy` other than `noeviction`, an unreadable `INFO` and a server that
   * does not answer within 3 s are warnings under `'warn'` and failures under `'strict'`. `false`
   * skips it. In a cluster it reads one node. `onModuleInit()` calls it; call it yourself for a
   * store created outside Nest.
   */
  checkServer(): Promise<void> {
    return runServerCheck(this.#runner, {
      store: STORE,
      mode: this.#startupCheck,
      needsTime: true,
      evicted: 'locks, and an evicted lock is taken by another instance while its holder still runs',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.checkServer();
  }

  #lockKey(key: string): string {
    return `${this.#prefix}{${hashTag(key)}}`;
  }

  async #run(script: ValkeyScript, keys: string[], args: string[]): Promise<unknown> {
    return normalizeReply(await this.#runner.run(script, keys, args));
  }
}
