import type { FactoryProvider, InjectionToken, OptionalFactoryDependency } from '@nestjs/common';
import { IdempotencyStorage } from '@nestjs/idempotency';
import type { ScriptRunner } from '../internal/types.js';
import { ValkeyIdempotencyStore, type ValkeyIdempotencyStoreOptions } from './valkey-idempotency.store.js';

/** The store's options and the runner it calls the server through. */
export type ValkeyIdempotencyStoreConfig = ValkeyIdempotencyStoreOptions & { runner: ScriptRunner };

/** The config from a factory, with the providers it needs, such as the application's client. */
export interface ValkeyIdempotencyStoreAsyncConfig {
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  // oxlint-disable-next-line typescript/no-explicit-any -- the shape of Nest's own FactoryProvider
  useFactory: (...deps: any[]) => ValkeyIdempotencyStoreConfig | Promise<ValkeyIdempotencyStoreConfig>;
}

/**
 * A provider that builds a `ValkeyIdempotencyStore` and registers it with `IdempotencyStorage`,
 * in any module that sees `IdempotencyStorage` (`IdempotencyModule` is global by default; with
 * `isGlobal: false`, the module that imports it). The token is the class, for
 * `app.get(ValkeyIdempotencyStore)` and `overrideProvider()`. Nest runs the factory before
 * `IdempotencyModule` locks its registry, and calls the store's `onModuleInit()`, which runs the
 * startup check.
 *
 * ```ts
 * providers: [
 *   valkeyIdempotencyStore({
 *     inject: [VALKEY],
 *     useFactory: (client: GlideClusterClient) => ({ runner: glideRunner(client), prefix: 'app:idem:' }),
 *   }),
 * ]
 * ```
 */
export function valkeyIdempotencyStore(
  config: ValkeyIdempotencyStoreConfig | ValkeyIdempotencyStoreAsyncConfig,
): FactoryProvider<ValkeyIdempotencyStore> {
  if ('useFactory' in config) {
    const { inject = [], useFactory } = config;
    return {
      provide: ValkeyIdempotencyStore,
      inject: [IdempotencyStorage, ...inject],
      useFactory: async (storage: IdempotencyStorage, ...deps: unknown[]) =>
        register(storage, await useFactory(...deps)),
    };
  }
  return {
    provide: ValkeyIdempotencyStore,
    inject: [IdempotencyStorage],
    useFactory: (storage: IdempotencyStorage) => register(storage, config),
  };
}

function register(storage: IdempotencyStorage, config: ValkeyIdempotencyStoreConfig): ValkeyIdempotencyStore {
  if (config == null || typeof config !== 'object') {
    throw new TypeError('valkeyIdempotencyStore(): the factory must return { runner, ...options }');
  }
  const { runner, ...options } = config;
  const store = new ValkeyIdempotencyStore(runner, options);
  storage.registerSource(store);
  return store;
}
