import { Logger } from '@nestjs/common';
import { BaseClient, Decoder, GlideClient, GlideClusterClient, Script } from '@valkey/valkey-glide';
import { Cluster, Redis } from 'ioredis';
import { Cluster as Ioredis5Cluster, Redis as Ioredis5 } from 'ioredis5';
import { Cluster as IovalkeyCluster, Valkey } from 'iovalkey';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { glideRunner } from '../../src/glide/index.js';
import { ioredisRunner, type IoredisLike } from '../../src/ioredis/index.js';
import { defineScript } from '../../src/internal/script.js';

const script = defineScript('test.script', 'return KEYS[1]');

describe('glideRunner()', () => {
  it('refuses anything but a client of the copy of glide it resolves, naming two copies', () => {
    expect(() => glideRunner({ invokeScript: async () => 1 } as never)).toThrow(TypeError);
    expect(() => glideRunner({} as never)).toThrow(/two copies of\s+@valkey\/valkey-glide/);
  });

  it('invokes one shared Script per source, with copies of keys and args, decoded as strings', async () => {
    const invokeScript = vi.fn(async () => 'reply');
    const client = Object.assign(Object.create(BaseClient.prototype), { invokeScript });
    const other = Object.assign(Object.create(BaseClient.prototype), { invokeScript });
    const keys = ['k'];
    const args = ['a', '1'];
    await expect(glideRunner(client).run(script, keys, args)).resolves.toBe('reply');
    await glideRunner(other).run(script, keys, args);
    const [first, second] = invokeScript.mock.calls as unknown as [
      unknown,
      { keys: string[]; args: string[]; decoder: Decoder },
    ][];
    expect(first![0]).toBe(second![0]);
    expect(first![1]).toEqual({ keys: ['k'], args: ['a', '1'], decoder: Decoder.String });
    expect(first![1].keys).not.toBe(keys);
    expect((first![0] as { getHash(): string }).getHash()).toBe(script.sha1);
  });

  it('sends a keyless call (the startup probe) to a primary of a cluster, where invokeScript would pick any node', async () => {
    const invokeScript = vi.fn(async () => 'keyed');
    const invokeScriptWithRoute = vi.fn(async () => 'routed');
    const cluster = Object.assign(Object.create(GlideClusterClient.prototype), {
      invokeScript,
      invokeScriptWithRoute,
    });
    const runner = glideRunner(cluster);
    await expect(runner.run(script, [], ['a'])).resolves.toBe('routed');
    expect(invokeScriptWithRoute).toHaveBeenCalledWith(expect.anything(), {
      args: ['a'],
      decoder: Decoder.String,
      route: { type: 'primarySlotId', id: 0 },
    });
    await expect(runner.run(script, ['k'], ['a'])).resolves.toBe('keyed');
    expect(invokeScript).toHaveBeenCalledWith(expect.anything(), {
      keys: ['k'],
      args: ['a'],
      decoder: Decoder.String,
    });
    expect(invokeScriptWithRoute).toHaveBeenCalledTimes(1);

    // A standalone client has one primary to send it to.
    const standalone = Object.assign(Object.create(GlideClient.prototype), { invokeScript });
    invokeScript.mockClear();
    await glideRunner(standalone).run(script, [], []);
    expect(invokeScript).toHaveBeenCalledWith(expect.anything(), {
      keys: [],
      args: [],
      decoder: Decoder.String,
    });
  });

  describe('a call with 64 KiB of arguments or more', () => {
    const large = ['o', 'x'.repeat(64 * 1024 - 2), '1'];
    const clients = (customCommand: (...args: unknown[]) => Promise<unknown>) => {
      return [GlideClient, GlideClusterClient].map((Client) => {
        const invokeScript = vi.fn(async () => 'from invokeScript');
        return {
          client: Object.assign(Object.create(Client.prototype), { invokeScript, customCommand }),
          invokeScript,
        };
      });
    };

    it('goes as EVALSHA through customCommand, decoded as strings, and smaller ones do not', async () => {
      const customCommand = vi.fn(async () => 'from customCommand');
      for (const { client, invokeScript } of clients(customCommand)) {
        customCommand.mockClear();
        const runner = glideRunner(client);
        await expect(runner.run(script, ['k'], large)).resolves.toBe('from customCommand');
        expect(customCommand).toHaveBeenCalledWith(['EVALSHA', script.sha1, '1', 'k', ...large], {
          decoder: Decoder.String,
        });
        expect(invokeScript).not.toHaveBeenCalled();
        await expect(runner.run(script, ['k'], large.slice(0, 2))).resolves.toBe('from invokeScript');
        expect(customCommand).toHaveBeenCalledTimes(1);
      }
    });

    it('goes through invokeScript, which loads the script, on NOSCRIPT only', async () => {
      const noScript = new Error(
        'An error was signalled by the server: - NoScriptError: No matching script.',
      );
      const customCommand = vi.fn(async () => Promise.reject(noScript));
      for (const { client, invokeScript } of clients(customCommand)) {
        await expect(glideRunner(client).run(script, ['k'], large)).resolves.toBe('from invokeScript');
        expect(invokeScript).toHaveBeenCalledWith(expect.anything(), {
          keys: ['k'],
          args: large,
          decoder: Decoder.String,
        });
        expect((invokeScript.mock.calls[0] as unknown[])[0]).toBeInstanceOf(Script);
      }

      const timeout = new Error('Request timed out');
      for (const failure of [timeout, 'NoScriptError']) {
        const failing = vi.fn(async () => Promise.reject(failure));
        for (const { client, invokeScript } of clients(failing)) {
          await expect(glideRunner(client).run(script, ['k'], large)).rejects.toBe(failure);
          expect(invokeScript).not.toHaveBeenCalled();
        }
      }
    });
  });
});

