/**
 * Tests for the pure rename rules that init-skill applies to each file.
 *
 * @see ./rename.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateSkillName, validateDescription, normalizeRepo, checkOptions, yamlScalar,
  renameSkillMd, renameManifest, renamePackage, stripTemplateOnly, revealSkillOnly,
  fillPlaceholders, renameReadme, resetChangelog, TEMPLATE_NAME, TEMPLATE_REPO,
} from './rename.mjs';
import { CLAUDE_PLUGIN_PATH, MANIFESTS, MARKETPLACE_PATH, SKILLS_DIR } from './manifests.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Options for the common case: the template becoming `docket`. */
const DOCKET = Object.freeze({
  oldName: TEMPLATE_NAME, newName: 'docket',
  description: 'Tracks open tasks in a docket file. Not for court dockets.', repo: 'StoneCypher/docket',
});

/**
 * Reads a file from the real template, so tests exercise what actually ships.
 *
 * @param {string} path  Repo-relative path.
 * @returns {Promise<string>}  The file's contents.
 */
const repoFile = path => readFile(join(ROOT, path), 'utf8');

/**
 * Whether this repo is still the template. Once init-skill has run, the
 * shipped-file tests no longer apply (their files were renamed), so they skip.
 */
const IS_TEMPLATE = JSON.parse(await repoFile(CLAUDE_PLUGIN_PATH)).name === TEMPLATE_NAME;

/** Test options that skip a shipped-file test in an initialized skill repo. */
const SHIPPED = Object.freeze({ skip: IS_TEMPLATE ? false : 'repo already initialized; template files are gone' });

/** A SKILL.md in the template's shape, so stochastic tests run in any repo. */
const SKILL_FIXTURE = `---
name: skill-template
description: >-
  TODO: one or two sentences on what this skill does. TODO: replace this
  line with a guard sentence.
---

# skill-template

Body text.
`;

/**
 * Deterministic PRNG (mulberry32) so stochastic failures can be replayed from the seed.
 *
 * @param {number} seed  Any 32-bit integer.
 * @returns {() => number}  Uniform floats in [0, 1).
 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds a random name that satisfies the Agent Skills rules by construction.
 *
 * @param {() => number} rand  PRNG.
 * @returns {string}  e.g. 'x3-q9f-a'.
 */
function randomValidName(rand) {
  const alnum = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const segments = 1 + Math.floor(rand() * 4);
  const parts = Array.from({ length: segments }, () =>
    Array.from({ length: 1 + Math.floor(rand() * 12) }, () => alnum[Math.floor(rand() * alnum.length)]).join(''));
  const name = parts.join('-').slice(0, 64).replace(/-+$/, '');
  return /claude|anthropic/.test(name) ? 'fallback' : name;
}

/**
 * Builds a random one-line description, including YAML-hostile characters.
 *
 * @param {() => number} rand  PRNG.
 * @returns {string}  A trimmed, non-empty string without angle brackets.
 */
function randomDescription(rand) {
  const pool = 'abc XYZ 019 :#-?,[]{}&*!|\'"%@`\\/.é漢';
  const length = 1 + Math.floor(rand() * 200);
  const text = Array.from({ length }, () => pool[Math.floor(rand() * pool.length)]).join('').trim();
  return text || 'x';
}

/**
 * Reads one frontmatter value back, decoding a double-quoted scalar as JSON.
 *
 * Independent of the module under test: it only knows that quoted output is
 * JSON-compatible and plain output is literal.
 *
 * @param {string} text  SKILL.md contents.
 * @param {string} key   Top-level frontmatter key.
 * @returns {string | undefined}  The decoded value.
 */
function frontmatterValue(text, key) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)[1];
  const raw = fm.split(/\r?\n/).find(line => line.startsWith(`${key}: `))?.slice(key.length + 2);
  return raw?.startsWith('"') ? JSON.parse(raw) : raw;
}

