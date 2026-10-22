import { describe, expect, it } from 'vitest';
import { ValkeyIdempotencyStore } from '../../src/idempotency/index.js';
import { ValkeyStoreError } from '../../src/index.js';
import { ValkeyLockStore } from '../../src/locks/index.js';
import { fakeRunner } from '../support/fake-runner.js';

describe('ValkeyLockStore', () => {
  it('sends the lock and its fence as script keys, durations as decimal strings', async () => {
    const runner = fakeRunner(({ script }) => (script.name === 'locks.acquire' ? 1791987506882969 : 1));
    const store = new ValkeyLockStore(runner, { prefix: 'app:locks:', fenceRetention: 5000 });
    await expect(store.acquire('jobs:{x}', 'owner', 2_592_000_000)).resolves.toEqual({
      acquired: true,
      fencingToken: 1791987506882969,
    });
    await expect(store.renew('jobs:{x}', 'owner', 1000)).resolves.toBe(true);
    await expect(store.release('jobs:{x}', 'owner')).resolves.toBe(true);
    expect(runner.calls.map(({ script, keys, args }) => [script.name, keys, args])).toEqual([
      [
        'locks.acquire',
        ['app:locks:{jobs:%7Bx%7D}', 'app:locks:{jobs:%7Bx%7D}:fence'],
        ['owner', '2592000000', '5000'],
      ],
      ['locks.renew', ['app:locks:{jobs:%7Bx%7D}'], ['owner', '1000']],
      ['locks.release', ['app:locks:{jobs:%7Bx%7D}'], ['owner']],
    ]);
  });

  it('defaults to the locks: prefix and a minute of fence retention', async () => {
    const runner = fakeRunner(() => 0);
    await expect(new ValkeyLockStore(runner).acquire('', 'o', 1)).resolves.toEqual({ acquired: false });
    expect(runner.calls[0]).toMatchObject({
      keys: ['locks:{%}', 'locks:{%}:fence'],
      args: ['o', '1', '60000'],
    });
  });

  it('reads a token from bytes or a bigint, and refuses a reply it never sends', async () => {
    const replies: unknown[] = [Buffer.from('7'), 7n];
    const store = new ValkeyLockStore(
      fakeRunner(({ script }) => (script.name === 'locks.acquire' ? replies.shift() : 1)),
    );
    await expect(store.acquire('k', 'o', 1)).rejects.toThrow(ValkeyStoreError);
    await expect(store.acquire('k', 'o', 1)).resolves.toEqual({ acquired: true, fencingToken: 7 });
    for (const reply of [-1, 1.5, 2 ** 53, null, 'secret', [1]]) {
      const bad = new ValkeyLockStore(fakeRunner(() => reply));
      const error = await bad.acquire('key-secret', 'owner-secret', 1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValkeyStoreError);
      expect((error as ValkeyStoreError).script).toBe('locks.acquire');
      expect(String(error)).not.toMatch(/secret/);
    }
    await expect(new ValkeyLockStore(fakeRunner(() => 2)).renew('k', 'o', 1)).rejects.toThrow(
      ValkeyStoreError,
    );
    await expect(new ValkeyLockStore(fakeRunner(() => '1')).release('k', 'o')).rejects.toThrow(
      ValkeyStoreError,
    );
  });

  it('releases best-effort before refusing a reply it cannot read, since the script may have taken the lock', async () => {
    const releases: (() => unknown)[] = [
      () => 1,
      () => 0,
      () => 'not a flag',
      () => {
        throw new Error('Connection is closed.');
      },
    ];
    for (const release of releases) {
      const runner = fakeRunner(({ script }) => (script.name === 'locks.acquire' ? 2 ** 53 : release()));
      const error = await new ValkeyLockStore(runner).acquire('k', 'o', 1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValkeyStoreError);
      expect((error as ValkeyStoreError).script).toBe('locks.acquire');
      expect(runner.calls.map(({ script, keys, args }) => [script.name, keys, args])).toEqual([
        ['locks.acquire', ['locks:{k}', 'locks:{k}:fence'], ['o', '1', '60000']],
        ['locks.release', ['locks:{k}'], ['o']],
      ]);
    }
    // A refusal (0) is a readable reply: nothing to release.
    const refused = fakeRunner(() => 0);
    await expect(new ValkeyLockStore(refused).acquire('k', 'o', 1)).resolves.toEqual({ acquired: false });
    expect(refused.calls).toHaveLength(1);
  });

  it('sends a release when acquire() fails on the client, since the script may still take the lock', async () => {
    const timeout = new Error('Command timed out');
    const releases: (() => unknown)[] = [
      () => 1,
      () => 0,
      () => Promise.reject(new Error('Connection is closed.')),
      () => new Promise(() => undefined),
    ];
    for (const release of releases) {
      const runner = fakeRunner(({ script }) =>
        script.name === 'locks.acquire' ? Promise.reject(timeout) : release(),
      );
      // Rethrown as it was, without waiting for the release (the last one never answers).
      await expect(new ValkeyLockStore(runner).acquire('k', 'o', 1)).rejects.toBe(timeout);
      expect(runner.calls.map(({ script, keys, args }) => [script.name, keys, args])).toEqual([
        ['locks.acquire', ['locks:{k}', 'locks:{k}:fence'], ['o', '1', '60000']],
        ['locks.release', ['locks:{k}'], ['o']],
      ]);
    }
  });

  it('refuses bad arguments before reaching the server', async () => {
    const runner = fakeRunner();
    const store = new ValkeyLockStore(runner);
    await expect(store.acquire('k', 'o', 0)).rejects.toThrow(RangeError);
    await expect(store.acquire('k', 'o', 1.5)).rejects.toThrow(RangeError);
    await expect(store.renew('k', 'o', -1)).rejects.toThrow(RangeError);
    await expect(store.acquire('\uD800', 'o', 1)).rejects.toThrow(TypeError);
    await expect(store.release('\uDC00', 'o')).rejects.toThrow(TypeError);
    await expect(store.renew('k', 'o\uD800', 1)).rejects.toThrow(TypeError);
    expect(runner.calls).toEqual([]);
  });

  it('refuses bad options and a missing runner in the constructor', () => {
    expect(() => new ValkeyLockStore(undefined as never)).toThrow(TypeError);
    expect(() => new ValkeyLockStore({} as never)).toThrow(/ScriptRunner/);
    expect(() => new ValkeyLockStore(fakeRunner(), { prefix: '{app}:' })).toThrow(TypeError);
    expect(() => new ValkeyLockStore(fakeRunner(), { fenceRetention: 0 })).toThrow(RangeError);
    expect(() => new ValkeyLockStore(fakeRunner(), { startupCheck: 'yes' as never })).toThrow(TypeError);
    expect(() => new ValkeyLockStore(fakeRunner(), { fenceRetention: 1, prefix: '' })).not.toThrow();
  });
});

