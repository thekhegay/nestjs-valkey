import { BaseClient, Decoder, Script, type GlideClient, type GlideClusterClient } from '@valkey/valkey-glide';
import type { ScriptRunner } from '../internal/types.js';

// glide keeps a Script's code in a process-wide native container that is never garbage
// collected. The stores have seven fixed scripts and a probe: one Script per source for the life
// of the process, shared by every runner, so there is nothing to release.
const compiled = new Map<string, Script>();

/**
 * A `ScriptRunner` over a `GlideClient` or `GlideClusterClient`. `invokeScript` sends EVALSHA and
 * loads the script itself on NOSCRIPT; a cluster client routes by the keys, and the probe (no
 * keys) goes to any node. Every call decodes the reply as strings, whatever `defaultDecoder` the
 * application's client has. The runner never closes the client.
 *
 * Set `requestTimeout` above the slowest healthy script call and below `@nestjs/idempotency`'s
 * `storeTimeout`: glide's default, 250 ms, is shorter than a failover.
 */
export function glideRunner(client: GlideClient | GlideClusterClient): ScriptRunner {
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
      return client.invokeScript(native, { keys: [...keys], args: [...args], decoder: Decoder.String });
    },
  };
}
