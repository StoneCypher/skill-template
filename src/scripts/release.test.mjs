/**
 * Tests for the release planner: its pure pieces, and end to end against a
 * real throwaway git repository to prove it bumps every manifest together and
 * never commits or tags.
 *
 * @see ./release.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CHANGELOG_HEADER, parseLog, formatEntry, groupCommits, renderSectionBody,
  insertRelease, agreedVersion, planRelease, nextCommands, parseCli, localIsoDate, main,
} from './release.mjs';
import { parseCommit } from './lib/conventional.mjs';
import { MANIFESTS, isMarketplace, versionOf } from './lib/manifests.mjs';

/** Identity for commits in throwaway repos, so tests need no git config. */
const GIT_ENV = Object.freeze({
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
});

/**
 * Runs git in a directory and returns trimmed stdout.
 *
 * @param {string} cwd  Repo directory.
 * @param {...string} args  Git arguments.
 * @returns {string}  Stdout without the trailing newline.
 */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

/**
 * Builds a minimal manifest for a throwaway repo, in the shape its path calls for.
 *
 * @param {string} path        Repo-relative manifest path from MANIFESTS.
 * @param {boolean} versioned  Whether the format carries a version.
 * @param {string} version     The version to give versioned manifests.
 * @returns {object}  The manifest JSON.
 */
function manifestBody(path, versioned, version) {
  if (isMarketplace(path)) return { name: 'demo', plugins: [{ name: 'demo', source: './plugin', version }] };
  if (!versioned) return { name: 'demo' };
  return path === 'package.json' ? { name: 'demo', version, private: true } : { name: 'demo', version };
}

/**
 * Creates a repo with every versioned manifest at one version and a changelog.
 *
 * @param {string} version  Starting version for all manifests.
 * @returns {Promise<string>}  The repo directory; caller removes it.
 */