describe('ValkeyIdempotencyStore', () => {
  const response = {
    status: 201,
    headers: { location: '/r/1' },
    body: { n: 9007199254740991, s: 'é\u0000' },
  };

  it("sends one key and the documentation's argument order", async () => {
    const runner = fakeRunner(({ script }) => (script.name === 'idempotency.acquire' ? [1] : 1));
    const store = new ValkeyIdempotencyStore(runner, { prefix: 'app:idem:' });
    await expect(store.acquire('scope:k', 'owner', 'fp', 600)).resolves.toEqual({ state: 'acquired' });
    await expect(store.complete('scope:k', 'owner', response, 1800)).resolves.toBe(true);
    await expect(store.extend('scope:k', 'owner', 600)).resolves.toBe(true);
    await expect(store.release('scope:k', 'owner')).resolves.toBe(true);
    expect(runner.calls.map(({ script, keys, args }) => [script.name, keys, args])).toEqual([
      ['idempotency.acquire', ['app:idem:scope:k'], ['fp', 'owner', '600']],
      ['idempotency.complete', ['app:idem:scope:k'], ['owner', JSON.stringify(response), '1800']],
      ['idempotency.extend', ['app:idem:scope:k'], ['owner', '600']],
      ['idempotency.release', ['app:idem:scope:k'], ['owner']],
    ]);
  });

  it('reads a lock and a record, with a new copy of the response every time, bytes or not', async () => {
    const json = JSON.stringify(response);
    const replies: unknown[] = [
      [0, 'in-flight', 'fp-a', null],
      [0, 'in-flight', 'fp-a', false],
      [0n, Buffer.from('completed'), Buffer.from('fp-a'), Buffer.from(json)],
      [0, 'completed', 'fp-a', json],
    ];
    const store = new ValkeyIdempotencyStore(fakeRunner(() => replies.shift()));
    await expect(store.acquire('k', 'o', 'fp', 1)).resolves.toEqual({
      state: 'in-flight',
      fingerprint: 'fp-a',
    });
    await expect(store.acquire('k', 'o', 'fp', 1)).resolves.toEqual({
      state: 'in-flight',
      fingerprint: 'fp-a',
    });
    const first = await store.acquire('k', 'o', 'fp', 1);
    const second = await store.acquire('k', 'o', 'fp', 1);
    expect(first).toEqual({ state: 'completed', fingerprint: 'fp-a', response });
    expect(second).toEqual(first);
    expect((second as { response: unknown }).response).not.toBe((first as { response: unknown }).response);
  });

  it('refuses a record it did not write, failing closed and naming no data', async () => {
    const records: unknown[] = [
      [0, 'done', 'fp', '{}'],
      [0, 'completed', 'fp', null],
      [0, 'completed', 'fp', 'not json: secret'],
      [0, 'completed', 'fp', '"a string"'],
      [0, 'completed', 'fp', '[1]'],
      [0, 'in-flight', null, null],
      [0, null, null, null],
      [2],
      'secret',
      null,
    ];
    for (const record of records) {
      const store = new ValkeyIdempotencyStore(fakeRunner(() => record));
      const error = await store.acquire('key-secret', 'o', 'fp-secret', 1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValkeyStoreError);
      expect((error as ValkeyStoreError).script).toBe('idempotency.acquire');
      expect(String(error)).not.toMatch(/secret/);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('refuses bad arguments before reaching the server', async () => {
    const runner = fakeRunner();
    const store = new ValkeyIdempotencyStore(runner);
    await expect(store.acquire('k', 'o', 'fp', 0)).rejects.toThrow(RangeError);
    await expect(store.complete('k', 'o', response, 1.5)).rejects.toThrow(RangeError);
    await expect(store.extend('k', 'o', Number.NaN)).rejects.toThrow(RangeError);
    await expect(store.acquire('k\uD800', 'o', 'fp', 1)).rejects.toThrow(TypeError);
    await expect(store.acquire('k', 'o', 'fp\uDBFF', 1)).rejects.toThrow(TypeError);
    await expect(store.complete('k', 'o', undefined as never, 1)).rejects.toThrow(TypeError);
    expect(runner.calls).toEqual([]);
    expect(() => new ValkeyIdempotencyStore(fakeRunner(), { prefix: 'a{' })).toThrow(TypeError);
  });

  it("defaults to the documentation's idem: prefix", async () => {
    const runner = fakeRunner(() => 0);
    await new ValkeyIdempotencyStore(runner).release('k', 'o');
    expect(runner.calls[0]!.keys).toEqual(['idem:k']);
  });
});
