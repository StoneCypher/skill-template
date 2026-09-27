/**
 * Tests for init-skill: argument handling, repo choice, and full runs on a scratch copy of the template.
 *
 * Scratch copies live under build/ (git-ignored) and are removed afterwards.
 *
 * @see ./init-skill.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { main, parseCli, chooseRepo, planManifests, skillDir, INITIAL_VERSION } from './init-skill.mjs';
import { MANIFESTS, versionOf } from './lib/manifests.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(ROOT, 'build', `init-skill-test-${randomBytes(4).toString('hex')}`);

/** The template files a run touches; copied into each scratch repo. */
const TEMPLATE_FILES = ['README.md', 'package.json', 'skills/skill-template/SKILL.md', ...MANIFESTS.map(m => m.path)];

/**
 * Whether this repo is still the template. Full runs copy the template's own
 * files, which are renamed once init-skill has run, so those tests then skip.
 */
const IS_TEMPLATE = JSON.parse(await readFile(join(ROOT, '.claude-plugin/plugin.json'), 'utf8')).name === 'skill-template';

/** An origin reader that reports no remote, so runs never shell out to git. */
const noOrigin = () => undefined;

/**
 * Makes a fresh scratch copy of the template, with a CHANGELOG and bumped versions to prove the resets.
 *
 * @param {string} label  Subfolder name, unique per test.
 * @returns {Promise<string>}  Absolute path of the scratch repo.
 */
async function scratchRepo(label) {
  const dir = join(SCRATCH, label);
  for (const file of new Set(TEMPLATE_FILES)) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await cp(join(ROOT, file), join(dir, file));
  }
  await writeFile(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [0.4.0]\n- template work\n', 'utf8');
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  await writeFile(pkgPath, JSON.stringify({ ...pkg, version: '0.4.0' }), 'utf8');
  return dir;
}

/**
 * Reads and parses a JSON file from a scratch repo.
 *
 * @param {string} dir   Scratch repo.
 * @param {string} path  Repo-relative path.
 * @returns {Promise<any>}  Parsed JSON.
 */
const json = async (dir, path) => JSON.parse(await readFile(join(dir, path), 'utf8'));

before(() => mkdir(SCRATCH, { recursive: true }));
after(() => rm(SCRATCH, { recursive: true, force: true }));

describe('parseCli', () => {
  test('reads name, description and flags in any order', () => {
    assert.deepEqual(parseCli(['--force', 'docket', 'Tracks tasks.', '--repo', 'a/b']),
      { name: 'docket', description: 'Tracks tasks.', repo: 'a/b', force: true, help: false });
  });

  test('rejects an unquoted description and unknown flags', () => {
    assert.throws(() => parseCli(['docket', 'Tracks', 'tasks.']), /Quote the description/);
    assert.throws(() => parseCli(['docket', 'x', '--bogus']), /bogus/);
  });
});

describe('chooseRepo', () => {
  test('prefers --repo, then origin, then the author account', () => {
    assert.equal(chooseRepo({ explicit: 'a/b', origin: 'https://github.com/c/d', name: 'n' }), 'a/b');
    assert.equal(chooseRepo({ origin: 'git@github.com:c/d.git', authorUrl: 'https://github.com/e', name: 'n' }), 'c/d');
    assert.equal(chooseRepo({ authorUrl: 'https://github.com/StoneCypher', name: 'docket' }), 'StoneCypher/docket');
  });

  test('ignores an origin that still points at the template', () => {
    assert.equal(chooseRepo({ origin: 'https://github.com/StoneCypher/skill-template.git',
      authorUrl: 'https://github.com/StoneCypher', name: 'docket' }), 'StoneCypher/docket');
  });

  test('throws when nothing identifies a repository', () => {
    assert.throws(() => chooseRepo({ name: 'docket' }), /pass --repo/);
  });
});

