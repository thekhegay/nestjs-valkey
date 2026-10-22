import { BaseClient, Decoder, GlideClusterClient, Script } from '@valkey/valkey-glide';
import type { ScriptRunner, ValkeyScript } from '../internal/types.js';

// glide keeps a Script's code in a process-wide native container that is never garbage
// collected. The stores have seven fixed scripts and a probe: one Script per source for the life
// of the process, shared by every runner, so there is nothing to release.
const compiled = new Map<string, Script>();

/** Where a keyless call goes in a cluster: the primary that serves slot 0. */
const PRIMARY = { type: 'primarySlotId', id: 0 } as const;

/**
 * Arguments of at least this many UTF-16 units in all (a large `complete()`) go as EVALSHA through
 * `customCommand`. glide 2.x writes an `invokeScript` call's arguments through its socket to the
 * core, which takes seconds for a response of a few MiB, grows faster than the response, and holds
 * up every other call on the client meanwhile, a lock's renewal included; `requestTimeout` starts
 * only once the core has read it all. A command's arguments go to the core by reference instead.
 */
const LARGE_ARGUMENTS = 64 * 1024;

/** `customCommand`, which `GlideClient` and `GlideClusterClient` declare apart, not on `BaseClient`. */
interface CustomCommand {
  customCommand(args: string[], options: { decoder: Decoder }): Promise<unknown>;
}

/**
 * A `ScriptRunner` over a `GlideClient` or `GlideClusterClient`, or either typed as the
 * `BaseClient` both extend. `invokeScript` sends EVALSHA and loads the script itself on NOSCRIPT;
 * a cluster client routes by the keys. The startup probe has none, and `invokeScript` would send
 * it to any node, replicas included, whose ACL and `maxmemory-policy` may not be the primaries':
 * in a cluster it goes to the primary that serves slot 0. Every call decodes the reply as
 * strings, whatever `defaultDecoder` the application's client has. A call whose arguments come to
 * 64 Ki UTF-16 units or more (a large `complete()`) goes as EVALSHA through `customCommand`
 * instead, routed by its keys the same way, and through `invokeScript` on NOSCRIPT: glide 2.x is
 * slow to pass large script arguments to its core. The runner never closes the client.
 *
 * Set `requestTimeout` above the slowest healthy script call and below the `storeTimeout` of
 * `@nestjs/idempotency` and of `@nestjs/locks` from 0.0.4 (10 s by default in both): glide's
 * default, 250 ms, is shorter than a failover. glide logs each NOSCRIPT and MOVED it recovers
 * from in a cluster as a `WARN` line on stdout; `Logger.setLoggerConfig()` from
 * `@valkey/valkey-glide` quiets it (`'error'`) or sends it to a file.
 */
export function glideRunner(client: BaseClient): ScriptRunner {
  if (!(client instanceof BaseClient)) {
    throw new TypeError(
      'glideRunner() takes a GlideClient or GlideClusterClient from the copy of @valkey/valkey-glide ' +
        'that nestjs-valkey resolves; this one is not, which usually means two copies of ' +
        '@valkey/valkey-glide are installed, and two copies keep two script containers',
    );
  }
  return {
    run(script, keys, args) {
      let native = compiled.get(script.sha1);
      if (!native) compiled.set(script.sha1, (native = new Script(script.source)));
      if (keys.length === 0 && client instanceof GlideClusterClient) {
        return client.invokeScriptWithRoute(native, {
          args: [...args],
          decoder: Decoder.String,
          route: PRIMARY,
        });
      }
      if (keys.length > 0 && args.reduce((sum, arg) => sum + arg.length, 0) >= LARGE_ARGUMENTS) {
        return evalsha(client, script, native, keys, args);
      }
      return client.invokeScript(native, { keys: [...keys], args: [...args], decoder: Decoder.String });
    },
  };
}

/**
 * EVALSHA as a command, which glide routes by its keys like `invokeScript`. On NOSCRIPT (glide's
 * `NoScriptError`) the call goes through `invokeScript`, which loads the script with SCRIPT LOAD,
 * the grant glide needs anyway, rather than EVAL; any other error is passed on, since a call that
 * failed may have run.
 */
async function evalsha(
  client: BaseClient,
  script: ValkeyScript,
  native: Script,
  keys: readonly string[],
  args: readonly string[],
): Promise<unknown> {
  try {
    return await (client as BaseClient & CustomCommand).customCommand(
      ['EVALSHA', script.sha1, String(keys.length), ...keys, ...args],
      { decoder: Decoder.String },
    );
  } catch (error) {
    if (!(error instanceof Error) || !/\bNoScriptError\b|\bNOSCRIPT\b/.test(error.message)) throw error;
    return client.invokeScript(native, { keys: [...keys], args: [...args], decoder: Decoder.String });
  }
}
