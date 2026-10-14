import 'reflect-metadata';
import { Inject, Injectable, Logger, Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IdempotencyModule, IdempotencyStorage } from '@nestjs/idempotency';
import { LocksModule, LocksStorage } from '@nestjs/locks';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ValkeyIdempotencyStore, valkeyIdempotencyStore } from '../../src/idempotency/index.js';
import type { ScriptRunner } from '../../src/index.js';
import { ValkeyLockStore, valkeyLockStore } from '../../src/locks/index.js';
import { HEALTHY, fakeRunner } from '../support/fake-runner.js';

const RUNNER = Symbol('RUNNER');

async function boot(imports: unknown[], providers: unknown[] = []): Promise<INestApplicationContext> {
  @Module({ imports: imports as never, providers: providers as never })
  class AppModule {}
  return NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
}

describe('valkeyLockStore() and valkeyIdempotencyStore()', () => {
  let app: INestApplicationContext | undefined;
  let warn: MockInstance;
  let log: MockInstance;
  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.stubEnv('NODE_ENV', 'production');
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('register both stores before the registries lock, pass the production guard, and run the check', async () => {
    const runner = fakeRunner(() => HEALTHY);
    app = await boot(
      [LocksModule.forRoot(), IdempotencyModule.forRoot()],
      [valkeyLockStore({ runner, prefix: 'app:locks:' }), valkeyIdempotencyStore({ runner })],
    );
    expect(app.get(LocksStorage).source).toBe(app.get(ValkeyLockStore));
    expect(app.get(IdempotencyStorage).source).toBe(app.get(ValkeyIdempotencyStore));
    expect(app.get(ValkeyLockStore)).toBeInstanceOf(ValkeyLockStore);
    expect(runner.calls.map((call) => call.script.name)).toEqual(['server.probe', 'server.probe']);
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain('LocksStorage: ValkeyLockStore');
    expect(lines).toContain('IdempotencyStorage: ValkeyIdempotencyStore');
    expect(warn).not.toHaveBeenCalled();
  });

  it('take the config from a factory with injected providers', async () => {
    const runner = fakeRunner(() => HEALTHY);
    const factory = vi.fn(async (r: ScriptRunner, missing: unknown) => ({
      runner: r,
      startupCheck: 'strict' as const,
      missing,
    }));
    app = await boot(
      [LocksModule.forRoot(), IdempotencyModule.forRoot()],
      [
        { provide: RUNNER, useValue: runner },
        valkeyLockStore({ inject: [RUNNER, { token: 'absent', optional: true }], useFactory: factory }),
        valkeyIdempotencyStore({ inject: [RUNNER], useFactory: (r: ScriptRunner) => ({ runner: r }) }),
      ],
    );
    expect(factory).toHaveBeenCalledWith(runner, undefined);
    expect(app.get(LocksStorage).source).toBeInstanceOf(ValkeyLockStore);
    expect(app.get(IdempotencyStorage).source).toBeInstanceOf(ValkeyIdempotencyStore);
  });

  it('work in a feature module that imports the official modules with isGlobal: false', async () => {
    const runner = fakeRunner(() => HEALTHY);
    @Module({
      imports: [LocksModule.forRoot({ isGlobal: false }), IdempotencyModule.forRoot({ isGlobal: false })],
      providers: [valkeyLockStore({ runner }), valkeyIdempotencyStore({ runner })],
    })
    class FeatureModule {}
    app = await boot([FeatureModule]);
    expect(app.select(FeatureModule).get(LocksStorage).source).toBeInstanceOf(ValkeyLockStore);
    expect(app.select(FeatureModule).get(IdempotencyStorage).source).toBeInstanceOf(ValkeyIdempotencyStore);
  });

  it("fail startup when the lock store's user may not run TIME, under the default check", async () => {
    const runner = fakeRunner(() => [
      "ERR ACL failure in script: no permissions to run the 'time' command",
      'noeviction',
      null,
    ]);
    await expect(boot([LocksModule.forRoot()], [valkeyLockStore({ runner })])).rejects.toThrow(
      /grant \+time/,
    );
  });

  it('start with one warning per store under warn, and fail under strict, on another eviction policy', async () => {
    const runner = fakeRunner(() => [null, 'volatile-lru', null]);
    app = await boot(
      [LocksModule.forRoot(), IdempotencyModule.forRoot()],
      [valkeyLockStore({ runner }), valkeyIdempotencyStore({ runner })],
    );
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringMatching(/volatile-lru, not noeviction: the server may evict locks/),
      expect.stringMatching(/volatile-lru, not noeviction: the server may evict idempotency records/),
    ]);
    await expect(
      boot([IdempotencyModule.forRoot()], [valkeyIdempotencyStore({ runner, startupCheck: 'strict' })]),
    ).rejects.toThrow(/ValkeyIdempotencyStore: maxmemory-policy is volatile-lru/);
  });

  it('skip the check entirely with startupCheck: false', async () => {
    const runner = fakeRunner(() => {
      throw new Error('must not be called');
    });
    app = await boot([LocksModule.forRoot()], [valkeyLockStore({ runner, startupCheck: false })]);
    expect(runner.calls).toEqual([]);
  });

  it('refuse a factory that returns no config', async () => {
    await expect(
      boot([LocksModule.forRoot()], [valkeyLockStore({ useFactory: () => undefined as never })]),
    ).rejects.toThrow(/must return \{ runner/);
  });

  it("leave the class open for the documentation's recipe: an @Injectable() subclass that registers itself", async () => {
    @Injectable()
    class AppLockStore extends ValkeyLockStore {
      constructor(@Inject(RUNNER) runner: ScriptRunner, @Inject(LocksStorage) storage: LocksStorage) {
        super(runner, { prefix: 'matchmaker:locks:' });
        storage.registerSource(this);
      }
    }
    const runner = fakeRunner(() => HEALTHY);
    app = await boot([LocksModule.forRoot()], [{ provide: RUNNER, useValue: runner }, AppLockStore]);
    expect(app.get(LocksStorage).source).toBeInstanceOf(AppLockStore);
    expect(log.mock.calls.map((call) => String(call[0]))).toContain('LocksStorage: AppLockStore');
    expect(runner.calls.map((call) => call.script.name)).toEqual(['server.probe']);
  });
});
