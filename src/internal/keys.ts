/**
 * The cluster hash tag for a key: injective and free of braces, so the whole tag is what the
 * cluster hashes, for the lock and its fence alike.
 *
 * A cluster hashes the text between the first `{` and the first `}` after it, when that text is
 * not empty. A key starting with `}` would give the empty tag `{}`, the server would hash the whole
 * key instead, the lock and its fence would land in two slots, and the script would fail with
 * CROSSSLOT. Escaping `%`, `{` and `}` keeps every tag brace-free and keeps distinct keys
 * distinct; the empty key becomes a lone `%`, which escaping never produces.
 */
export function hashTag(key: string): string {
  if (key.length === 0) return '%';
  return key.replace(/[%{}]/g, (c) => (c === '%' ? '%25' : c === '{' ? '%7B' : '%7D'));
}

/**
 * A key must be a well-formed string: both clients encode a lone surrogate as U+FFFD, so two
 * different keys (U+D800 and U+DC00) would become one on the wire. The message never names the
 * key: idempotency keys come from clients.
 */
export function checkKey(store: string, key: unknown): asserts key is string {
  if (typeof key !== 'string') {
    throw new TypeError(`${store}: a key must be a string, got ${typeof key}`);
  }
  if (!key.isWellFormed()) {
    throw new TypeError(
      `${store}: a key must be well-formed Unicode; this one holds a lone surrogate, which the client ` +
        'would send as U+FFFD, merging it with other keys',
    );
  }
}

/** An owner (or a fingerprint) is a string too, compared exactly: the same rule as for keys. */
export function checkText(store: string, what: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    throw new TypeError(`${store}: ${what} must be a well-formed string`);
  }
}

/**
 * A prefix with a brace would take the hash slot for itself and put every lock of the application
 * on one shard, so it is refused.
 */
export function checkPrefix(store: string, prefix: unknown): asserts prefix is string {
  if (typeof prefix !== 'string' || !prefix.isWellFormed()) {
    throw new TypeError(`${store}: prefix must be a well-formed string`);
  }
  if (/[{}]/.test(prefix)) {
    throw new TypeError(
      `${store}: prefix must not contain "{" or "}": a brace would make the prefix the cluster hash tag ` +
        'and put every key on one shard',
    );
  }
}

/**
 * Durations go to `PX` / `PEXPIRE` inside a script, and a script does not undo a `SET` when the
 * `PEXPIRE` after it fails: an invalid one is refused before anything reaches the server.
 */
export function checkDuration(store: string, name: string, ms: unknown): asserts ms is number {
  if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 1) {
    throw new RangeError(
      `${store}: ${name} must be a whole number of milliseconds, at least 1, got ${String(ms)}`,
    );
  }
}