describe('validateSkillName', () => {
  test('accepts names that follow the rules', () => {
    for (const name of ['a', 'docket', 'self-expression', 'x2', '9lives', 'a'.repeat(64)]) {
      assert.equal(validateSkillName(name), name);
    }
  });

  test('rejects each broken rule with a message naming it', () => {
    const cases = [
      ['', /empty/], ['a'.repeat(65), /at most 64/], ['Docket', /lowercase/], ['my_skill', /lowercase/],
      ['my skill', /lowercase/], ['-docket', /start or end/], ['docket-', /start or end/],
      ['my--skill', /two hyphens/], ['claude-helper', /reserved word "claude"/], ['anthropic', /reserved/],
    ];
    for (const [name, pattern] of cases) {
      assert.throws(() => validateSkillName(name), pattern, `expected "${name}" to be rejected`);
    }
  });

  test('stochastic: every generated valid name passes and any uppercase letter fails', () => {
    const rand = rng(0xC0FFEE);
    for (let i = 0; i < 500; i += 1) {
      const name = randomValidName(rand);
      assert.equal(validateSkillName(name), name);
      const at = Math.floor(rand() * name.length);
      const broken = name.slice(0, at) + name[at].toUpperCase() + name.slice(at + 1);
      if (broken !== name) assert.throws(() => validateSkillName(broken), /lowercase/);
    }
  });
});

describe('validateDescription', () => {
  test('trims and accepts a normal description', () => {
    assert.equal(validateDescription('  Tracks tasks.  '), 'Tracks tasks.');
  });

  test('rejects empty, too long, multi-line and angle-bracketed descriptions', () => {
    assert.throws(() => validateDescription('   '), /empty/);
    assert.throws(() => validateDescription('x'.repeat(1025)), /at most 1024/);
    assert.throws(() => validateDescription('one\ntwo'), /single line/);
    assert.throws(() => validateDescription('Not for <things>.'), /"<" or ">"/);
  });
});

describe('normalizeRepo', () => {
  test('accepts owner/repo and common GitHub URL forms', () => {
    for (const form of ['StoneCypher/docket', 'https://github.com/StoneCypher/docket',
      'https://github.com/StoneCypher/docket.git', 'git@github.com:StoneCypher/docket.git']) {
      assert.equal(normalizeRepo(form), 'StoneCypher/docket');
    }
  });

  test('rejects things that are not a GitHub repository', () => {
    for (const bad of ['', 'docket', 'a/b/c', 'https://gitlab.com/a/b']) {
      assert.throws(() => normalizeRepo(bad), /Invalid repository/);
    }
  });
});

describe('yamlScalar', () => {
  test('leaves ordinary text bare and quotes text a plain scalar would misread', () => {
    assert.equal(yamlScalar('Tracks tasks. Not for courts.'), 'Tracks tasks. Not for courts.');
    for (const risky of ['Note: this', '#hash', '- dash', 'true', '1.5', 'ends with:', 'a #comment']) {
      assert.equal(JSON.parse(yamlScalar(risky)), risky, `expected "${risky}" to be quoted`);
    }
  });
});

