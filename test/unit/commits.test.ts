import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/check-commits.mjs', import.meta.url));
const IDENTITY = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repository whose main has one commit, and a branch with a commit for each subject. */
function branchWith(subjects: string[], merge = false) {
  const dir = mkdtempSync(join(tmpdir(), 'nvk-commits-'));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...IDENTITY },
    }).trim();
  const commit = (subject: string) => {
    writeFileSync(join(dir, `${randomUUID()}.txt`), subject);
    git('add', '-A');
    git('commit', '-q', '-m', subject, '-m', 'A body is no part of the subject.');
  };
  git('init', '-q', '-b', 'main');
  commit('Not conventional, but already on main');
  git('switch', '-q', '-c', 'topic');
  for (const subject of subjects) commit(subject);
  if (merge) {
    git('switch', '-q', 'main');
    commit('chore: main moves on');
    git('switch', '-q', 'topic');
    git('merge', '-q', '--no-ff', '-m', "Merge branch 'main' into topic", 'main');
  }
  const { status, stdout, stderr } = spawnSync(process.execPath, [script, 'main..topic'], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { status, output: `${stdout}${stderr}` };
}

describe('check-commits.mjs', () => {
  it('passes conventional subjects with a lowercase description, and leaves merge commits out', () => {
    const result = branchWith(
      [
        'feat: a feature',
        'fix(locks): a fix with a scope',
        'refactor!: a breaking change',
        'build(deps-dev): bump vitest from 5.0.4 to 5.0.5 in the test group',
        'chore(release): v0.1.0',
        'revert: feat: a feature',
        'docs: `README.md` from a code span',
      ],
      true,
    );
    expect(result).toMatchObject({ status: 0 });
    expect(result.output).toContain('7 commit subject(s) in main..topic, all conventional');
  });

  it('refuses any other subject, naming each', () => {
    const subjects = [
      'Fix renew race when the owner changes',
      'feat: Uppercase description',
      'Revert "feat: a feature"',
      'feature: an unknown type',
      'fix:no space',
      'fix(): an empty scope',
    ];
    const { status, output } = branchWith(['feat: fine', ...subjects]);
    expect(status).toBe(1);
    expect(output).toContain(`${subjects.length} commit subject(s) in main..topic are not conventional`);
    for (const subject of subjects) expect(output).toContain(subject);
    expect(output).not.toContain('feat: fine');
  });
});
