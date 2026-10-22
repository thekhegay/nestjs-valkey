/**
 * Every commit a pull request brings has a conventional subject with a
 * lowercase description, as AGENTS.md asks:
 *
 *   node scripts/check-commits.mjs [<base>..<head>]   (default origin/main..HEAD)
 *
 * main takes rebase merges only, so each commit lands as it is and the pull
 * request title, which pr-title.yml checks, never becomes one. The changelog
 * is written from these subjects: a commit that is not conventional would ship
 * with no line, and the release check could not tell. Merge commits are left
 * out; the types are pr-title.yml's.
 */
import { execFileSync } from 'node:child_process';

const TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'style', 'test', 'build', 'ci', 'chore', 'revert'];
const SUBJECT = new RegExp(`^(${TYPES.join('|')})(\\([^()]+\\))?!?: [^A-Z\\s]`);

const range = process.argv[2] ?? 'origin/main..HEAD';
const commits = execFileSync('git', ['log', '--no-merges', '--format=%h %s', range], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const refused = commits.filter((line) => !SUBJECT.test(line.slice(line.indexOf(' ') + 1)));
if (refused.length > 0) {
  console.error(
    [
      `${refused.length} commit subject(s) in ${range} are not conventional, with a lowercase description:`,
      ...refused.map((line) => `  ${line}`),
      `Reword them as <type>[(scope)][!]: <lowercase description>, <type> one of ${TYPES.join(', ')}.`,
    ].join('\n'),
  );
  process.exit(1);
}
console.log(`${commits.length} commit subject(s) in ${range}, all conventional`);
