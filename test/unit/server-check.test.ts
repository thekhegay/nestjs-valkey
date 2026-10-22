import { describe, expect, it, vi } from 'vitest';
import { runServerCheck, type ServerCheckOptions } from '../../src/internal/server-check.js';
import type { ScriptRunner } from '../../src/index.js';
import { HEALTHY, fakeRunner } from '../support/fake-runner.js';

const DENIED = "ERR ACL failure in script: User coord has no permissions to run the 'time' command";

function check(reply: () => unknown, options: Partial<ServerCheckOptions>) {
  const warn = vi.fn();
  const runner = fakeRunner(reply);
  const done = runServerCheck(runner, {
    store: 'TestStore',
    mode: 'warn',
    needsTime: true,
    evicted: 'locks',
    logger: { warn },
    timeout: 50,
    ...options,
  });
  return { done, warn, runner };
}

describe('the startup check', () => {
  it('passes quietly on a healthy server, through one keyless script', async () => {
    for (const mode of ['warn', 'strict'] as const) {
      const { done, warn, runner } = check(() => HEALTHY, { mode });
      await expect(done).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]).toMatchObject({ keys: [], args: [] });
      expect(runner.calls[0]!.script.name).toBe('server.probe');
    }
  });

  it('fails a lock store whose user may not run TIME, under warn and strict alike', async () => {
    for (const mode of ['warn', 'strict'] as const) {
      const { done } = check(() => [DENIED, 'noeviction', null, 'master'], { mode });
      await expect(done).rejects.toThrow(/grant \+time to the ACL user/);
    }
  });

  it('ignores TIME for a store that never calls it', async () => {
    const { done, warn } = check(() => [DENIED, 'noeviction', null, 'master'], {
      needsTime: false,
      mode: 'strict',
    });
    await expect(done).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  const findings: [string, () => unknown, RegExp][] = [
    [
      'a maxmemory-policy other than noeviction',
      () => [null, 'volatile-lru', null, 'master'],
      /maxmemory-policy is volatile-lru/,
    ],
    [
      'an INFO the user may not run',
      () => [null, null, 'NOPERM no info', null],
      /could not read maxmemory-policy \(NOPERM/,
    ],
    ['an INFO without the policy', () => [null, false, false, 'master'], /could not read maxmemory-policy;/],
    ['a replica', () => [null, 'noeviction', null, 'slave'], /is a replica \(role:slave\).*READONLY/],
    [
      'a server that does not answer',
      () => new Promise(() => undefined),
      /did not complete \(no answer within 50ms\)/,
    ],
    [
      'a server that fails the call',
      () => Promise.reject(new Error('Connection is closed.')),
      /did not complete \(Connection is closed\.\)/,
    ],
    ['a reply it cannot read', () => 'OK', /cannot read/],
    ['a reply of the probe before it read the role', () => [null, 'noeviction', null], /cannot read/],
  ];

  for (const [name, reply, message] of findings) {
    it(`warns under warn and fails under strict on ${name}`, async () => {
      const warned = check(reply, { mode: 'warn' });
      await expect(warned.done).resolves.toBeUndefined();
      expect(warned.warn).toHaveBeenCalledTimes(1);
      expect(warned.warn.mock.calls[0]![0]).toMatch(message);

      const strict = check(reply, { mode: 'strict' });
      await expect(strict.done).rejects.toThrow(message);
      expect(strict.warn).not.toHaveBeenCalled();
    });
  }

  it('keeps the cause of a failed call under strict', async () => {
    const failure = new Error('Connection is closed.');
    const { done } = check(() => Promise.reject(failure), { mode: 'strict' });
    await expect(done).rejects.toMatchObject({ cause: failure });
  });

  it('does nothing at all when switched off', async () => {
    const runner: ScriptRunner = { run: vi.fn() };
    await runServerCheck(runner, { store: 'S', mode: false, needsTime: true, evicted: 'locks' });
    expect(runner.run).not.toHaveBeenCalled();
  });
});
