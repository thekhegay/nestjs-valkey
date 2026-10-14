import { Logger } from '@nestjs/common';
import type { ScriptRunner } from '../internal/types.js';

/**
 * What `ioredisRunner()` needs from a client: `eval`, and `evalsha` when it has one. ioredis 5
 * and 6 and iovalkey fit as they are, `Redis` and `Cluster` alike (including a client behind
 * Sentinel), and so does the documentation's `RedisEval`, which has only `eval`.
 */
export interface IoredisLike {
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
  evalsha?(sha1: string, numkeys: number, ...args: string[]): Promise<unknown>;
  readonly options?: ConnectionOptions & { redisOptions?: ConnectionOptions };
}

/** The options of a `Redis`, or a `Cluster`'s `redisOptions`, that the runner reads. */
interface ConnectionOptions {
  commandTimeout?: number;
  stringNumbers?: boolean;
}

/**
 * A `ScriptRunner` over an ioredis or iovalkey client (`Redis` or `Cluster`). It sends EVALSHA,
 * and on NOSCRIPT one EVAL with the source, which a `Cluster` routes by the keys and which caches
 * the script on that node. The client's `keyPrefix` applies to the keys on top of the store's
 * prefix, to a lock and its fence alike: it must not contain a brace. The runner never closes the
 * client.
 *
 * Give the client a `commandTimeout`: `@nestjs/locks` bounds no store call, so `acquire()` and
 * `release()` against a server that stops answering wait as long as the client does. The runner
 * warns once when the client has none. A `commandTimeout` also applies to blocking commands, so
 * give the stores a connection of their own: `redis.duplicate({ commandTimeout: 2000 })`.
 *
 * A client with `stringNumbers` (or a `Cluster` with it in `redisOptions`) is refused: it returns
 * the scripts' integer replies as strings, which the stores cannot read once the script has run.
 * `duplicate()` copies it, so pass `stringNumbers: false` there.
 */
export function ioredisRunner(client: IoredisLike): ScriptRunner {
  if (client == null || typeof client.eval !== 'function') {
    throw new TypeError('ioredisRunner() takes an ioredis or iovalkey client (Redis or Cluster)');
  }
  const options = client.options;
  // A Cluster's connections take redisOptions, not the cluster's own options.
  const connection = options?.redisOptions ?? options;
  if (connection?.stringNumbers) {
    throw new TypeError(
      'ioredisRunner(): the client has stringNumbers set, which returns integer replies as strings, so every ' +
        'store call would fail after its script ran. Give the stores a client without it: ' +
        'redis.duplicate({ stringNumbers: false, commandTimeout: 2000 })',
    );
  }
  const timeout = connection?.commandTimeout;
  if (options && timeout == null) {
    new Logger('nestjs-valkey').warn(
      'ioredisRunner(): the client has no commandTimeout, and @nestjs/locks bounds no store call: ' +
        'acquire() and release() against a server that stops answering wait as long as the client does',
    );
  }
  return {
    async run(script, keys, args) {
      const argv = [...keys, ...args];
      if (client.evalsha) {
        try {
          return await client.evalsha(script.sha1, keys.length, ...argv);
        } catch (error) {
          if (!(error instanceof Error) || !/^NOSCRIPT\b/.test(error.message)) throw error;
        }
      }
      return client.eval(script.source, keys.length, ...argv);
    },
  };
}