async function makeRepo(version) {
  const dir = await mkdtemp(join(tmpdir(), 'release-test-'));
  git(dir, 'init', '-q');
  await Promise.all(MANIFESTS.map(async ({ path, versioned }) => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), `${JSON.stringify(manifestBody(path, versioned, version), null, 2)}\n`);
  }));
  await writeFile(join(dir, 'CHANGELOG.md'), `${CHANGELOG_HEADER}\n- A hand-written note.\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'chore: initial');
  return dir;
}

/**
 * Adds an empty commit with a message.
 *
 * @param {string} dir  Repo directory.
 * @param {string} message  Commit message.
 * @returns {void}
 */
function commit(dir, message) {
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
}

/**
 * Reads every versioned manifest's version.
 *
 * @param {string} dir  Repo directory.
 * @returns {Promise<string[]>}  Versions in MANIFESTS order.
 */
async function versionsIn(dir) {
  const versioned = MANIFESTS.filter(m => m.versioned);
  return Promise.all(versioned.map(async ({ path }) =>
    versionOf(path, JSON.parse(await readFile(join(dir, path), 'utf8')))));
}

const logged = (hash, message) => ({ hash, commit: parseCommit(message) });

test('parseLog splits records and keeps multi-line bodies', () => {
  const raw = 'aaa\x1ffeat: x\n\nbody line\n\x1e\nbbb\x1ffix: y\n\x1e\n';
  assert.deepEqual(parseLog(raw), [
    { hash: 'aaa', message: 'feat: x\n\nbody line' },
    { hash: 'bbb', message: 'fix: y' },
  ]);
  assert.deepEqual(parseLog(''), []);
});

test('formatEntry shows scope, subject, short hash and breaking notes', () => {
  assert.equal(formatEntry(logged('a1b2c3d4e5', 'feat(skills): add docket')), '- **skills:** add docket (a1b2c3d)');
  assert.equal(formatEntry(logged('a1b2c3d4e5', 'fix: x\n\nBREAKING CHANGE: y moved')),
    '- x (a1b2c3d)\n  - y moved');
});

test('groupCommits orders groups, puts breaking commits only under Breaking, drops chores', () => {
  const groups = groupCommits([
    logged('0000004', 'docs: readme'),
    logged('0000003', 'feat!: new layout'),
    logged('0000002', 'fix: second fix'),
    logged('0000001', 'feat: first'),
    { hash: '0000000', commit: undefined },
  ]);
  assert.deepEqual(groups, [
    { title: 'Breaking changes', entries: ['- new layout (0000003)'] },
    { title: 'Added', entries: ['- first (0000001)'] },
    { title: 'Fixed', entries: ['- second fix (0000002)'] },
  ]);
});

test('renderSectionBody puts carried notes first and has a fallback', () => {
  assert.equal(renderSectionBody([], ''), '- No user-facing changes.');
  assert.equal(renderSectionBody([{ title: 'Fixed', entries: ['- x'] }], '\n- note\n'),
    '- note\n\n### Fixed\n\n- x');
});

test('insertRelease moves Unreleased notes into a new section above older releases', () => {
  const before = '# Changelog\n\n## [Unreleased]\n\n- hand note\n\n## [0.1.0] - 2026-01-01\n\n- old\n';
  const after = insertRelease(before, '0.2.0', '2026-09-26', [{ title: 'Added', entries: ['- x (abcdef0)'] }]);
  assert.equal(after,
    '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-09-26\n\n- hand note\n\n### Added\n\n- x (abcdef0)\n\n'
    + '## [0.1.0] - 2026-01-01\n\n- old\n');
});

test('insertRelease refuses a duplicate version and a missing Unreleased heading', () => {
  assert.throws(() => insertRelease('## [Unreleased]\n\n## [0.2.0] - x\n', '0.2.0', 'd', []), /already has a section/);
  assert.throws(() => insertRelease('# Changelog\n', '0.2.0', 'd', []), /no "## \[Unreleased\]"/);
  assert.doesNotThrow(() => insertRelease('## [Unreleased]\n\n## [0.2.01] - x\n', '0.2.0', 'd', []));
});

test('agreedVersion demands one valid version', () => {
  assert.equal(agreedVersion([{ path: 'a', version: '0.1.0' }, { path: 'b', version: '0.1.0' }]), '0.1.0');
  assert.throws(() => agreedVersion([{ path: 'a', version: '0.1.0' }, { path: 'b', version: '0.6.1' }]),
    /a: 0\.1\.0\n {2}b: 0\.6\.1/);
  assert.throws(() => agreedVersion([{ path: 'a', version: undefined }]), /\(none\)/);
});

test('planRelease: first release ships the manifest version as-is', () => {
  assert.deepEqual(planRelease({ current: '0.1.0', lastTag: undefined, logged: [logged('a', 'feat: x')], forced: undefined }),
    { from: '0.1.0', to: '0.1.0', level: 'as-is', releasable: true });
});

test('planRelease: commits decide once the current version is tagged', () => {
  const plan = planRelease({ current: '0.1.0', lastTag: 'v0.1.0', logged: [logged('a', 'fix: x')], forced: undefined });
  assert.deepEqual(plan, { from: '0.1.0', to: '0.1.1', level: 'patch', releasable: true });
  const none = planRelease({ current: '0.1.0', lastTag: 'v0.1.0', logged: [logged('a', 'docs: x')], forced: undefined });
  assert.equal(none.releasable, false);
});

test('planRelease: forced versions must move forward', () => {
  assert.equal(planRelease({ current: '0.4.0', lastTag: 'v0.4.0', logged: [], forced: '1.0.0' }).to, '1.0.0');
  assert.throws(() => planRelease({ current: '0.4.0', lastTag: 'v0.4.0', logged: [], forced: '0.4.0' }), /not above/);
  assert.throws(() => planRelease({ current: '0.4.0', lastTag: 'v0.3.0', logged: [], forced: '0.3.5' }), /below/);
  assert.throws(() => planRelease({ current: '0.4.0', lastTag: 'v0.4.0', logged: [], forced: 'v1.0.0' }), TypeError);
});

test('planRelease: manifests behind the last tag is an error', () => {
  assert.throws(() => planRelease({ current: '0.1.0', lastTag: 'v0.2.0', logged: [], forced: undefined }), /behind/);
});

test('nextCommands tags only after the PR merges and never uses compound commands', () => {
  const commands = nextCommands('0.2.0', ['CHANGELOG.md', 'package.json'], '2026-09-26');
  assert.equal(commands[0], 'git switch -c release_26-09-26_v0-2-0');
  const tagAt = commands.indexOf('git tag -a v0.2.0 -m "v0.2.0"');
  const mergeNote = commands.findIndex(c => c.startsWith('# open a PR'));
  assert.ok(mergeNote >= 0 && tagAt > mergeNote);
  assert.ok(commands.every(c => !/&&|\|\||;|\|/.test(c)));
});

test('localIsoDate uses the local calendar day, zero-padded', () => {
  assert.equal(localIsoDate(new Date(2026, 8, 26, 23, 30)), '2026-09-26');
  assert.equal(localIsoDate(new Date(2026, 0, 5, 0, 0)), '2026-01-05');
});

test('parseCli defaults to a dry run and rejects contradictions and unknown flags', () => {
  assert.deepEqual(parseCli([]), { write: false, version: undefined, repo: undefined, help: false });
  assert.deepEqual(parseCli(['--write', '--version', '1.0.0', '--repo', 'x']),
    { write: true, version: '1.0.0', repo: 'x', help: false });
  assert.throws(() => parseCli(['--write', '--dry-run']), /choose one/);
  assert.throws(() => parseCli(['--tag']));
});

test('end to end: --write bumps every manifest and the changelog, and creates no commit or tag', async t => {
  t.mock.method(console, 'log', () => {});
  const dir = await makeRepo('0.1.0');
  try {
    git(dir, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
    commit(dir, 'feat(skills): add docket');
    commit(dir, 'fix: handle empty folder');
    commit(dir, 'docs: explain install');
    const headBefore = git(dir, 'rev-parse', 'HEAD');

    assert.equal(await main([], dir), 0);
    assert.deepEqual(await versionsIn(dir), ['0.1.0', '0.1.0', '0.1.0', '0.1.0'], 'dry run must not write');

    assert.equal(await main(['--write'], dir), 0);
    assert.deepEqual(await versionsIn(dir), ['0.2.0', '0.2.0', '0.2.0', '0.2.0']);
    const changelog = await readFile(join(dir, 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /## \[Unreleased\]\n\n## \[0\.2\.0\] - \d{4}-\d{2}-\d{2}\n\n- A hand-written note\.\n\n### Added\n\n- \*\*skills:\*\* add docket \([0-9a-f]{7}\)\n\n### Fixed\n\n- handle empty folder/);
    assert.doesNotMatch(changelog, /explain install/);

    assert.equal(git(dir, 'rev-parse', 'HEAD'), headBefore, 'must not commit');
    assert.equal(git(dir, 'tag', '--list'), 'v0.1.0', 'must not tag');

    await assert.rejects(main(['--write'], dir), /already has a section for 0\.2\.0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('end to end: an untagged repo releases its starting version as-is (located via --repo)', async t => {
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(line));
  const dir = await makeRepo('0.1.0');
  try {
    commit(dir, 'feat: first feature');
    assert.equal(await main(['--repo', dir], tmpdir()), 0);
    assert.match(logs.join('\n'), /Next version {5}: 0\.1\.0 \(as-is\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('end to end: disagreeing manifests stop the release before anything is written', async () => {
  const dir = await makeRepo('0.1.0');
  try {
    await writeFile(join(dir, 'plugin/.codex-plugin/plugin.json'), '{ "name": "demo", "version": "0.0.9" }\n');
    await assert.rejects(main(['--write'], dir), /must agree/);
    assert.deepEqual(await versionsIn(dir), ['0.1.0', '0.1.0', '0.0.9', '0.1.0']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
