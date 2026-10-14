// What `npm publish` would ship: the built entry points, their types, the README and the license,
// and nothing else (no sources, tests, maps or configuration).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const packed = JSON.parse(execFileSync('pnpm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }));
const files = new Set(packed.files.map((file) => file.path));
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const problems = [];

for (const required of ['package.json', 'README.md', 'LICENSE']) {
  if (!files.has(required)) problems.push(`missing ${required}`);
}
for (const file of files) {
  if (['package.json', 'README.md', 'LICENSE'].includes(file)) continue;
  if (!/^dist\/.+\.(js|d\.ts)$/.test(file)) problems.push(`unexpected ${file}`);
}
for (const [subpath, target] of Object.entries(manifest.exports)) {
  for (const path of typeof target === 'string' ? [target] : Object.values(target)) {
    if (!files.has(path.replace(/^\.\//, '')))
      problems.push(`exports["${subpath}"] points at ${path}, which is not packed`);
  }
}
for (const [subpath, [path]] of Object.entries(manifest.typesVersions['*'])) {
  if (!files.has(path.replace(/^\.\//, '')))
    problems.push(`typesVersions "${subpath}" points at ${path}, which is not packed`);
}

if (problems.length > 0) {
  console.error(`The tarball is wrong:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`The tarball holds ${files.size} files, all expected.`);
