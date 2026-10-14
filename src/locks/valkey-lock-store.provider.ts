import type { FactoryProvider, InjectionToken, OptionalFactoryDependency } from '@nestjs/common';
import { LocksStorage } from '@nestjs/locks';
import type { ScriptRunner } from '../internal/types.js';
import { ValkeyLockStore, type ValkeyLockStoreOptions } from './valkey-lock.store.js';

/** The store's options and the runner it calls the server through. */
export type ValkeyLockStoreConfig = ValkeyLockStoreOptions & { runner: ScriptRunner };

/** The config from a factory, with the providers it needs, such as the application's client. */
export interface ValkeyLockStoreAsyncConfig {
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  // oxlint-disable-next-line typescript/no-explicit-any -- the shape of Nest's own FactoryProvider
  useFactory: (...deps: any[]) => ValkeyLockStoreConfig | Promise<ValkeyLockStoreConfig>;
}

/**
 * A provider that builds a `ValkeyLockStore` and registers it with `LocksStorage`, in any module
 * that sees `LocksStorage` (`LocksModule` is global by default; with `isGlobal: false`, the module
 * that imports it). The token is the class, for `app.get(ValkeyLockStore)` and
 * `overrideProvider()`. Nest runs the factory before `LocksModule` locks its registry, and calls
 * the store's `onModuleInit()`, which runs the startup check.
 *
 * ```ts
 * providers: [
 *   valkeyLockStore({
 *     inject: [VALKEY],
 *     useFactory: (client: GlideClusterClient) => ({ runner: glideRunner(client), prefix: 'app:locks:' }),
 *   }),
 * ]
 * ```
 */
export function valkeyLockStore(
  config: ValkeyLockStoreConfig | ValkeyLockStoreAsyncConfig,
): FactoryProvider<ValkeyLockStore> {
  if ('useFactory' in config) {
    const { inject = [], useFactory } = config;
    return {
      provide: ValkeyLockStore,
      inject: [LocksStorage, ...inject],
      useFactory: async (storage: LocksStorage, ...deps: unknown[]) =>
        register(storage, await useFactory(...deps)),
    };
  }
  return {
    provide: ValkeyLockStore,
    inject: [LocksStorage],
    useFactory: (storage: LocksStorage) => register(storage, config),
  };
}

function register(storage: LocksStorage, config: ValkeyLockStoreConfig): ValkeyLockStore {
  if (config == null || typeof config !== 'object') {
    throw new TypeError('valkeyLockStore(): the factory must return { runner, ...options }');
  }
  const { runner, ...options } = config;
  const store = new ValkeyLockStore(runner, options);
  storage.registerSource(store);
  return store;
}
