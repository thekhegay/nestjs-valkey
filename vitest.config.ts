import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          sequence: { groupOrder: 0 },
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        // Against real servers: the addresses come from the environment (docker/servers.env for
        // the ones `pnpm servers:up` starts), and a suite whose server is not named is skipped.
        test: {
          name: 'servers',
          sequence: { groupOrder: 0 },
          include: ['test/{contract,cluster,behaviour,server,compat,nest}/**/*.test.ts'],
          setupFiles: ['test/support/setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // The contract cases run concurrently; their expiry cases wait in real time.
          maxConcurrency: 32,
        },
      },
      {
        // Suites that disturb the shared servers (SCRIPT FLUSH on every node) run alone, after the
        // others: a flush between glide's SCRIPT LOAD and its EVALSHA would fail an unrelated call.
        test: {
          name: 'servers-exclusive',
          include: ['test/noscript/**/*.test.ts'],
          setupFiles: ['test/support/setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        // Opt-in: CLUSTER FAILOVER under load (NVK_CHAOS=1, `pnpm test:chaos`).
        test: {
          name: 'chaos',
          sequence: { groupOrder: 3 },
          include: ['test/chaos/**/*.test.ts'],
          setupFiles: ['test/support/setup.ts'],
          testTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        // Packs the package and installs it into a Nest 11 CommonJS and a Nest 12 ESM application.
        test: {
          name: 'consumers',
          sequence: { groupOrder: 2 },
          include: ['test/consumers/**/*.test.ts'],
          setupFiles: ['test/support/setup.ts'],
          testTimeout: 300_000,
          hookTimeout: 900_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
