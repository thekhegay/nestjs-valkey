import { ValkeyStoreError } from './errors.js';
import type { ValkeyScript } from './types.js';

const utf8 = new TextDecoder('utf-8');

/**
 * A reply as the stores read it, whatever the client returned: bytes (a `Buffer`, a `Uint8Array`,
 * a client on a bytes decoder) become UTF-8 strings, a `bigint` becomes a `number` when it is
 * safe, `undefined` becomes `null`, and arrays are normalized element by element. Anything else is
 * returned as is, for the store to refuse.
 */
export function normalizeReply(reply: unknown): unknown {
  if (reply === undefined) return null;
  if (typeof reply === 'bigint') {
    return reply >= BigInt(Number.MIN_SAFE_INTEGER) && reply <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(reply)
      : reply;
  }
  if (reply instanceof Uint8Array) return utf8.decode(reply);
  if (Array.isArray(reply)) return reply.map(normalizeReply);
  return reply;
}

/** What a refused reply was, for an error message that names no data. */
export function describeReply(reply: unknown): string {
  if (reply === null) return 'null';
  if (Array.isArray(reply)) return `an array of ${reply.length}`;
  if (typeof reply === 'number')
    return Number.isInteger(reply) ? 'an integer out of range' : 'a non-integer number';
  return `a ${typeof reply}`;
}

/** A compare-and-set script's answer: 1 when it wrote, 0 when it did not. */
export function readFlag(script: ValkeyScript, reply: unknown): boolean {
  if (reply === 1) return true;
  if (reply === 0) return false;
  throw new ValkeyStoreError(script.name, `unexpected reply (${describeReply(reply)})`);
}
