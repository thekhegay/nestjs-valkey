import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const IDENTITY = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A repository of its own with scripts/release.mjs, the package's node_modules and a package.json
 * at `version`, its first commit tagged `v<version>` unless that is 0.0.0.
 */
function sandbox(version: string) {
  const dir = mkdtempSync(join(tmpdir(), 'nvk-release-'));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'scripts'));
  cpSync(join(root, 'scripts/release.mjs'), join(dir, 'scripts/release.mjs'));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  const repository = { type: 'git', url: 'git+https://github.com/example/sandbox.git' };
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'sandbox', version, repository }, null, 2));
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');

  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, ...IDENTITY } },
    ).trim();
  const commit = (subject: string, body?: string) => {
    writeFileSync(join(dir, 'change.txt'), randomUUID());
    git('add', '-A');
    git('commit', '-q', '-m', subject, ...(body ? ['-m', body] : []));
    return git('rev-parse', 'HEAD');
  };
  const release = (...args: string[]) => {
    const { status, stdout, stderr } = spawnSync(process.execPath, ['scripts/release.mjs', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
    return { status, output: `${stdout}${stderr}` };
  };
  /** Cuts the release: prepare, then commit what it wrote, as the release pull request does. */
  const cut = (bump: string, landedAfterTheCut?: () => void) => {
    expect(release('prepare', `--bump=${bump}`).status).toBe(0);
    const cutVersion = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string })
      .version;
    if (landedAfterTheCut) {
      git('stash', '-q');
      landedAfterTheCut();
      git('stash', 'pop', '-q');
    }
    git('add', '-A');
    git('commit', '-q', '-m', `chore(release): v${cutVersion}`);
    return readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  };

  git('init', '-q', '-b', 'main');
  commit('chore: start');
  if (version !== '0.0.0') git('tag', `v${version}`);
  return { git, commit, release, cut };
}

describe('release.mjs check', () => {
  it('passes a release cut from what main holds', () => {
    const repo = sandbox('0.1.0');
    const fix = repo.commit('fix: a fix');
    expect(repo.cut('patch')).toContain(fix);
    expect(repo.release('check')).toMatchObject({ status: 0 });
  });

  it('refuses a feat or fix merged after the cut', () => {
    const repo = sandbox('0.1.0');
    repo.commit('fix: a fix');
    let late = '';
    repo.cut('patch', () => (late = repo.commit('feat: merged after the cut')));
    const { status, output } = repo.release('check');
    expect(status).toBe(1);
    expect(output).toContain(`${late.slice(0, 7)} feat: merged after the cut`);
    expect(output).toMatch(/revert the release commit \(revert: chore\(release\): v0\.1\.1\)/);
  });

  // conventional-changelog lists these under their type and BREAKING CHANGES, and a patch cut
  // refuses them, but nothing caught one merged after the cut.
  for (const [subject, body] of [
    ['refactor!: a breaking refactor'],
    ['build!: raise the node floor'],
    ['chore: a breaking chore', 'BREAKING CHANGE: callers have to change'],
  ] as [string, string?][]) {
    it(`refuses a breaking commit of any type merged after the cut (${subject})`, () => {
      const repo = sandbox('0.1.0');
      repo.commit('fix: a fix');
      let late = '';
      repo.cut('patch', () => (late = repo.commit(subject, body)));
      const { status, output } = repo.release('check');
      expect(status).toBe(1);
      expect(output).toContain(`${late.slice(0, 7)} ${subject}`);
    });

    it(`passes a breaking commit of any type cut with a minor bump (${subject})`, () => {
      const repo = sandbox('0.1.0');
      const breaking = repo.commit(subject, body);
      expect(repo.cut('minor')).toContain(breaking);
      expect(repo.release('check')).toMatchObject({ status: 0 });
    });
  }

  // The body git revert and GitHub's Revert button write: conventional-changelog drops both
  // commits, and the check asked for the reverted one forever.
  for (const style of ['git revert', 'revert: with the body']) {
    for (const version of ['0.0.0', '0.1.0']) {
      it(`leaves out a commit reverted before the cut, with its revert (${style}, from ${version})`, () => {
        const repo = sandbox(version);
        const feat = repo.commit('feat: a feature that did not last');
        if (style === 'git revert') repo.git('revert', '--no-edit', feat);
        else repo.commit('revert: feat: a feature that did not last', `This reverts commit ${feat}.`);
        const fix = repo.commit('fix: a fix that stays');
        const section = repo.cut('minor');
        expect(section).not.toContain(feat);
        expect(section).toContain(fix);
        expect(repo.release('check')).toMatchObject({ status: 0 });
      });
    }
  }

  it('still asks for a revert whose commit shipped in an earlier release', () => {
    const repo = sandbox('0.1.0');
    const feat = repo.commit('feat: shipped in 0.2.0');
    repo.cut('minor');
    repo.git('tag', 'v0.2.0');
    repo.cut('patch', () => repo.commit('revert: feat: shipped in 0.2.0', `This reverts commit ${feat}.`));
    const { status, output } = repo.release('check');
    expect(status).toBe(1);
    expect(output).toMatch(/misses 1 commit\(s\)[\s\S]+revert: feat: shipped in 0\.2\.0/);
  });
});
