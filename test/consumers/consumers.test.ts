import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { missing } from '../support/servers.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const fixtures = join(root, 'test/consumers/fixtures');

/**
 * The Node binaries the applications run on: CONSUMER_NODES="22.12=/path/to/node,26=/path/..."
 * (CI sets one per supported line), or the one running the tests.
 */
const nodes = (process.env.CONSUMER_NODES ?? `${process.versions.node}=${process.execPath}`)
  .split(',')
  .map((entry) => {
    const [label, path] = entry.split('=');
    return { label: label!, path: path! };
  });

async function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  try {
    return await exec(command, args, { ...options, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    throw new Error(
      `${command} ${args.join(' ')} failed in ${options.cwd}\n${stdout ?? ''}\n${stderr ?? ''}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * Node 22.12 (and 23.0 to 23.4) prints one ExperimentalWarning the first time a CommonJS module
 * outside node_modules loads an ES module through require(), for @nestjs/locks as for this
 * package; 20.19 and 22.13 print it only under --trace-require-module.
 */
const REQUIRE_ESM_WARNING = new RegExp(
  [
    String.raw`\(node:\d+\) ExperimentalWarning: CommonJS module .+ is loading ES Module .+ using require\(\)\.\n`,
    String.raw`Support for loading ES Module in require\(\) is an experimental feature and might change at any time\n`,
    String.raw`\(Use .node --trace-warnings \.\.\.. to show where the warning was created\)\n`,
  ].join(''),
  'g',
);

const versions = new Map<string, Promise<string>>();
function versionOf(node: string): Promise<string> {
  let version = versions.get(node);
  if (!version) {
    version = exec(node, ['-p', 'process.versions.node']).then(({ stdout }) => stdout.trim());
    versions.set(node, version);
  }
  return version;
}

/**
 * `stderr` without the require(esm) warning, which a CommonJS application must print exactly once
 * on a Node that prints it by default, and nothing else must ever print.
 */
async function withoutRequireEsmWarning(node: string, stderr: string, commonjs: boolean): Promise<string> {
  const [major, minor] = (await versionOf(node)).split('.').map(Number) as [number, number];
  const byDefault = (major === 22 && minor === 12) || (major === 23 && minor < 5);
  const printed = stderr.match(REQUIRE_ESM_WARNING)?.length ?? 0;
  expect(printed, `require(esm) warnings on Node ${major}.${minor}`).toBe(commonjs && byDefault ? 1 : 0);
  return stderr.replace(REQUIRE_ESM_WARNING, '');
}

const skip = missing('VALKEY_URL');

describe(
  `the packed package in real applications${skip ? ` (skipped: ${skip})` : ''}`,
  { skip: skip !== false },
  () => {
    let work: string;
    let tarball: string;

    beforeAll(async () => {
      // Outside the repository, so nothing resolves from its node_modules, and installed from the
      // tarball, a copy rather than a link, so the application has one @nestjs/locks.
      work = await mkdtemp(join(tmpdir(), 'nvk-consumers-'));
      const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
        version: string;
      };
      await run('pnpm', ['pack', '--pack-destination', work], { cwd: root });
      tarball = join(work, `nestjs-valkey-${version}.tgz`);
    });
    afterAll(async () => {
      if (work) await rm(work, { recursive: true, force: true });
    });

    async function install(fixture: string): Promise<string> {
      const dir = join(work, fixture);
      await cp(join(fixtures, fixture), dir, { recursive: true });
      await cp(join(fixtures, 'app.ts'), join(dir, 'src/main.ts'));
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      manifest.dependencies['nestjs-valkey'] = `file:${tarball}`;
      await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
      // No lockfile, so whatever the ranges resolve to today; none of it needs an install script.
      await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
        cwd: dir,
      });
      return dir;
    }

    async function start(dir: string, node: string, locksClient: 'glide' | 'ioredis', commonjs: boolean) {
      const { stdout, stderr } = await run(node, ['dist/main.js'], {
        cwd: dir,
        env: { ...process.env, NODE_ENV: 'production', LOCKS_CLIENT: locksClient },
      });
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
      expect(line, `no result in:\n${stdout}\n${stderr}`).toBeDefined();
      expect(await withoutRequireEsmWarning(node, stderr, commonjs)).not.toMatch(/ERR_|Error:|Warning/);
      return { result: JSON.parse(line!.slice('RESULT '.length)), stdout };
    }

    function expectWorking(result: Record<string, unknown>, stdout: string, nest: string, node: string) {
      expect(result).toMatchObject({
        lockSource: 'ValkeyLockStore',
        idempotencySource: 'ValkeyIdempotencyStore',
        sameLockStore: true,
        sameIdempotencyStore: true,
        storeError: true,
        first: { status: 201, body: { id: 'ch_1', amount: 42 } },
        retry: { status: 201, body: { id: 'ch_1', amount: 42 } },
        calls: 1,
      });
      expect(result.nest).toMatch(new RegExp(`^${nest}\\.`));
      expect(String(result.node).split('.')[0]).toBe(node.split('.')[0]);
      expect(result.token).toBeGreaterThan(2 ** 50);
      expect(stdout).toContain('LocksStorage: ValkeyLockStore');
      expect(stdout).toContain('IdempotencyStorage: ValkeyIdempotencyStore');
    }

    describe('a Nest 11 CommonJS application (TypeScript 5.9)', () => {
      let dir: string;
      beforeAll(async () => {
        dir = await install('nest11-cjs');
        // node10 resolution, which reads no "exports": the subpaths resolve through typesVersions.
        await run(join(dir, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], { cwd: dir });
      });

      it('also type-checks under NodeNext resolution, which reads "exports"', async () => {
        await run(join(dir, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.nodenext.json'], { cwd: dir });
      });

      it('also type-checks with TypeScript 6.0 on the same "module": "commonjs" tsconfig', async () => {
        await run(
          process.execPath,
          [join(dir, 'node_modules/typescript6/bin/tsc'), '-p', 'tsconfig.json', '--noEmit'],
          {
            cwd: dir,
          },
        );
      });

      it('needs typesVersions for node10 resolution (the control: without it, TS2307)', async () => {
        const path = join(dir, 'node_modules/nestjs-valkey/package.json');
        const original = await readFile(path, 'utf8');
        const { typesVersions: _, ...stripped } = JSON.parse(original);
        await writeFile(path, JSON.stringify(stripped));
        try {
          const failed = await run(join(dir, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json', '--noEmit'], {
            cwd: dir,
          }).catch((error: Error) => error);
          expect(String(failed)).toMatch(/TS2307: Cannot find module 'nestjs-valkey\/locks'/);
        } finally {
          await writeFile(path, original);
        }
      });

      for (const node of nodes) {
        it(`requires every entry point through require(esm) on Node ${node.label}`, async () => {
          const { stdout, stderr } = await run(node.path, ['require-all.cjs'], { cwd: dir });
          expect(await withoutRequireEsmWarning(node.path, stderr, true)).toBe('');
          const loaded = JSON.parse(stdout.slice(stdout.indexOf('REQUIRED ') + 'REQUIRED '.length));
          expect(loaded).toMatchObject({
            'nestjs-valkey': ['ValkeyStoreError'],
            'nestjs-valkey/locks': ['ValkeyLockStore', 'valkeyLockStore'],
            'nestjs-valkey/idempotency': ['ValkeyIdempotencyStore', 'valkeyIdempotencyStore'],
            'nestjs-valkey/glide': ['glideRunner'],
            'nestjs-valkey/ioredis': ['ioredisRunner'],
          });
        });

        for (const locksClient of ['glide', 'ioredis'] as const) {
          it(`starts in production and serves locks and an idempotent route on Node ${node.label} (locks on ${locksClient})`, async () => {
            const { result, stdout } = await start(dir, node.path, locksClient, true);
            expectWorking(result, stdout, '11', node.label);
          });
        }
      }
    });

    describe('a Nest 12 ESM application (TypeScript 6.0, NodeNext)', () => {
      let dir: string;
      beforeAll(async () => {
        dir = await install('nest12-esm');
        await run(join(dir, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], { cwd: dir });
      });

      for (const node of nodes) {
        for (const locksClient of ['glide', 'ioredis'] as const) {
          it(`starts in production and serves locks and an idempotent route on Node ${node.label} (locks on ${locksClient})`, async () => {
            const { result, stdout } = await start(dir, node.path, locksClient, false);
            expectWorking(result, stdout, '12', node.label);
          });
        }
      }
    });
  },
);
