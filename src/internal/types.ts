/** A Lua script a store runs: its source, and the SHA1 that EVALSHA names it by. */
export interface ValkeyScript {
  /** Such as `'locks.acquire'`: for errors, never a key. */
  readonly name: string;
  readonly source: string;
  readonly sha1: string;
}

/**
 * Runs `script` atomically on the node that owns `keys` (always one slot) and resolves the
 * client's reply as is. Every key goes as a script key (numkeys), so a cluster client routes by
 * it. On NOSCRIPT it sends the source once (EVAL, or the client's own mechanism) and retries
 * nothing else: a call that failed may have run. It never closes the client.
 *
 * `glideRunner()` and `ioredisRunner()` are the two this package ships; any object with this
 * method works (a node-redis client, a wrapper that traces, a fake in an application's tests).
 */
export interface ScriptRunner {
  run(script: ValkeyScript, keys: readonly string[], args: readonly string[]): Promise<unknown>;
}

/** What a store does with the server check at startup: see `checkServer()`. */
export type StartupCheck = 'warn' | 'strict' | false;
