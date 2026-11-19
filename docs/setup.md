# Setup

## Module systems

The package is ESM-only, like the official ones, and needs the same Node (20.19 or later). A CommonJS application loads it through `require()` of ES modules, as it loads `@nestjs/locks`, which on the 22 line takes 22.12 or later: 22.0 to 22.11 refuse it with `ERR_REQUIRE_ESM` unless started with `--experimental-require-module`. Node 22.12 prints one `ExperimentalWarning` for that at startup, whichever ES module comes first, and 20.19 and 22.13+ only under `--trace-require-module`.

Tools that load CommonJS need the same. Jest as Nest's starter sets it up (ts-jest) refuses an ES module under `node_modules` until it may transform it, which takes `allowJs: true` in the tsconfig ts-jest reads and, in the Jest config:

```json
{
  "transformIgnorePatterns": ["/node_modules/(?!(@nestjs/locks|@nestjs/idempotency|nestjs-valkey)/)"]
}
```

TypeScript resolves the imports with `module` set to `nodenext` (TypeScript 5.8 or later) or `commonjs`; `node16` refuses them with TS1479.

## Options

`prefix` (default `locks:` and `idem:`; give every application on a shared server its own, inside its ACL key pattern), `fenceRetention` for the lock store (ms, default a minute, see [Fencing tokens](fencing-tokens.md)) and `startupCheck` (see [Startup check](server.md#startup-check)).

## Outside Nest

Outside Nest, or as a class in your own code:

```ts
const store = new ValkeyLockStore(glideRunner(client), { prefix: 'billing:locks:' });
await store.checkServer();

@Injectable()
export class AppLockStore extends ValkeyLockStore {
  constructor(@Inject(REDIS) redis: Redis, storage: LocksStorage) {
    super(ioredisRunner(redis), { prefix: 'billing:locks:' });
    storage.registerSource(this);
  }
}
```
