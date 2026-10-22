import type { ScriptRunner, ValkeyScript } from '../../src/index.js';

export interface Call {
  script: ValkeyScript;
  keys: readonly string[];
  args: readonly string[];
}

/** A runner that records its calls and answers with `reply`. */
export function fakeRunner(reply: (call: Call) => unknown = () => 1): ScriptRunner & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(script, keys, args) {
      const call = { script, keys, args };
      calls.push(call);
      return reply(call);
    },
  };
}

/** The probe's reply for a healthy server. */
export const HEALTHY: unknown[] = [null, 'noeviction', null, 'master'];
