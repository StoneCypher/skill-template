/**
 * Tests for Conventional Commits parsing, header linting and bump computation.
 *
 * @see ./conventional.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMIT_TYPES, MAX_HEADER_LENGTH, parseHeader, parseCommit, breakingNotesOf,
  validateHeader, levelOf, bumpLevel, adjustForPreMajor, nextVersion,
} from './conventional.mjs';
import { parse, format, compare, rankOf } from './semver.mjs';

/**
 * Returns a deterministic PRNG so a failing stochastic run can be replayed.
 *
 * @param {number} seed  Any 32-bit integer.
 * @returns {() => number}  Uniform floats in [0, 1).
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env.TEST_SEED ?? Date.now()) >>> 0;

/**
 * Builds a random commit message, sometimes non-conventional, sometimes breaking.
 *
 * @param {() => number} rand  PRNG from {@link mulberry32}.
 * @returns {string}  A raw commit message.
 */
function randomMessage(rand) {
  const roll = rand();
  if (roll < 0.1) return 'Merge whatever into wherever';
  const type = COMMIT_TYPES[Math.floor(rand() * COMMIT_TYPES.length)];
  const scope = rand() < 0.3 ? '(skills)' : '';
  const bang = rand() < 0.08 ? '!' : '';
  const footer = rand() < 0.05 ? '\n\nBREAKING CHANGE: something moved' : '';
  return `${type}${scope}${bang}: change ${Math.floor(rand() * 1e6)}${footer}`;
}

/**
 * Builds a random version with small parts, including major 0.
 *
 * @param {() => number} rand  PRNG from {@link mulberry32}.
 * @returns {import('./semver.mjs').Version}  A parsed version.
 */
function randomVersion(rand) {
  return parse([0, 0, 0].map(() => Math.floor(rand() * 5)).join('.'));
}

test('parseHeader reads type, scope, bang and subject', () => {
  assert.deepEqual({ ...parseHeader('feat(cli)!: drop --legacy') },
    { type: 'feat', scope: 'cli', bang: true, subject: 'drop --legacy' });
  assert.deepEqual({ ...parseHeader('fix: x') },
    { type: 'fix', scope: undefined, bang: false, subject: 'x' });
});

test('parseHeader rejects malformed headers', () => {
  for (const bad of ['Update README', 'feat:no space', 'feat:  ', 'feat(): empty scope',
    'feat(a)(b): two scopes', 'feat !: space before bang', ': no type', 'fe at: space', '']) {
    assert.equal(parseHeader(bad), undefined, JSON.stringify(bad));
  }
});

test('breakingNotesOf finds both footer spellings and ignores lowercase', () => {
  const body = 'Body text.\n\nBREAKING CHANGE: one\nBREAKING-CHANGE: two\nbreaking change: not me';
  assert.deepEqual([...breakingNotesOf(body)], ['one', 'two']);
  assert.deepEqual([...breakingNotesOf('nothing here')], []);
});

test('parseCommit marks breaking from bang or footer, and tolerates CRLF', () => {
  assert.equal(parseCommit('feat!: x').breaking, true);
  assert.equal(parseCommit('refactor: x\r\n\r\nBREAKING-CHANGE: load() is async').breaking, true);
  assert.deepEqual([...parseCommit('refactor: x\r\n\r\nBREAKING-CHANGE: load() is async').breakingNotes],
    ['load() is async']);
  assert.equal(parseCommit('feat: x\n\nmentions BREAKING CHANGE: mid-line only').breaking, false);
  assert.equal(parseCommit('Initial commit'), undefined);
});

test('parseCommit does not treat a breaking footer in the header as a body footer', () => {
  assert.equal(parseCommit('BREAKING CHANGE: not a conventional header'), undefined);
});

test('validateHeader accepts every allowed type, with and without scope and bang', () => {
  for (const type of COMMIT_TYPES) {
    assert.deepEqual([...validateHeader(`${type}: subject`)], []);
    assert.deepEqual([...validateHeader(`${type}(scope)!: subject`)], []);
  }
});

test('validateHeader names the problem', () => {
  assert.match(validateHeader('Feat: add thing')[0], /unknown type "Feat"/);
  assert.match(validateHeader('feature: add thing')[0], /unknown type "feature"/);
  assert.match(validateHeader('Update README')[0], /not in "type\(scope\)!: subject" form/);
  assert.match(validateHeader('fixup! fix: earlier')[0], /not in/);
  assert.match(validateHeader(undefined)[0], /not in/);
  const long = `fix: ${'x'.repeat(MAX_HEADER_LENGTH)}`;
  assert.deepEqual(validateHeader(long).length, 1);
  assert.match(validateHeader(long)[0], /limit is 100/);
  assert.deepEqual([...validateHeader(`fix: ${'x'.repeat(MAX_HEADER_LENGTH - 5)}`)], []);
});

