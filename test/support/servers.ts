import { GlideClient, GlideClusterClient, type ReadFrom } from '@valkey/valkey-glide';
import { Cluster, Redis } from 'ioredis';
import { Cluster as Ioredis5Cluster, Redis as Ioredis5 } from 'ioredis5';
import { Cluster as IovalkeyCluster, Valkey as Iovalkey } from 'iovalkey';
import { glideRunner } from '../../src/glide/index.js';
import { ioredisRunner } from '../../src/ioredis/index.js';
import type { ScriptRunner } from '../../src/index.js';

export interface Address {
  host: string;
  port: number;
}

function address(text: string): Address {
  const url = new URL(text.includes('://') ? text : `redis://${text}`);
  return { host: url.hostname, port: Number(url.port || 6379) };
}

/** The servers the environment names (docker/servers.env for the ones `pnpm servers:up` starts). */
export const env = {
  standalone: process.env.VALKEY_URL ? address(process.env.VALKEY_URL) : undefined,
  scratch: process.env.VALKEY_SCRATCH_URL ? address(process.env.VALKEY_SCRATCH_URL) : undefined,
  cluster: process.env.VALKEY_CLUSTER_SEEDS
    ? process.env.VALKEY_CLUSTER_SEEDS.split(',').map(address)
    : undefined,
  sentinel: process.env.VALKEY_SENTINEL
    ? {
        ...address(process.env.VALKEY_SENTINEL.split('/')[0]!),
        name: process.env.VALKEY_SENTINEL.split('/')[1] ?? 'mymaster',
      }
    : undefined,
  redis: process.env.REDIS_URL ? address(process.env.REDIS_URL) : undefined,
};

/** Why a suite is skipped: the variable that would name its server. */
export function missing(variable: keyof typeof variables): string | false {
  return env[variables[variable]] ? false : `${variable} is not set`;
}
const variables = {
  VALKEY_URL: 'standalone',
  VALKEY_SCRATCH_URL: 'scratch',
  VALKEY_CLUSTER_SEEDS: 'cluster',
  VALKEY_SENTINEL: 'sentinel',
  REDIS_URL: 'redis',
} as const;

const TIMEOUT = 5_000;

export interface Connection {
  runner: ScriptRunner;
  close(): Promise<void>;
}

/** A client and topology to run a suite against, skipped when its server is not named. */
export interface Target {
  name: string;
  skip: string | false;
  cluster: boolean;
  connect(): Promise<Connection>;
}

export const glideStandalone = (at = env.standalone, label = 'valkey'): Target => ({
  name: `glide on ${label} standalone`,
  skip: at ? false : `no address for ${label}`,
  cluster: false,
  async connect() {
    const client = await GlideClient.createClient({ addresses: [at!], requestTimeout: TIMEOUT });
    return { runner: glideRunner(client), close: async () => client.close() };
  },
});

export const glideCluster = (readFrom: ReadFrom = 'primary'): Target => ({
  name: `glide on valkey cluster${readFrom === 'primary' ? '' : ` (readFrom ${readFrom})`}`,
  skip: missing('VALKEY_CLUSTER_SEEDS'),
  cluster: true,
  async connect() {
    const client = await GlideClusterClient.createClient({
      addresses: env.cluster!,
      requestTimeout: TIMEOUT,
      readFrom,
    });
    return { runner: glideRunner(client), close: async () => client.close() };
  },
});

type IoredisFlavour = 'ioredis' | 'ioredis5' | 'iovalkey';

const standaloneClient = (flavour: IoredisFlavour, at: Address) => {
  const options = { host: at.host, port: at.port, commandTimeout: TIMEOUT };
  return flavour === 'ioredis'
    ? new Redis(options)
    : flavour === 'ioredis5'
      ? new Ioredis5(options)
      : new Iovalkey(options);
};

const clusterClient = (flavour: IoredisFlavour, scaleReads: 'master' | 'slave') => {
  const options = { scaleReads, redisOptions: { commandTimeout: TIMEOUT } };
  return flavour === 'ioredis'
    ? new Cluster(env.cluster!, options)
    : flavour === 'ioredis5'
      ? new Ioredis5Cluster(env.cluster!, options)
      : new IovalkeyCluster(env.cluster!, options);
};

export const ioredisStandalone = (
  flavour: IoredisFlavour = 'ioredis',
  at = env.standalone,
  label = 'valkey',
): Target => ({
  name: `${flavour} on ${label} standalone`,
  skip: at ? false : `no address for ${label}`,
  cluster: false,
  async connect() {
    const client = standaloneClient(flavour, at!);
    await ping(client);
    return { runner: ioredisRunner(client), close: async () => void (await client.quit()) };
  },
});

export const ioredisCluster = (
  flavour: IoredisFlavour = 'ioredis',
  scaleReads: 'master' | 'slave' = 'master',
): Target => ({
  name: `${flavour} on valkey cluster${scaleReads === 'master' ? '' : ` (scaleReads ${scaleReads})`}`,
  skip: missing('VALKEY_CLUSTER_SEEDS'),
  cluster: true,
  async connect() {
    const client = clusterClient(flavour, scaleReads);
    await ping(client);
    return { runner: ioredisRunner(client), close: async () => void (await client.quit()) };
  },
});

export const ioredisSentinel = (): Target => ({
  name: 'ioredis on valkey behind sentinel',
  skip: missing('VALKEY_SENTINEL'),
  cluster: false,
  async connect() {
    const { host, port, name } = env.sentinel!;
    const client = new Redis({ sentinels: [{ host, port }], name, commandTimeout: TIMEOUT });
    await ping(client);
    return { runner: ioredisRunner(client), close: async () => void (await client.quit()) };
  },
});

async function ping(client: { ping(): Promise<unknown> }): Promise<void> {
  await client.ping();
}

/** Every target the contract suites run against. */
export const allTargets = (): Target[] => [
  glideStandalone(),
  glideCluster(),
  ioredisStandalone(),
  ioredisCluster(),
  ioredisStandalone('ioredis5'),
  ioredisCluster('ioredis5'),
  ioredisStandalone('iovalkey'),
  ioredisCluster('iovalkey'),
  ioredisSentinel(),
  glideStandalone(env.redis, 'redis'),
  ioredisStandalone('ioredis', env.redis, 'redis'),
];

/** The four that cover both clients on both topologies. */
export const coreTargets = (): Target[] => [
  glideStandalone(),
  glideCluster(),
  ioredisStandalone(),
  ioredisCluster(),
];

/** An ioredis client for the raw commands a test inspects the server with. */
export function admin(target: Pick<Target, 'cluster'>): Redis | Cluster {
  return target.cluster
    ? new Cluster(env.cluster!, { redisOptions: { commandTimeout: TIMEOUT } })
    : new Redis({ ...env.standalone!, commandTimeout: TIMEOUT });
}

/** Every node of the target, primaries and replicas, for commands that must reach them all. */
export async function everyNode(client: Redis | Cluster): Promise<Redis[]> {
  if (client instanceof Cluster) {
    if (client.status !== 'ready') await new Promise((resolve) => client.once('ready', resolve));
    return client.nodes('all');
  }
  return [client];
}
