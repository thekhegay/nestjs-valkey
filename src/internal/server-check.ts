import { Logger } from '@nestjs/common';
import { normalizeReply } from './replies.js';
import { defineScript } from './script.js';
import type { ScriptRunner, StartupCheck } from './types.js';

/**
 * No keys: in a cluster, the runner sends it to a primary. `pcall` turns an ACL refusal into a
 * value instead of an error. `CONFIG GET` is not allowed from a script, and a separate `CONFIG`
 * call is often closed on managed services, so the policy is read from `INFO memory`, and the
 * role from `INFO replication` in the same call (`ROLE` may not run in a script).
 */
export const PROBE = defineScript(
  'server.probe',
  `local time = redis.pcall('TIME')
local info = redis.pcall('INFO', 'memory', 'replication')
local timeError = type(time) == 'table' and time.err or false
local policy = type(info) == 'string' and string.match(info, 'maxmemory_policy:([%w-]+)') or false
local infoError = type(info) == 'table' and info.err or false
local role = type(info) == 'string' and string.match(info, '\\nrole:(%a+)') or false
return {timeError, policy, infoError, role}
`,
);

/** How long the check waits for the server before it reports that it could not run. */
export const PROBE_TIMEOUT = 3_000;

export interface ServerCheckOptions {
  /** The store's class name: the logger context and the start of every message. */
  store: string;
  mode: StartupCheck;
  /** The lock store draws fencing tokens from `TIME`; the idempotency store never calls it. */
  needsTime: boolean;
  /** What an evicted key costs, for the warning about `maxmemory-policy`. */
  evicted: string;
  logger?: Pick<Logger, 'warn'>;
  timeout?: number;
}

/**
 * Runs the probe through the store's own runner and acts on what it finds. A lock store whose
 * ACL user may not run `TIME` always fails: every `acquire()` would fail inside the script, and
 * `ACL DRYRUN` cannot tell, since it checks only the outer `EVALSHA`. A replica (a client pointed
 * at one, or behind Sentinel with `role: 'slave'`), a `maxmemory-policy` other than `noeviction`,
 * an `INFO` the user may not run, and a server that does not answer are warnings under `'warn'`
 * and failures under `'strict'`. In a cluster the probe reads one primary.
 */
export async function runServerCheck(runner: ScriptRunner, options: ServerCheckOptions): Promise<void> {
  const { store, mode, needsTime } = options;
  if (mode === false) return;
  const logger = options.logger ?? new Logger(store);
  const problem = (message: string, cause?: unknown): void => {
    if (mode === 'strict') {
      throw new Error(`${store}: ${message}`, cause === undefined ? undefined : { cause });
    }
    logger.warn(message);
  };

  let reply: unknown;
  try {
    reply = normalizeReply(await withTimeout(runner.run(PROBE, [], []), options.timeout ?? PROBE_TIMEOUT));
  } catch (error) {
    problem(
      `the server check did not complete (${error instanceof Error ? error.message : String(error)}), ` +
        'so the ACL grants and maxmemory-policy were not verified',
      error,
    );
    return;
  }
  if (!Array.isArray(reply) || reply.length !== 4) {
    problem(
      'the server check got a reply it cannot read, so the ACL grants and maxmemory-policy were not verified',
    );
    return;
  }
  const [timeError, policy, infoError, role] = reply.map((value: unknown) =>
    typeof value === 'string' ? value : null,
  );

  if (needsTime && timeError !== null) {
    throw new Error(
      `${store}: the ACL user may not run TIME inside a script (${timeError}). Every acquire() would fail: ` +
        'grant +time to the ACL user (fencing tokens are drawn from the server clock)',
    );
  }
  if (role === 'slave') {
    problem(
      'the server is a replica (role:slave): the stores write on every call, which a replica refuses with ' +
        'READONLY or keeps to itself. Point the client at the primary',
    );
  }
  if (infoError !== null || policy === null) {
    problem(
      `could not read maxmemory-policy${infoError === null ? '' : ` (${infoError})`}; make sure it is noeviction, ` +
        `or the server may evict ${options.evicted}. Grant +info to the ACL user to have this checked`,
    );
    return;
  }
  if (policy !== 'noeviction') {
    problem(`maxmemory-policy is ${policy}, not noeviction: the server may evict ${options.evicted}`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
