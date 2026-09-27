/**
 * Tests the manifest registry and its version helpers, including a
 * randomized property that withVersion and versionOf agree.
 *
 * @see ./manifests.mjs
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFESTS, versionOf, withVersion, readManifest, writeManifest } from './manifests.mjs';

/** A scratch directory under build/, removed after the suite. */
const SCRATCH = fileURLToPath(new URL(`../../../build/test-manifests-${process.pid}/`, import.meta.url));

after(() => rm(SCRATCH, { recursive: true, force: true }));

describe('MANIFESTS', () => {
  test('is frozen, has unique forward-slash paths, and includes package.json', () => {
    assert.ok(Object.isFrozen(MANIFESTS));
    const paths = MANIFESTS.map(m => m.path);
    assert.equal(new Set(paths).size, paths.length);
    assert.ok(paths.every(p => !p.includes('\\')));
    assert.ok(paths.includes('package.json'));
  });

  test('every manifest in the list exists in this repo and parses', async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    for (const { path } of MANIFESTS) {
      assert.equal(typeof (await readManifest(root, path)), 'object', path);
    }
  });
});

describe('versionOf', () => {
  test('reads a plain manifest version', () => {
    assert.equal(versionOf('.codex-plugin/plugin.json', { version: '0.1.0' }), '0.1.0');
  });

  test('reads the marketplace entry named after the marketplace', () => {
    const json = { name: 'docket', plugins: [{ name: 'other', version: '9.9.9' }, { name: 'docket', version: '0.2.0' }] };
    assert.equal(versionOf('.claude-plugin/marketplace.json', json), '0.2.0');
  });

  test('is undefined when absent, including malformed marketplaces', () => {
    assert.equal(versionOf('package.json', {}), undefined);
    assert.equal(versionOf('.claude-plugin/marketplace.json', { name: 'x' }), undefined);
    assert.equal(versionOf('.claude-plugin/marketplace.json', { name: 'x', plugins: [null, { name: 'y', version: '1.0.0' }] }), undefined);
    assert.equal(versionOf('package.json', null), undefined);
  });
});

describe('withVersion', () => {
  test('replaces a plain version without mutating the input', () => {
    const input = { name: 'x', version: '0.1.0' };
    assert.deepEqual(withVersion('package.json', input, '0.2.0'), { name: 'x', version: '0.2.0' });
    assert.deepEqual(input, { name: 'x', version: '0.1.0' });
  });

  test('replaces only the matching marketplace entry, without mutating', () => {
    const input = { name: 'x', plugins: [{ name: 'y', version: '5.0.0' }, { name: 'x', version: '0.1.0', source: './' }] };
    const out = withVersion('.claude-plugin/marketplace.json', input, '0.2.0');
    assert.deepEqual(out.plugins, [{ name: 'y', version: '5.0.0' }, { name: 'x', version: '0.2.0', source: './' }]);
    assert.equal(input.plugins[1].version, '0.1.0');
  });

  test('throws when the marketplace has no entry to version', () => {
    assert.throws(() => withVersion('.claude-plugin/marketplace.json', { name: 'x', plugins: [{ name: 'y' }] }, '1.0.0'), /no plugin entry named "x"/);
    assert.throws(() => withVersion('.claude-plugin/marketplace.json', { name: 'x' }, '1.0.0'), /no plugin entry named "x"/);
  });
});

describe('readManifest / writeManifest', () => {
  test('write then read round-trips, as two-space JSON with a trailing newline', async () => {
    await mkdir(SCRATCH, { recursive: true });
    const json = { name: 'x', version: '1.2.3', nested: { a: [1, 2] } };
    await writeManifest(SCRATCH, 'plugin.json', json);
    assert.equal(await readFile(join(SCRATCH, 'plugin.json'), 'utf8'), '{\n  "name": "x",\n  "version": "1.2.3",\n  "nested": {\n    "a": [\n      1,\n      2\n    ]\n  }\n}\n');
    assert.deepEqual(await readManifest(SCRATCH, 'plugin.json'), json);
  });

  test('readManifest throws SyntaxError on invalid JSON', async () => {
    await mkdir(SCRATCH, { recursive: true });
    await writeFile(join(SCRATCH, 'bad.json'), '{ "a": 1, }');
    await assert.rejects(readManifest(SCRATCH, 'bad.json'), SyntaxError);
  });
});

describe('stochastic', () => {
  const SEED = Number(process.env.MANIFESTS_SEED ?? Date.now() % 2 ** 31);
  let a = SEED >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = n => Math.floor(rand() * n);
  const version = () => `${int(20)}.${int(20)}.${int(200)}`;

  test(`versionOf(withVersion(m, v)) === v, other fields untouched (seed ${SEED})`, () => {
    for (let run = 0; run < 500; run += 1) {
      for (const { path } of MANIFESTS) {
        const name = `n${int(5)}`;
        const others = Array.from({ length: int(3) }, (_, i) => ({ name: `other${i}`, version: version() }));
        const json = path.endsWith('marketplace.json')
          ? { name, owner: { name: 'o' }, plugins: [...others, { name, version: version() }].sort(() => rand() - 0.5) }
          : { name, version: version(), extra: int(100) };
        const before = structuredClone(json);
        const v = version();
        const out = withVersion(path, json, v);
        assert.equal(versionOf(path, out), v, `seed ${SEED} ${path}`);
        assert.deepEqual(json, before, `seed ${SEED}: input mutated`);
        const strip = j => (path.endsWith('marketplace.json')
          ? { ...j, plugins: j.plugins.map(p => (p.name === name ? { ...p, version: '' } : p)) }
          : { ...j, version: '' });
        assert.deepEqual(strip(out), strip(json), `seed ${SEED}: other fields changed`);
      }
    }
  });
});
