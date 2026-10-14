/**
 * A reply this package cannot read: a script answered with something it never returns, or an
 * idempotency record is not one the store wrote (an unknown state, no response, a response that
 * is not JSON). The store refuses it rather than guess, so `@Idempotent()` fails the call instead
 * of running the handler again.
 *
 * Errors from the client (a timeout, a closed connection, `NOPERM`, `OOM`, `WRONGTYPE`) are never
 * wrapped in it: they reach the application as the client threw them. The message names the
 * script, never a key, an owner, a fingerprint or a stored response.
 */
export class ValkeyStoreError extends Error {
  override readonly name = 'ValkeyStoreError';

  constructor(
    /** The script whose reply was refused, such as `'locks.acquire'`. */
    readonly script: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${script}: ${message}`, options);
  }
}
