import { BaseClient, Decoder, GlideClusterClient, Script } from '@valkey/valkey-glide';
import type { ScriptRunner } from '../internal/types.js';

// glide keeps a Script's code in a process-wide native container that is never garbage
// collected. The stores have seven fixed scripts and a probe: one Script per source for the life
// of the process, shared by every runner, so there is nothing to release.
const compiled = new Map<string, Script>();

/** Where a keyless call goes in a cluster: the primary that serves slot 0. */
const PRIMARY = { type: 'primarySlotId', id: 0 } as const;

/**
 * A `ScriptRunner` over a `GlideClient` or `GlideClusterClient`, or either typed as the
 * `BaseClient` both extend. `invokeScript` sends EVALSHA and loads the script itself on NOSCRIPT;
 * a cluster client routes by the keys. The startup probe has none, and `invokeScript` would send
 * it to any node, replicas included, whose ACL and `maxmemory-policy` may not be the primaries':
 * in a cluster it goes to the primary that serves slot 0. Every call decodes the reply as
 * strings, whatever `defaultDecoder` the application's client has. The runner never closes the
 * client.
 *
 * Set `requestTimeout` above the slowest healthy script call and below `@nestjs/idempotency`'s
 * `storeTimeout`: glide's default, 250 ms, is shorter than a failover. glide logs each NOSCRIPT
 * and MOVED it recovers from in a cluster as a `WARN` line on stdout; `Logger.setLoggerConfig()`
 * from `@valkey/valkey-glide` quiets it (`'error'`) or sends it to a file.
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
      return client.invokeScript(native, { keys: [...keys], args: [...args], decoder: Decoder.String });
    },
  };
}
