/**
 * Tests validate.mjs and checksums.mjs end to end on copies of this repo in build/.
 *
 * @see ./validate.mjs
 * @see ./checksums.mjs
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { findSkillPaths, formatFindings, readSnapshot } from './validate.mjs';
import { listReferenceFiles, main as checksumsMain, sha256 } from './checksums.mjs';
import { runChecks } from './lib/checks.mjs';
import { MANIFESTS } from './lib/manifests.mjs';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SCRATCH = join(REPO, 'build', `test-validate-${process.pid}`);
const VALIDATE = fileURLToPath(new URL('./validate.mjs', import.meta.url));
const CHECKSUMS = fileURLToPath(new URL('./checksums.mjs', import.meta.url));

after(() => rm(SCRATCH, { recursive: true, force: true }));

/** Top-level repo paths a fixture copy needs. */
const COPIED = ['SKILL.md', 'skills', 'references', '.github', ...new Set(MANIFESTS.map(m => m.path.split('/')[0]))];

/** Copies this repo's skill and manifests into a fresh fixture directory. */
async function fixture(name) {
  const dir = join(SCRATCH, name);
  await mkdir(dir, { recursive: true });
  for (const entry of COPIED) {
    await cp(join(REPO, entry), join(dir, entry), { recursive: true }).catch(err => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
  return dir;
}

/** Reads a snapshot and returns only the error findings. */
const errorsIn = async root => runChecks(await readSnapshot(root)).filter(f => f.level === 'error');

/** Runs a script and returns its exit code and stdout, without throwing on non-zero exits. */
const exec = (script, args) => run(process.execPath, [script, ...args])
  .then(({ stdout }) => ({ code: 0, stdout }))
  .catch(err => ({ code: err.code, stdout: err.stdout }));

describe('validate', () => {
  test('this repo validates with no errors', async () => {
    assert.deepEqual(await errorsIn(REPO), []);
  });

  test('finds skills in both layouts', async () => {
    const dir = await fixture('layouts');
    await writeFile(join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n');
    await mkdir(join(dir, 'skills', 'zz-extra'), { recursive: true });
    await writeFile(join(dir, 'skills', 'zz-extra', 'SKILL.md'), '---\nname: zz-extra\ndescription: y\n---\n');
    const paths = await findSkillPaths(dir);
    assert.equal(paths[0], 'SKILL.md');
    assert.equal(paths.at(-1), 'skills/zz-extra/SKILL.md');
    const findings = runChecks(await readSnapshot(dir));
    assert.ok(findings.some(f => f.level === 'warn' && /found \d+ skills/.test(f.message)));
  });

  test('a root-level SKILL.md named like package.json validates', async () => {
    const dir = await fixture('root-layout');
    const [found] = await findSkillPaths(dir);
    if (found !== 'SKILL.md') await rename(join(dir, found), join(dir, 'SKILL.md'));
    await rm(join(dir, 'skills'), { recursive: true, force: true });
    assert.deepEqual(await findSkillPaths(dir), ['SKILL.md']);
    assert.deepEqual(await errorsIn(dir), []);
  });

  test('the CLI exits 0 on this repo and 1 on a broken copy', async () => {
    assert.equal((await exec(VALIDATE, [REPO])).code, 0);
    const dir = await fixture('broken-cli');
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ ...pkg, version: '9.9.9' }));
    const { code, stdout } = await exec(VALIDATE, [dir]);
    assert.equal(code, 1);
    assert.match(stdout, /\[versions\][\s\S]*package\.json 9\.9\.9/);
  });

  test('no SKILL.md at all is an error', async () => {
    const dir = await fixture('no-skill');
    await rm(join(dir, 'skills'), { recursive: true, force: true });
    await rm(join(dir, 'SKILL.md'), { force: true });
    assert.match((await errorsIn(dir))[0].message, /no SKILL\.md found/);
  });

  test('formatFindings groups by check and summarises', () => {
    const text = formatFindings([
      { level: 'error', check: 'versions', message: 'm1' },
      { level: 'warn', check: 'guard', message: 'm2' },
      { level: 'error', check: 'versions', message: 'm3' },
    ]);
    assert.equal(text, '[versions]\n  error  m1\n  error  m3\n\n[guard]\n  warn   m2\n\n2 errors, 1 warning');
    assert.equal(formatFindings([]), '0 errors, 0 warnings');
  });
});

describe('checksums', () => {
  test('sha256 ignores CRLF versus LF', () => {
    assert.equal(sha256(Buffer.from('a\r\nb\r\n')), sha256(Buffer.from('a\nb\n')));
    assert.notEqual(sha256(Buffer.from('a\nb')), sha256(Buffer.from('a\nc')));
  });

  test('write, verify, and detect edits, additions and removals', async () => {
    const dir = await fixture('references');
    const [skill] = await findSkillPaths(dir);
    const refs = join(dir, skill.replace(/SKILL\.md$/, ''), 'references');
    await mkdir(join(refs, 'deep'), { recursive: true });
    await writeFile(join(refs, 'spec.md'), 'vendored spec\n');
    await writeFile(join(refs, 'deep', 'table.csv'), 'a,b\n');

    assert.match((await errorsIn(dir))[0].message, /no \.github\/reference-checksums\.json/);
    assert.equal((await exec(CHECKSUMS, [dir])).code, 1);

    assert.equal(await checksumsMain(['--write', dir]), 0);
    assert.equal((await listReferenceFiles(dir)).length, 2);
    assert.deepEqual(await errorsIn(dir), []);
    assert.equal((await exec(CHECKSUMS, [dir])).code, 0);

    await writeFile(join(refs, 'spec.md'), 'vendored spec\r\n');
    assert.deepEqual(await errorsIn(dir), [], 'a CRLF-only change is not drift');

    await writeFile(join(refs, 'spec.md'), 'edited spec\n');
    await writeFile(join(refs, 'new.md'), 'surprise\n');
    await rm(join(refs, 'deep', 'table.csv'));
    const messages = (await errorsIn(dir)).map(f => f.message).join('\n');
    assert.match(messages, /spec\.md changed since/);
    assert.match(messages, /new\.md is not listed/);
    assert.match(messages, /table\.csv is listed .* but missing/);
    const { code, stdout } = await exec(CHECKSUMS, [dir]);
    assert.equal(code, 1);
    assert.match(stdout, /removed .*table\.csv[\s\S]*changed .*spec\.md[\s\S]*added .*new\.md/);
  });

  test('--write with no references and no checksum file creates nothing', async () => {
    const dir = await fixture('no-references');
    await rm(join(dir, '.github'), { recursive: true, force: true });
    assert.equal(await checksumsMain(['--write', dir]), 0);
    await assert.rejects(readFile(join(dir, '.github', 'reference-checksums.json')), { code: 'ENOENT' });
  });
});
