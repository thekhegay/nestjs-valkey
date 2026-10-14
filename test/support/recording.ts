import type { ScriptRunner } from '../../src/index.js';

export interface Recorded {
  script: string;
  keys: readonly string[];
}

/** Wraps a runner and records which keys each script call carried. */
export function recording(runner: ScriptRunner): ScriptRunner & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    run(script, keys, args) {
      calls.push({ script: script.name, keys: [...keys] });
      return runner.run(script, keys, args);
    },
  };
}
