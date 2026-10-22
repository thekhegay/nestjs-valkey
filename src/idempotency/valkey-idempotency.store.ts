import type { OnModuleInit } from '@nestjs/common';
import type {
  IdempotencyAcquireResult,
  IdempotencyStore,
  IdempotencyStoredPayload,
} from '@nestjs/idempotency';
import { ValkeyStoreError } from '../internal/errors.js';
import { checkDuration, checkKey, checkPrefix, checkText } from '../internal/keys.js';
import { describeReply, normalizeReply, readFlag } from '../internal/replies.js';
import { runServerCheck } from '../internal/server-check.js';
import type { ScriptRunner, StartupCheck, ValkeyScript } from '../internal/types.js';
import { ACQUIRE, COMPLETE, EXTEND, RELEASE } from './scripts.js';

const STORE = 'ValkeyIdempotencyStore';

export interface ValkeyIdempotencyStoreOptions {
  /**
   * Prepended to every key, default `'idem:'`, the documented recipe's, so its records stay
   * readable. Give each application that shares a server its own, inside its ACL key pattern.
   */
  prefix?: string;
  /** `'warn'` (default), `'strict'`, or `false`. See `checkServer()`. */
  startupCheck?: StartupCheck;
}

/**
 * An `IdempotencyStore` for `@nestjs/idempotency` on Valkey or Redis, standalone or cluster,
 * through a `ScriptRunner` (`glideRunner(client)` or `ioredisRunner(client)`). Every method is one
 * Lua script on one key. It never opens or closes a connection: the application owns the client.
 *
 * A record is the documentation's: a hash at `<prefix><key>` with `state`, `fp`, `owner` and
 * `resp` (the response as JSON), so records written by the documented recipe are read here and
 * the other way round. A record this store cannot read (an unknown state, no response, a response
 * that is not JSON) fails with `ValkeyStoreError` rather than run the handler again.
 *
 * Register it with `valkeyIdempotencyStore()`, or extend it as an `@Injectable()` that calls
 * `storage.registerSource(this)` in its constructor.
 */
export class ValkeyIdempotencyStore implements IdempotencyStore, OnModuleInit {
  readonly #runner: ScriptRunner;
  readonly #prefix: string;
  readonly #startupCheck: StartupCheck;

  constructor(runner: ScriptRunner, options: ValkeyIdempotencyStoreOptions = {}) {
    if (runner == null || typeof runner.run !== 'function') {
      throw new TypeError(`${STORE}: the first argument must be a ScriptRunner, such as glideRunner(client)`);
    }
    const { prefix = 'idem:', startupCheck = 'warn' } = options;
    checkPrefix(STORE, prefix);
    if (startupCheck !== 'warn' && startupCheck !== 'strict' && startupCheck !== false) {
      throw new TypeError(`${STORE}: startupCheck must be 'warn', 'strict' or false`);
    }
    this.#runner = runner;
    this.#prefix = prefix;
    this.#startupCheck = startupCheck;
  }

  async acquire(
    key: string,
    owner: string,
    fingerprint: string,
    lockTtl: number,
  ): Promise<IdempotencyAcquireResult> {
    checkKey(STORE, key);
    checkText(STORE, 'owner', owner);
    checkText(STORE, 'fingerprint', fingerprint);
    checkDuration(STORE, 'lockTtl', lockTtl);
    const reply = await this.#run(ACQUIRE, key, [fingerprint, owner, String(lockTtl)]);
    if (!Array.isArray(reply) || (reply[0] !== 0 && reply[0] !== 1)) {
      throw new ValkeyStoreError(ACQUIRE.name, `unexpected reply (${describeReply(reply)})`);
    }
    if (reply[0] === 1) return { state: 'acquired' };

    const [, state, storedFingerprint, response] = reply as unknown[];
    if (typeof storedFingerprint !== 'string') {
      throw new ValkeyStoreError(
        ACQUIRE.name,
        'the record has no fingerprint; it was not written by this store',
      );
    }
    if (state === 'in-flight') return { state, fingerprint: storedFingerprint };
    if (state !== 'completed') {
      throw new ValkeyStoreError(
        ACQUIRE.name,
        'the record has an unknown state; it was not written by this store',
      );
    }
    if (typeof response !== 'string') {
      throw new ValkeyStoreError(ACQUIRE.name, 'the completed record has no response');
    }
    return { state, fingerprint: storedFingerprint, response: parseResponse(response) };
  }

  async complete(
    key: string,
    owner: string,
    response: IdempotencyStoredPayload,
    ttl: number,
  ): Promise<boolean> {
    checkKey(STORE, key);
    checkText(STORE, 'owner', owner);
    checkDuration(STORE, 'ttl', ttl);
    const json: string | undefined = JSON.stringify(response);
    if (typeof json !== 'string') {
      throw new TypeError(`${STORE}: the response must be a JSON-safe object`);
    }
    return readFlag(COMPLETE, await this.#run(COMPLETE, key, [owner, json, String(ttl)]));
  }

  async release(key: string, owner: string): Promise<boolean> {
    checkKey(STORE, key);
    checkText(STORE, 'owner', owner);
    return readFlag(RELEASE, await this.#run(RELEASE, key, [owner]));
  }

  async extend(key: string, owner: string, lockTtl: number): Promise<boolean> {
    checkKey(STORE, key);
    checkText(STORE, 'owner', owner);
    checkDuration(STORE, 'lockTtl', lockTtl);
    return readFlag(EXTEND, await this.#run(EXTEND, key, [owner, String(lockTtl)]));
  }

  /**
   * Runs one script without keys through the runner and acts per `startupCheck`: a replica, a
   * `maxmemory-policy` other than `noeviction` (a `volatile-*` policy evicts these records too,
   * since each has an expiry), an unreadable `INFO` and a server that does not answer within 3 s
   * are warnings under `'warn'` and failures under `'strict'`. `false` skips it. In a cluster it
   * reads one primary. `onModuleInit()` calls it; call it yourself for a store created outside
   * Nest.
   */
  checkServer(): Promise<void> {
    return runServerCheck(this.#runner, {
      store: STORE,
      mode: this.#startupCheck,
      needsTime: false,
      evicted: 'idempotency records, and an evicted record runs the handler again',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.checkServer();
  }

  async #run(script: ValkeyScript, key: string, args: string[]): Promise<unknown> {
    return normalizeReply(await this.#runner.run(script, [this.#prefix + key], args));
  }
}

/** A new copy on every read, so a caller that mutates what it got changes nothing stored. */
function parseResponse(json: string): IdempotencyStoredPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // The SyntaxError quotes the stored text, which is a client's response: it is left out.
    throw new ValkeyStoreError(ACQUIRE.name, 'the stored response is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValkeyStoreError(ACQUIRE.name, 'the stored response is not a JSON object');
  }
  return parsed as IdempotencyStoredPayload;
}
