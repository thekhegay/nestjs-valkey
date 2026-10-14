// Compile-time checks, run by `pnpm typecheck`: which clients each adapter accepts.
import type { BaseClient, GlideClient, GlideClusterClient } from '@valkey/valkey-glide';
import type { Cluster, Redis } from 'ioredis';
import type { Cluster as Ioredis5Cluster, Redis as Ioredis5 } from 'ioredis5';
import type { Cluster as IovalkeyCluster, Valkey } from 'iovalkey';
import { glideRunner } from '../../src/glide/index.js';
import type { ScriptRunner } from '../../src/index.js';
import { ioredisRunner } from '../../src/ioredis/index.js';

/** The documentation's minimal client (locks guide, "The store on Redis"). */
interface RedisEval {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

declare const redis6: Redis;
declare const cluster6: Cluster;
declare const redis5: Ioredis5;
declare const cluster5: Ioredis5Cluster;
declare const valkey: Valkey;
declare const valkeyCluster: IovalkeyCluster;
declare const docsClient: RedisEval;
declare const glide: GlideClient;
declare const glideCluster: GlideClusterClient;
/** Either client, typed as the base both extend, as an application's provider may type it. */
declare const glideBase: BaseClient;

export const runners: ScriptRunner[] = [
  ioredisRunner(redis6),
  ioredisRunner(cluster6),
  ioredisRunner(redis5),
  ioredisRunner(cluster5),
  ioredisRunner(valkey),
  ioredisRunner(valkeyCluster),
  ioredisRunner(docsClient),
  glideRunner(glide),
  glideRunner(glideCluster),
  glideRunner(glideBase),
  // @ts-expect-error a glide client has no eval(): it takes glideRunner()
  ioredisRunner(glide),
  // @ts-expect-error an ioredis client is not a glide client
  glideRunner(redis6),
];
