/**
 * Tests for the plain-version helpers the release script depends on.
 *
 * @see ./semver.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVELS, parse, isValid, format, fromTag, compare, maxLevel, rankOf, bump,
} from './semver.mjs';

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

test('parse reads the three parts', () => {
  assert.deepEqual({ ...parse('0.1.0') }, { major: 0, minor: 1, patch: 0 });
  assert.deepEqual({ ...parse('12.34.56') }, { major: 12, minor: 34, patch: 56 });
});

test('parse rejects anything that is not strict MAJOR.MINOR.PATCH', () => {
  for (const bad of ['', '1', '1.2', '1.2.3.4', 'v1.2.3', '01.2.3', '1.02.3', '1.2.03',
    '1.2.3-rc.1', '1.2.3+build', ' 1.2.3', '1.2.3 ', 'a.b.c', '-1.2.3', '99999999999999999999.0.0']) {
    assert.throws(() => parse(bad), TypeError, `expected ${JSON.stringify(bad)} to be rejected`);
    assert.equal(isValid(bad), false);
  }
});

test('parse returns a frozen value', () => {
  assert.ok(Object.isFrozen(parse('1.2.3')));
});

test('format inverts parse for random versions', () => {
  const rand = mulberry32(SEED);
  for (let i = 0; i < 500; i += 1) {
    const text = [0, 0, 0].map(() => Math.floor(rand() * 1000)).join('.');
    assert.equal(format(parse(text)), text, `seed ${SEED}`);
  }
});

test('fromTag requires the v prefix and a valid version', () => {
  assert.deepEqual({ ...fromTag('v0.3.1') }, { major: 0, minor: 3, patch: 1 });
  assert.equal(fromTag('0.3.1'), undefined);
  assert.equal(fromTag('v1'), undefined);
  assert.equal(fromTag('nightly'), undefined);
});

test('compare is numeric, not lexical', () => {
  assert.equal(compare(parse('0.9.0'), parse('0.10.0')), -1);
  assert.equal(compare(parse('2.0.0'), parse('1.99.99')), 1);
  assert.equal(compare(parse('1.2.3'), parse('1.2.3')), 0);
});

test('compare is antisymmetric over random pairs', () => {
  const rand = mulberry32(SEED ^ 0x5eed);
  const pick = () => parse([0, 0, 0].map(() => Math.floor(rand() * 4)).join('.'));
  for (let i = 0; i < 500; i += 1) {
    const a = pick();
    const b = pick();
    assert.equal(compare(a, b), -compare(b, a) || 0, `seed ${SEED}: ${format(a)} vs ${format(b)}`);
  }
});

test('bump resets lower parts', () => {
  assert.equal(format(bump(parse('1.3.7'), 'major')), '2.0.0');
  assert.equal(format(bump(parse('1.3.7'), 'minor')), '1.4.0');
  assert.equal(format(bump(parse('1.3.7'), 'patch')), '1.3.8');
  assert.equal(format(bump(parse('1.3.7'), 'none')), '1.3.7');
});

test('bump rejects unknown levels', () => {
  assert.throws(() => bump(parse('1.0.0'), 'huge'), RangeError);
});

test('every real bump strictly increases the version, and higher levels rank higher', () => {
  const rand = mulberry32(SEED ^ 0xb0b);
  for (let i = 0; i < 500; i += 1) {
    const v = parse([0, 0, 0].map(() => Math.floor(rand() * 50)).join('.'));
    const results = LEVELS.map(level => bump(v, level));
    assert.equal(compare(results[0], v), 0);
    for (let r = 1; r < results.length; r += 1) {
      assert.equal(compare(results[r], results[r - 1]), 1, `seed ${SEED}: ${format(v)} ${LEVELS[r]}`);
    }
  }
});

test('maxLevel and rankOf follow LEVELS order', () => {
  assert.equal(maxLevel('patch', 'minor'), 'minor');
  assert.equal(maxLevel('major', 'none'), 'major');
  assert.equal(maxLevel('none', 'none'), 'none');
  assert.deepEqual(LEVELS.map(rankOf), [0, 1, 2, 3]);
  assert.throws(() => maxLevel('patch', 'mega'), RangeError);
});