describe('ioredisRunner()', () => {
  let warn: MockInstance;
  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  // @nestjs/locks bounds its store calls from 0.0.4 (storeTimeout); the command stays in the client.
  const noTimeout = /no commandTimeout.*0\.0\.3 waits.*storeTimeout.*stays queued/;

  it('warns once per runner when the client has no commandTimeout, for Redis and Cluster of every flavour', async () => {
    const clients = [
      new Redis({ lazyConnect: true }),
      new Ioredis5({ lazyConnect: true }),
      new Valkey({ lazyConnect: true }),
      new Cluster([{ host: '127.0.0.1', port: 1 }], { lazyConnect: true }),
      new Ioredis5Cluster([{ host: '127.0.0.1', port: 1 }], { lazyConnect: true }),
      new IovalkeyCluster([{ host: '127.0.0.1', port: 1 }], { lazyConnect: true }),
      // A commandTimeout on the cluster's own options is not one its connections use.
      new Cluster([{ host: '127.0.0.1', port: 1 }], { lazyConnect: true, redisOptions: {} }),
    ];
    for (const client of clients) {
      warn.mockClear();
      ioredisRunner(client);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(noTimeout);
      client.disconnect();
    }
  });

  it("does not warn when the client has one, or has no options at all (the docs' RedisEval)", () => {
    const clients: IoredisLike[] = [
      new Redis({ lazyConnect: true, commandTimeout: 2000 }),
      new Valkey({ lazyConnect: true, commandTimeout: 2000 }),
      new Cluster([{ host: '127.0.0.1', port: 1 }], {
        lazyConnect: true,
        redisOptions: { commandTimeout: 2000 },
      }),
      { eval: async () => 1 },
    ];
    for (const client of clients) ioredisRunner(client);
    expect(warn).not.toHaveBeenCalled();
    for (const client of clients) (client as { disconnect?(): void }).disconnect?.();
  });

  it('refuses a client with stringNumbers, for Redis and Cluster of every flavour and for a duplicate', () => {
    const at = [{ host: '127.0.0.1', port: 1 }];
    const redisOptions = { commandTimeout: 2000, stringNumbers: true };
    const parent = new Redis({ lazyConnect: true, stringNumbers: true });
    const clients = [
      new Redis({ lazyConnect: true, ...redisOptions }),
      new Ioredis5({ lazyConnect: true, ...redisOptions }),
      new Valkey({ lazyConnect: true, ...redisOptions }),
      new Cluster(at, { lazyConnect: true, redisOptions }),
      new Ioredis5Cluster(at, { lazyConnect: true, redisOptions }),
      new IovalkeyCluster(at, { lazyConnect: true, redisOptions }),
      // duplicate() copies the option from the client it is made from.
      parent.duplicate({ commandTimeout: 2000 }),
    ];
    for (const client of clients) {
      expect(() => ioredisRunner(client)).toThrow(TypeError);
      expect(() => ioredisRunner(client)).toThrow(/stringNumbers/);
      client.disconnect();
    }
    const fixed = parent.duplicate({ commandTimeout: 2000, stringNumbers: false });
    expect(() => ioredisRunner(fixed)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    fixed.disconnect();
    parent.disconnect();
  });

  it('refuses a keyPrefix with a brace, for Redis and Cluster of every flavour and for a duplicate', () => {
    const at = [{ host: '127.0.0.1', port: 1 }];
    const commandTimeout = 2000;
    for (const keyPrefix of ['{app}:', 'app:{}:', 'app:{', 'app}:']) {
      const parent = new Redis({ lazyConnect: true, commandTimeout, keyPrefix });
      const clients = [
        parent,
        new Ioredis5({ lazyConnect: true, commandTimeout, keyPrefix }),
        new Valkey({ lazyConnect: true, commandTimeout, keyPrefix }),
        new Cluster(at, { lazyConnect: true, keyPrefix, redisOptions: { commandTimeout } }),
        new Ioredis5Cluster(at, { lazyConnect: true, keyPrefix, redisOptions: { commandTimeout } }),
        new IovalkeyCluster(at, { lazyConnect: true, keyPrefix, redisOptions: { commandTimeout } }),
        // A Cluster applies a keyPrefix given in redisOptions too.
        new Cluster(at, { lazyConnect: true, redisOptions: { commandTimeout, keyPrefix } }),
        // duplicate() copies it from the client it is made from.
        parent.duplicate(),
      ];
      for (const client of clients) {
        expect(() => ioredisRunner(client), keyPrefix).toThrow(TypeError);
        expect(() => ioredisRunner(client), keyPrefix).toThrow(/keyPrefix must not contain/);
        client.disconnect();
      }
    }
    const plain = [
      new Redis({ lazyConnect: true, commandTimeout, keyPrefix: 'app:' }),
      new Cluster(at, { lazyConnect: true, keyPrefix: 'app:', redisOptions: { commandTimeout } }),
    ];
    for (const client of plain) {
      expect(() => ioredisRunner(client)).not.toThrow();
      client.disconnect();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('sends EVALSHA with every key counted, and EVAL with the source on NOSCRIPT only', async () => {
    const evalsha = vi.fn(async () => {
      throw Object.assign(new Error('NOSCRIPT No matching script. Please use EVAL.'), { name: 'ReplyError' });
    });
    const evalFn = vi.fn(async () => 'from eval');
    const runner = ioredisRunner({ eval: evalFn, evalsha });
    await expect(runner.run(script, ['k1', 'k2'], ['a'])).resolves.toBe('from eval');
    expect(evalsha).toHaveBeenCalledWith(script.sha1, 2, 'k1', 'k2', 'a');
    expect(evalFn).toHaveBeenCalledWith(script.source, 2, 'k1', 'k2', 'a');

    evalsha.mockImplementationOnce(async () => 'cached' as never);
    evalFn.mockClear();
    await expect(runner.run(script, ['k'], [])).resolves.toBe('cached');
    expect(evalFn).not.toHaveBeenCalled();
  });

  it('passes every other error through untouched, and never retries it', async () => {
    const failure = new Error('OOM command not allowed when used memory > maxmemory');
    const evalFn = vi.fn();
    const runner = ioredisRunner({ eval: evalFn, evalsha: async () => Promise.reject(failure) });
    await expect(runner.run(script, ['k'], [])).rejects.toBe(failure);
    const notAnError = ioredisRunner({ eval: evalFn, evalsha: async () => Promise.reject('NOSCRIPT') });
    await expect(notAnError.run(script, ['k'], [])).rejects.toBe('NOSCRIPT');
    expect(evalFn).not.toHaveBeenCalled();
  });

  it('uses EVAL alone for a client without evalsha', async () => {
    const evalFn = vi.fn(async () => 0);
    await ioredisRunner({ eval: evalFn }).run(script, [], ['x']);
    expect(evalFn).toHaveBeenCalledWith(script.source, 0, 'x');
  });

  it('refuses something that is not a client', () => {
    expect(() => ioredisRunner({} as never)).toThrow(TypeError);
    expect(() => ioredisRunner(null as never)).toThrow(TypeError);
  });
});