test('levelOf applies the bump table', () => {
  assert.equal(levelOf(parseCommit('docs!: rewrite')), 'major');
  assert.equal(levelOf(parseCommit('feat: a')), 'minor');
  for (const t of ['fix', 'hotfix', 'perf']) assert.equal(levelOf(parseCommit(`${t}: a`)), 'patch');
  for (const t of ['docs', 'refactor', 'test', 'chore', 'ci', 'build', 'style', 'release', 'revert']) {
    assert.equal(levelOf(parseCommit(`${t}: a`)), 'none', t);
  }
});

test('bumpLevel takes the maximum and skips unparseable commits', () => {
  assert.equal(bumpLevel([]), 'none');
  assert.equal(bumpLevel(['fix: a', 'feat: b', 'docs: c'].map(parseCommit)), 'minor');
  assert.equal(bumpLevel(['Merge x', 'chore: y'].map(parseCommit)), 'none');
});

test('adjustForPreMajor demotes breaking to minor only at major 0', () => {
  assert.equal(adjustForPreMajor('major', parse('0.4.1')), 'minor');
  assert.equal(adjustForPreMajor('major', parse('1.4.1')), 'major');
  assert.equal(adjustForPreMajor('minor', parse('0.4.1')), 'minor');
  assert.equal(adjustForPreMajor('patch', parse('0.4.1')), 'patch');
  assert.throws(() => adjustForPreMajor('huge', parse('0.4.1')), RangeError);
});

test('nextVersion computes concrete versions', () => {
  const at = (v, msgs) => format(nextVersion(parse(v), msgs.map(parseCommit)).version);
  assert.equal(at('0.1.0', ['feat!: new layout']), '0.2.0');
  assert.equal(at('0.1.0', ['feat: x', 'fix: y']), '0.2.0');
  assert.equal(at('0.1.3', ['fix: y']), '0.1.4');
  assert.equal(at('0.1.3', ['docs: y']), '0.1.3');
  assert.equal(at('1.2.3', ['fix: y\n\nBREAKING CHANGE: z']), '2.0.0');
  assert.equal(at('1.2.3', ['feat: y']), '1.3.0');
});

test('stochastic: next version never goes backward and a real level always moves it', () => {
  const rand = mulberry32(SEED);
  for (let i = 0; i < 1000; i += 1) {
    const current = randomVersion(rand);
    const commits = Array.from({ length: Math.floor(rand() * 8) }, () => parseCommit(randomMessage(rand)));
    const { level, version } = nextVersion(current, commits);
    const cmp = compare(version, current);
    assert.equal(cmp, level === 'none' ? 0 : 1, `seed ${SEED} iter ${i}`);
  }
});

test('stochastic: adding commits never lowers the result (monotonicity)', () => {
  const rand = mulberry32(SEED ^ 0xa11);
  for (let i = 0; i < 1000; i += 1) {
    const current = randomVersion(rand);
    const base = Array.from({ length: Math.floor(rand() * 6) }, () => parseCommit(randomMessage(rand)));
    const extra = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => parseCommit(randomMessage(rand)));
    const before = nextVersion(current, base);
    const after = nextVersion(current, [...base, ...extra]);
    assert.ok(compare(after.version, before.version) >= 0, `seed ${SEED} iter ${i}`);
    assert.ok(rankOf(after.level) >= rankOf(before.level), `seed ${SEED} iter ${i}`);
  }
});

test('stochastic: order of commits does not matter', () => {
  const rand = mulberry32(SEED ^ 0x0dd);
  for (let i = 0; i < 500; i += 1) {
    const current = randomVersion(rand);
    const commits = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => parseCommit(randomMessage(rand)));
    const shuffled = commits.map(c => [rand(), c]).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    assert.deepEqual(nextVersion(current, shuffled), nextVersion(current, commits), `seed ${SEED}`);
  }
});

test('stochastic: while major is 0, no commit set reaches 1.0.0', () => {
  const rand = mulberry32(SEED ^ 0x0ff);
  for (let i = 0; i < 1000; i += 1) {
    const current = parse(`0.${Math.floor(rand() * 20)}.${Math.floor(rand() * 20)}`);
    const commits = Array.from({ length: Math.floor(rand() * 10) }, () => parseCommit(randomMessage(rand)));
    assert.equal(nextVersion(current, commits).version.major, 0, `seed ${SEED} iter ${i}`);
  }
});

test('stochastic: the level equals the largest single-commit level', () => {
  const rand = mulberry32(SEED ^ 0xbee);
  for (let i = 0; i < 500; i += 1) {
    const commits = Array.from({ length: Math.floor(rand() * 8) }, () => parseCommit(randomMessage(rand)));
    const singles = commits.filter(Boolean).map(c => rankOf(bumpLevel([c])));
    assert.equal(rankOf(bumpLevel(commits)), Math.max(0, ...singles), `seed ${SEED}`);
  }
});
