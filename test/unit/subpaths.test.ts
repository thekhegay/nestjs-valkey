import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The modules a source file loads at run time: every `import` and `export ... from` but the
 * `import type` and `export type` ones, which compile away. One with only inline `type` names
 * (`import { type A } from`) counts: under verbatimModuleSyntax it still loads the module.
 */
function runtimeImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  for (const [, keyword, typeOnly, specifier] of source.matchAll(
    /^(import|export)\s+(type\s+)?(?:[^;'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
  )) {
    if (keyword && !typeOnly) specifiers.push(specifier!);
  }
  return specifiers;
}

/** The packages `entry` loads, through every relative import it reaches. */
function packagesOf(entry: string): string[] {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of runtimeImports(file)) {
      if (specifier.startsWith('.')) visit(join(dirname(file), specifier.replace(/\.js$/, '.ts')));
      else
        packages.add(
          specifier
            .split('/')
            .slice(0, specifier.startsWith('@') ? 2 : 1)
            .join('/'),
        );
    }
  };
  visit(join(root, entry));
  return [...packages].toSorted();
}

// Every subpath export loads only its own peer (AGENTS.md): an application that installs
// @nestjs/locks alone must be able to load nestjs-valkey/locks, and only src/glide loads glide.
const expected: Record<string, string[]> = {
  '.': [],
  './locks': ['@nestjs/common', '@nestjs/locks', 'node:crypto'],
  './idempotency': ['@nestjs/common', '@nestjs/idempotency', 'node:crypto'],
  './glide': ['@valkey/valkey-glide'],
  './ioredis': ['@nestjs/common'],
};

describe('the subpath exports', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    exports: Record<string, string | { default: string }>;
  };
  const entries = Object.entries(manifest.exports).flatMap(([subpath, target]) =>
    typeof target === 'string' ? [] : [[subpath, target.default] as const],
  );

  it('are the ones this test knows', () => {
    expect(entries.map(([subpath]) => subpath).toSorted()).toEqual(Object.keys(expected).toSorted());
  });

  for (const [subpath, target] of entries) {
    it(`${subpath} loads only its own peer`, () => {
      const source = relative(root, join(root, target))
        .replace(/^dist\//, 'src/')
        .replace(/\.js$/, '.ts');
      expect(packagesOf(source)).toEqual(expected[subpath]);
    });
  }

  it('reads multi-line and type-only statements as the compiler does', () => {
    const lines = runtimeImports(join(root, 'src/locks/index.ts'));
    expect(lines).toContain('./valkey-lock-store.provider.js');
    expect(lines).toContain('./valkey-lock.store.js');
    // `import type` from @nestjs/common and @nestjs/locks, values from local modules only.
    const store = runtimeImports(join(root, 'src/locks/valkey-lock.store.ts'));
    expect(store).not.toContain('@nestjs/common');
    expect(store).not.toContain('@nestjs/locks');
    expect(store).toContain('../internal/server-check.js');
  });
});
