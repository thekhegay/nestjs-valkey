import { createHash } from 'node:crypto';
import type { ValkeyScript } from './types.js';

/** A script with its SHA1, computed once: the stores' scripts are module constants. */
export function defineScript(name: string, source: string): ValkeyScript {
  return Object.freeze({ name, source, sha1: createHash('sha1').update(source).digest('hex') });
}