describe('renameSkillMd', () => {
  test('rewrites the shipped SKILL.md name, description and title', SHIPPED, async () => {
    const out = renameSkillMd(await repoFile(`${SKILLS_DIR}/skill-template/SKILL.md`), DOCKET);
    assert.equal(frontmatterValue(out, 'name'), 'docket');
    assert.equal(frontmatterValue(out, 'description'), DOCKET.description);
    assert.match(out, /^# docket$/m);
    assert.doesNotMatch(out, /skill-template/);
  });

  test('replaces a description that wraps onto continuation lines', () => {
    const text = '---\nname: skill-template\ndescription: >\n  folded one\n  folded two\nlicense: MIT\n---\nbody\n';
    const out = renameSkillMd(text, DOCKET);
    assert.equal(out, `---\nname: docket\ndescription: ${DOCKET.description}\nlicense: MIT\n---\nbody\n`);
  });

  test('keeps CRLF line endings and leaves a hand-written title alone', () => {
    const text = '---\r\nname: old-one\r\ndescription: x\r\n---\r\n\r\n# My Own Title\r\n';
    const out = renameSkillMd(text, { ...DOCKET, oldName: 'old-one' });
    assert.equal(out, `---\r\nname: docket\r\ndescription: ${DOCKET.description}\r\n---\r\n\r\n# My Own Title\r\n`);
  });

  test('throws when there is no frontmatter', () => {
    assert.throws(() => renameSkillMd('# skill-template\n', DOCKET), /no YAML frontmatter/);
  });

  test('stochastic: random valid names and hostile descriptions round-trip through the frontmatter', () => {
    const template = SKILL_FIXTURE;
    const rand = rng(20260926);
    for (let i = 0; i < 300; i += 1) {
      const options = checkOptions({ ...DOCKET, newName: randomValidName(rand), description: randomDescription(rand) });
      const out = renameSkillMd(template, options);
      assert.equal(frontmatterValue(out, 'name'), options.newName);
      assert.equal(frontmatterValue(out, 'description'), options.description);
      assert.match(out, new RegExp(`^# ${options.newName}$`, 'm'));
    }
  });
});

describe('renameManifest', () => {
  const paths = MANIFESTS.map(m => m.path).filter(p => p !== 'package.json');

  test('rewrites every shipped manifest so no trace of the template remains', SHIPPED, async () => {
    for (const path of paths) {
      const out = renameManifest(path, JSON.parse(await repoFile(path)), DOCKET);
      assert.equal(out.name, 'docket', path);
      assert.doesNotMatch(JSON.stringify(out), /skill-template/, path);
    }
  });

  test('keeps the shipped marketplace pointing at the plugin folder', SHIPPED, async () => {
    const out = renameManifest(MARKETPLACE_PATH, JSON.parse(await repoFile(MARKETPLACE_PATH)), DOCKET);
    assert.deepEqual(out.plugins.map(p => p.source), ['./plugin']);
  });

  test('sets homepage and repository on the plugin manifests', SHIPPED, async () => {
    for (const path of [CLAUDE_PLUGIN_PATH, 'plugin/.codex-plugin/plugin.json']) {
      const out = renameManifest(path, JSON.parse(await repoFile(path)), DOCKET);
      assert.equal(out.description, DOCKET.description);
      assert.equal(out.homepage, 'https://github.com/StoneCypher/docket#readme');
      assert.equal(out.repository, 'https://github.com/StoneCypher/docket');
    }
  });

  test('names the marketplace after the skill and renames only the matching plugin entry', () => {
    const market = {
      name: 'skill-template', owner: { name: 'J' },
      plugins: [{ name: 'other', description: 'keep' }, { name: 'skill-template', description: 'old', version: '0.3.0' }],
    };
    const out = renameManifest(MARKETPLACE_PATH, market, DOCKET);
    assert.equal(out.name, 'docket');
    assert.equal('description' in out, false);
    assert.deepEqual(out.plugins, [
      { name: 'other', description: 'keep' },
      { name: 'docket', description: DOCKET.description, version: '0.3.0' },
    ]);
    assert.equal(market.name, 'skill-template', 'input must not be mutated');
  });

  test('throws when the marketplace has no entry for the old name', () => {
    assert.throws(() => renameManifest(MARKETPLACE_PATH, { name: 'x', plugins: [] }, DOCKET),
      /no plugin entry named "skill-template"/);
  });

  test('keeps an object-shaped repository in its shape', () => {
    const out = renameManifest('package.json', { name: 'a', repository: { type: 'git', url: 'x' } }, DOCKET);
    assert.deepEqual(out.repository, { type: 'git', url: 'git+https://github.com/StoneCypher/docket.git' });
  });
});

describe('renamePackage', () => {
  test('rewrites the shipped package.json name and description and keeps its scripts', async () => {
    const before = JSON.parse(await repoFile('package.json'));
    const out = renamePackage(before, DOCKET);
    assert.equal(out.name, 'docket');
    assert.equal(out.description, DOCKET.description);
    assert.deepEqual(out.scripts, before.scripts);
  });
});

describe('README blocks', () => {
  test('stripTemplateOnly removes every block with its markers', () => {
    const text = 'a\n<!-- template-only:start -->\nb\n<!-- template-only:end -->\nc\n'
      + '<!-- template-only:start -->\nd\n<!-- template-only:end -->\ne\n';
    assert.equal(stripTemplateOnly(text), 'a\nc\ne\n');
  });

  test('stripTemplateOnly throws on an unmatched start marker', () => {
    assert.throws(() => stripTemplateOnly('<!-- template-only:start -->\nb\n'), /no matching/);
  });

  test('revealSkillOnly uncomments the hidden block', () => {
    assert.equal(revealSkillOnly('x\n<!-- skill-only:start\n# <name>\n\nhi\nskill-only:end -->\ny\n'), 'x\n# <name>\n\nhi\ny\n');
  });

  test('fillPlaceholders fills every occurrence', () => {
    assert.equal(fillPlaceholders('<name>@<name> <repo> <description>', DOCKET),
      `docket@docket StoneCypher/docket ${DOCKET.description}`);
  });
});

describe('renameReadme', () => {
  test('turns the shipped README into a skill README with no template residue', SHIPPED, async () => {
    const out = renameReadme(await repoFile('README.md'), DOCKET);
    assert.match(out, /^# docket$/m);
    assert.match(out, /\/plugin install docket@docket/);
    assert.match(out, /\/plugin marketplace add StoneCypher\/docket/);
    assert.match(out, /`docket:docket`/, 'the plugin invocation name is filled in');
    assert.match(out, /plugin\/skills\/docket/, 'copy instructions point into the plugin folder');
    assert.doesNotMatch(out, /docket\/skills\/docket|`skills\/docket/, 'no instruction points at the old repo-root skills/ folder');
    for (const residue of ['<name>', '<repo>', '<description>', 'template-only', 'skill-only', 'init-skill', 'skill-template']) {
      assert.equal(out.includes(residue), false, `README still contains "${residue}"`);
    }
  });

  test('on a second run, renames the previous name only where it stands alone', () => {
    const text = '# docket\n/plugin install docket@docket\nSee StoneCypher/docket. Not dockets or my-docket.\n';
    const out = renameReadme(text, { ...DOCKET, oldName: 'docket', newName: 'ledger', repo: 'StoneCypher/ledger' }, 'StoneCypher/docket');
    assert.equal(out, '# ledger\n/plugin install ledger@ledger\nSee StoneCypher/ledger. Not dockets or my-docket.\n');
  });
});

describe('resetChangelog', () => {
  test('keeps the preamble and drops every release', () => {
    const text = '# Changelog\n\nAll notable changes.\n\n## [Unreleased]\n- a\n\n## [0.2.0]\n- b\n\n[0.2.0]: https://x\n';
    assert.equal(resetChangelog(text), '# Changelog\n\nAll notable changes.\n\n## [Unreleased]\n');
  });

  test('supplies a title when the file has none', () => {
    assert.equal(resetChangelog(''), '# Changelog\n\n## [Unreleased]\n');
  });
});

describe('checkOptions', () => {
  test('normalizes and freezes valid options', () => {
    const out = checkOptions({ ...DOCKET, description: ' d ', repo: 'https://github.com/StoneCypher/docket.git' });
    assert.equal(out.description, 'd');
    assert.equal(out.repo, 'StoneCypher/docket');
    assert.equal(Object.isFrozen(out), true);
  });

  test('refuses an invalid new name before anything is rewritten', () => {
    assert.throws(() => checkOptions({ ...DOCKET, newName: 'Bad Name' }), /Invalid skill name/);
  });

  test('the template constants describe the shipped template', SHIPPED, async () => {
    const plugin = JSON.parse(await repoFile(CLAUDE_PLUGIN_PATH));
    assert.equal(plugin.name, TEMPLATE_NAME);
    assert.equal(plugin.repository, `https://github.com/${TEMPLATE_REPO}`);
  });
});