describe('planManifests', () => {
  test('skips manifests that are missing and versions the rest at 0.1.0', async () => {
    const originals = new Map([['package.json', await readFile(join(ROOT, 'package.json'), 'utf8')]]);
    const out = planManifests(originals, { oldName: 'skill-template', newName: 'x', description: 'd', repo: 'a/x' }, 'StoneCypher/skill-template');
    assert.deepEqual([...out.keys()], ['package.json']);
    assert.equal(JSON.parse(out.get('package.json')).version, INITIAL_VERSION);
  });
});

describe('main on a scratch copy', { skip: IS_TEMPLATE ? false : 'repo already initialized; template files are gone' }, () => {
  test('initializes the template end to end', async () => {
    const dir = await scratchRepo('fresh');
    const text = await main({ argv: ['docket', 'Tracks open tasks.'], root: dir, origin: noOrigin });
    assert.match(text, /Initialized skill "docket" for github\.com\/StoneCypher\/docket/);

    assert.deepEqual(await readdir(join(dir, 'skills')), ['docket']);
    const skill = await readFile(join(dir, skillDir('docket'), 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: docket\ndescription: Tracks open tasks\.\n---/);

    for (const { path, versioned } of MANIFESTS) {
      const manifest = await json(dir, path);
      assert.equal(manifest.name, 'docket', path);
      if (versioned) assert.equal(versionOf(path, manifest), INITIAL_VERSION, path);
      assert.doesNotMatch(JSON.stringify(manifest), /skill-template/, path);
    }
    const market = await json(dir, '.claude-plugin/marketplace.json');
    assert.equal(market.plugins[0].name, 'docket');

    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    assert.match(readme, /^# docket\n\nTracks open tasks\.\n/);
    assert.match(readme, /\/plugin install docket@docket/);
    assert.equal(await readFile(join(dir, 'CHANGELOG.md'), 'utf8'), '# Changelog\n\n## [Unreleased]\n');
  });

  test('refuses a second run, and renames again with --force', async () => {
    const dir = await scratchRepo('twice');
    await main({ argv: ['docket', 'Tracks open tasks.'], root: dir, origin: noOrigin });
    await assert.rejects(main({ argv: ['ledger', 'Keeps a ledger.'], root: dir, origin: noOrigin }), /already initialized as "docket"/);

    await main({ argv: ['ledger', 'Keeps a ledger.', '--force'], root: dir, origin: noOrigin });
    assert.deepEqual(await readdir(join(dir, 'skills')), ['ledger']);
    assert.equal((await json(dir, '.claude-plugin/plugin.json')).repository, 'https://github.com/StoneCypher/ledger');
    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    assert.match(readme, /\/plugin install ledger@ledger/);
    assert.doesNotMatch(readme, /docket/);
  });

  test('an invalid name changes nothing on disk', async () => {
    const dir = await scratchRepo('invalid');
    const before = await Promise.all(TEMPLATE_FILES.map(f => readFile(join(dir, f), 'utf8')));
    await assert.rejects(main({ argv: ['Bad_Name', 'x'], root: dir, origin: noOrigin }), /Invalid skill name/);
    const afterRun = await Promise.all(TEMPLATE_FILES.map(f => readFile(join(dir, f), 'utf8')));
    assert.deepEqual(afterRun, before);
  });

  test('uses the origin remote for URLs when it is not the template', async () => {
    const dir = await scratchRepo('origin');
    await main({ argv: ['docket', 'Tracks open tasks.'], root: dir, origin: () => 'git@github.com:someone/docket-skill.git' });
    assert.equal((await json(dir, '.codex-plugin/plugin.json')).homepage, 'https://github.com/someone/docket-skill#readme');
  });

  test('--help returns usage without touching files', async () => {
    assert.match(await main({ argv: ['--help'], root: join(SCRATCH, 'nowhere'), origin: noOrigin }), /^Usage: npm run init-skill -- <name>/);
  });
});
