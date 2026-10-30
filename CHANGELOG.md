# Changelog

## 0.1.0 (2026-10-30)

### Features

* **glide:** accept a client typed as BaseClient ([b85d132](https://github.com/thekhegay/nestjs-valkey/commit/b85d13256512251ee448f378833040f4421fe72d))
* lock and idempotency stores with their providers ([58a6de0](https://github.com/thekhegay/nestjs-valkey/commit/58a6de0970f75cc87d0eafff27273642b46f1c08))
* script runner core and the glide and ioredis adapters ([a165526](https://github.com/thekhegay/nestjs-valkey/commit/a165526f24521704eba53236c6d98eac4c4b3e38))

### Bug Fixes

* **glide:** send large script arguments as a command, not through invokeScript ([d567ced](https://github.com/thekhegay/nestjs-valkey/commit/d567cede45f216fd4522e1fbd760640ee6a4f370))
* **glide:** send the startup probe to a primary, document glide's warnings ([a061cea](https://github.com/thekhegay/nestjs-valkey/commit/a061ceaf6148dab36874d7621e71adbc1ea8684e))
* **idempotency:** let complete() store the response out of memory ([590e587](https://github.com/thekhegay/nestjs-valkey/commit/590e58711bbba63126ccdf6905c6581dc414714b))
* **ioredis:** refuse a client that returns integer replies as strings ([baa3686](https://github.com/thekhegay/nestjs-valkey/commit/baa368685f892f444a132ebd810a20ca83d86797))
* **ioredis:** refuse a client whose keyPrefix has a brace ([0ad2bd4](https://github.com/thekhegay/nestjs-valkey/commit/0ad2bd423a405befc5add2c5080c80d9b5c9c973))
* **ioredis:** say what @nestjs/locks 0.0.4's storeTimeout bounds, in the warning and the docs ([0bf7728](https://github.com/thekhegay/nestjs-valkey/commit/0bf7728d6f8c8a9060f447fc445c4f1129162868))
* **locks:** check the fence before writing, release on an unreadable reply ([3b4b05c](https://github.com/thekhegay/nestjs-valkey/commit/3b4b05c05e7beb2b9e8b4b39388a98ecea27cfdd))
* **locks:** keep fences for a minute by default, and document what they cost ([7670623](https://github.com/thekhegay/nestjs-valkey/commit/76706238976df53c608c411608bdd443a0ac9734))
* **locks:** release a lock whose acquire() failed on the client ([5120bfc](https://github.com/thekhegay/nestjs-valkey/commit/5120bfc37b9d098ad962759e72dd32889d1d3013))
* **release:** leave every bot out of new contributors ([9e44455](https://github.com/thekhegay/nestjs-valkey/commit/9e444551b45a8a6e0bde6e60d42f830ab6d3f77f))
* **release:** see reverted pairs and late breaking commits in the changelog check ([3b4de96](https://github.com/thekhegay/nestjs-valkey/commit/3b4de9656047165f41ae5440470bb2fa5333a113))
* report a replica in the startup check ([e5f1a94](https://github.com/thekhegay/nestjs-valkey/commit/e5f1a9416f5f0e4dff8c7ee4bacef2f3535a4b16))
