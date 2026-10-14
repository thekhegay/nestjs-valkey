import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        // Against real servers: the addresses come from the environment (docker/servers.env for
        // the ones `pnpm servers:up` starts), and a suite whose server is not named is skipped.
        test: {
          name: 'servers',
          include: ['test/{contract,cluster,behaviour,noscript,server,compat,nest}/**/*.test.ts'],
          setupFiles: ['test/support/setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // The contract cases run concurrently; their expiry cases wait in real time.
          maxConcurrency: 32,
        },
      },
      {
        // Packs the package and installs it into a Nest 11 CommonJS and a Nest 12 ESM application.
        test: {
          name: 'consumers',
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
