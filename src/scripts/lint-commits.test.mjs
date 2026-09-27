/**
 * Tests for the PR commit linter, pure pieces and against a real git repo.
 *
 * @see ./lint-commits.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRecords, findOffenders, formatReport, main } from './lint-commits.mjs';

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

test('parseRecords takes the first line of each message', () => {
  assert.deepEqual(parseRecords('aaa\x1ffix: x\r\n\r\nbody\x1e\nbbb\x1f  wip  \x1e\n'), [
    { hash: 'aaa', header: 'fix: x' },
    { hash: 'bbb', header: 'wip' },
  ]);
  assert.deepEqual(parseRecords(''), []);
});

test('findOffenders keeps only invalid headers, with reasons', () => {
  const offenders = findOffenders([
    { hash: 'a', header: 'feat: ok' },
    { hash: 'b', header: 'wip' },
    { hash: 'c', header: 'feature: nope' },
  ]);
  assert.deepEqual(offenders.map(o => o.hash), ['b', 'c']);
  assert.match(offenders[1].problems[0], /unknown type "feature"/);
});

test('formatReport summarises clean and dirty ranges', () => {
  assert.equal(formatReport('a..b', 1, []), '1 commit in a..b; all have valid Conventional Commits headers.');
  const dirty = formatReport('a..b', 2, [{ hash: '0123456789', header: 'wip', problems: ['bad'] }]);
  assert.match(dirty, /^2 commits in a\.\.b; 1 invalid:\n {2}0123456 "wip"\n {4}- bad/);
});

test('end to end: exit 0 for a clean range, 1 listing offenders, 2 for a bad range', async t => {
  const errors = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', line => errors.push(line));
  const dir = await mkdtemp(join(tmpdir(), 'lint-commits-test-'));
  try {
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'Initial commit');
    const base = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'feat: good one');
    assert.equal(main([`${base}..HEAD`], dir), 0);

    git(dir, 'commit', '-q', '--allow-empty', '-m', 'Update stuff');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'fixup! feat: good one');
    assert.equal(main([`${base}..HEAD`], dir), 1);
    const report = errors.join('\n');
    assert.match(report, /3 commits in .*; 2 invalid/);
    assert.match(report, /"Update stuff"/);
    assert.match(report, /"fixup! feat: good one"/);
    assert.doesNotMatch(report, /"feat: good one"/);

    assert.equal(main(['nope..HEAD'], dir), 2);
    assert.equal(main([], dir), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
