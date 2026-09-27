/**
 * Tests the pure repo checks with in-memory snapshots, plus randomized
 * properties for name rules, version agreement and checksum diffs.
 *
 * @see ./checks.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSkillCount, expectedSkillName, checkNameFormat, checkDescriptionLength, checkDescriptionBrackets, checkGuardSentence,
  checkRequiredFields, checkSkill, parseManifests, checkManifestNames, checkVersions, parseChecksums,
  diffChecksums, checkReferenceChecksums, serializeChecksums, runChecks, NAME_MAX, DESCRIPTION_MAX,
} from './checks.mjs';
import { MANIFESTS } from './manifests.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** Builds a SKILL.md text from a name and description. */
const skillText = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

/** Builds manifest texts shaped like the template's, with a given name and per-path versions. */
const manifestTexts = (name, versions = {}) => {
  const v = path => versions[path] ?? '0.1.0';
  return {
    '.claude-plugin/plugin.json': JSON.stringify({ name, version: v('.claude-plugin/plugin.json') }),
    '.claude-plugin/marketplace.json': JSON.stringify({ name, owner: { name: 'x' }, plugins: [{ name, source: './', version: v('.claude-plugin/marketplace.json') }] }),
    '.codex-plugin/plugin.json': JSON.stringify({ name, version: v('.codex-plugin/plugin.json') }),
    'plugin.json': JSON.stringify({ name }),
    'package.json': JSON.stringify({ name, version: v('package.json'), private: true }),
  };
};

/** Builds a full, clean snapshot, then applies overrides. */
const snapshot = (overrides = {}) => {
  const texts = manifestTexts('pdf-tools');
  return {
    skills: [{ path: 'skills/pdf-tools/SKILL.md', text: skillText('pdf-tools', 'Fills PDF forms. Not for Word files.') }],
    manifests: MANIFESTS.map(m => ({ ...m, text: texts[m.path] })),
    checksumText: null,
    referencePaths: [],
    hashes: {},
    ...overrides,
  };
};

const errors = findings => findings.filter(f => f.level === 'error');
const warnings = findings => findings.filter(f => f.level === 'warn');

describe('layout', () => {
  test('one skill is fine', () => assert.deepEqual(checkSkillCount(['skills/a/SKILL.md']), []));
  test('no skill is an error', () => assert.equal(errors(checkSkillCount([])).length, 1));
  test('several skills warn', () => {
    const findings = checkSkillCount(['SKILL.md', 'skills/a/SKILL.md']);
    assert.equal(warnings(findings).length, 1);
    assert.match(findings[0].message, /found 2 skills/);
  });
  test('expected name comes from the folder, or package.json at the root', () => {
    assert.deepEqual(expectedSkillName('skills/pdf/SKILL.md', 'other'), { name: 'pdf', source: 'its folder name' });
    assert.deepEqual(expectedSkillName('SKILL.md', 'pdf'), { name: 'pdf', source: 'the package.json name' });
  });
});

describe('name format', () => {
  for (const good of ['a', 'pdf', 'pdf-tools', 'x1-2y', 'a'.repeat(NAME_MAX)]) {
    test(`accepts "${good.length > 10 ? `${good.length} chars` : good}"`, () => assert.deepEqual(checkNameFormat(good, 'SKILL.md'), []));
  }
  for (const bad of ['', 'PDF', '-pdf', 'pdf-', 'pdf--tools', 'pdf_tools', 'pdf tools', 'pdf.tools', 'a'.repeat(NAME_MAX + 1), 'café']) {
    test(`rejects ${JSON.stringify(bad.length > 10 ? `${bad.length} chars` : bad)}`, () => assert.ok(errors(checkNameFormat(bad, 'SKILL.md')).length > 0));
  }
});

describe('description', () => {
  test('length limit is inclusive', () => {
    assert.deepEqual(checkDescriptionLength('x'.repeat(DESCRIPTION_MAX), 'SKILL.md'), []);
    assert.match(checkDescriptionLength('x'.repeat(DESCRIPTION_MAX + 1), 'SKILL.md')[0].message, /1025 characters/);
  });
  test('angle brackets are an error that names Claude Code', () => {
    assert.deepEqual(checkDescriptionBrackets('Fills forms. Not for Word.', 'SKILL.md'), []);
    for (const bad of ['Not for <things>.', 'a > b', 'a < b', '<tag/>']) {
      const findings = checkDescriptionBrackets(bad, 'skills/x/SKILL.md');
      assert.equal(errors(findings).length, 1, bad);
      assert.match(findings[0].message, /^skills\/x\/SKILL\.md: .*Claude Code rejects angle brackets/);
    }
  });

  test('checkSkill flags brackets in the parsed value, not in a >- block indicator', () => {
    const folded = '---\nname: x\ndescription: >-\n  Fills forms.\n  Not for Word.\n---\n';
    assert.deepEqual(checkSkill({ path: 'skills/x/SKILL.md', text: folded }, 'x').findings, []);
    const bracketed = '---\nname: x\ndescription: >-\n  Fills forms.\n  Not for <things>.\n---\n';
    const { findings } = checkSkill({ path: 'skills/x/SKILL.md', text: bracketed }, 'x');
    assert.deepEqual(findings.map(f => [f.level, f.check]), [['error', 'description']]);
  });

  test('guard sentence is matched case-insensitively on word boundaries', () => {
    assert.deepEqual(checkGuardSentence('Fills forms. NOT FOR Word.', 'SKILL.md'), []);
    assert.deepEqual(checkGuardSentence('Fills forms. Not for Word.', 'SKILL.md'), []);
    assert.equal(warnings(checkGuardSentence('Fills forms. Cannot format Word.', 'SKILL.md')).length, 1);
    assert.equal(warnings(checkGuardSentence('Knot fork.', 'SKILL.md')).length, 1);
  });
});

describe('frontmatter fields', () => {
  test('missing, null, non-string and empty fields are errors', () => {
    assert.equal(checkRequiredFields({}, 'S').length, 2);
    assert.match(checkRequiredFields({ name: null, description: 'd' }, 'S')[0].message, /missing "name"/);
    assert.match(checkRequiredFields({ name: 42, description: 'd' }, 'S')[0].message, /must be text, not number/);
    assert.match(checkRequiredFields({ name: 'n', description: '  ' }, 'S')[0].message, /"description" is empty/);
  });

  test('checkSkill reports a parse failure as one finding with the line', () => {
    const { findings, name } = checkSkill({ path: 'skills/x/SKILL.md', text: '---\nname: x\ntags: [a]\n---\n' }, 'x');
    assert.equal(name, undefined);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /skills\/x\/SKILL\.md: frontmatter does not parse: line 3: flow collections/);
  });

  test('checkSkill reports a missing frontmatter block', () => {
    const { findings } = checkSkill({ path: 'SKILL.md', text: '# Just a body\n' }, 'x');
    assert.match(findings[0].message, /must start with a "---"/);
  });

  test('checkSkill catches a folder mismatch and a bad name together', () => {
    const { findings } = checkSkill({ path: 'skills/pdf/SKILL.md', text: skillText('PDF_Tools', 'Does it. Not for that.') }, 'pdf');
    const messages = errors(findings).map(f => f.message).join('\n');
    assert.match(messages, /must be lowercase/);
    assert.match(messages, /does not match its folder name "pdf"/);
  });

  test('root layout compares the name with package.json', () => {
    const { findings } = checkSkill({ path: 'SKILL.md', text: skillText('pdf', 'Does it. Not for that.') }, 'pdf-tools');
    assert.match(errors(findings)[0].message, /does not match the package\.json name "pdf-tools"/);
  });
});

describe('manifests', () => {
  test('missing files, invalid JSON and non-objects are errors; good ones parse', () => {
    const { findings, parsed } = parseManifests([
      { path: 'a.json', host: 'A', versioned: true, text: null },
      { path: 'b.json', host: 'B', versioned: true, text: '{"name": ' },
      { path: 'c.json', host: 'C', versioned: true, text: '[1]' },
      { path: 'd.json', host: 'D', versioned: true, text: '{"name":"d"}' },
    ]);
    assert.deepEqual(findings.map(f => f.message.split(' ')[0]), ['a.json', 'b.json', 'c.json']);
    assert.match(findings[1].message, /not valid JSON/);
    assert.deepEqual(parsed.map(p => p.json), [{ name: 'd' }]);
  });

  test('names must match the skill, including the marketplace plugin entry', () => {
    const findings = checkManifestNames('pdf', [
      { path: 'package.json', json: { name: 'pdf' } },
      { path: 'plugin.json', json: { name: 'pdf-old' } },
      { path: '.claude-plugin/marketplace.json', json: { name: 'pdf', plugins: [{ name: 'other' }] } },
      { path: '.codex-plugin/plugin.json', json: {} },
    ]);
    const messages = findings.map(f => f.message);
    assert.equal(findings.length, 3);
    assert.ok(messages.some(m => /\.codex-plugin\/plugin\.json has no "name"/.test(m)));
    assert.ok(messages.some(m => /plugin\.json name "pdf-old" does not match/.test(m)));
    assert.ok(messages.some(m => /no plugin entry named "pdf" \(entries: other\)/.test(m)));
  });

  test('without a skill name, manifests must still agree with each other', () => {
    const findings = checkManifestNames(undefined, [
      { path: 'package.json', json: { name: 'a' } },
      { path: 'plugin.json', json: { name: 'b' } },
    ]);
    assert.match(findings[0].message, /plugin\.json name "b" differs from package\.json name "a"/);
  });

  test('a marketplace with no plugins is an error', () => {
    assert.match(checkManifestNames('a', [{ path: '.claude-plugin/marketplace.json', json: { name: 'a' } }])[0].message, /lists no plugins/);
  });
});

describe('versions', () => {
  const parsed = versions => Object.entries(versions).map(([path, version]) => ({
    path, versioned: true, json: path.endsWith('marketplace.json') ? { name: 'x', plugins: [{ name: 'x', version }] } : { version },
  }));

  test('equal valid versions pass; unversioned manifests are ignored', () => {
    assert.deepEqual(checkVersions([...parsed({ 'package.json': '1.2.3', '.claude-plugin/marketplace.json': '1.2.3' }),
      { path: 'plugin.json', versioned: false, json: { version: 'nonsense' } }]), []);
  });

  test('a mismatch names every manifest and version', () => {
    const [finding] = checkVersions(parsed({ 'package.json': '0.2.0', '.codex-plugin/plugin.json': '0.1.0', '.claude-plugin/marketplace.json': '0.2.0' }));
    assert.match(finding.message, /package\.json 0\.2\.0, \.codex-plugin\/plugin\.json 0\.1\.0, \.claude-plugin\/marketplace\.json 0\.2\.0/);
  });

  test('invalid semver and absent versions are errors', () => {
    const messages = checkVersions([...parsed({ 'a.json': '1.0', 'b.json': '01.0.0' }), { path: 'c.json', versioned: true, json: {} }]).map(f => f.message);
    assert.ok(messages.some(m => /a\.json version "1\.0" is not valid semver/.test(m)));
    assert.ok(messages.some(m => /b\.json version "01\.0\.0" is not valid semver/.test(m)));
    assert.ok(messages.some(m => /c\.json has no version/.test(m)));
  });

  test('prerelease and build metadata are valid semver', () => {
    assert.deepEqual(checkVersions(parsed({ 'a.json': '1.0.0-rc.1+build.5', 'b.json': '1.0.0-rc.1+build.5' })), []);
  });
});

describe('reference checksums', () => {
  test('no checksum file and no references is fine', () => {
    assert.deepEqual(checkReferenceChecksums({ checksumText: null, referencePaths: [], hashes: {} }), []);
  });

  test('references without a checksum file is an error', () => {
    assert.match(checkReferenceChecksums({ checksumText: null, referencePaths: ['skills/x/references/a.md'], hashes: {} })[0].message, /no \.github\/reference-checksums\.json/);
  });

  test('reports changed, missing and unlisted files', () => {
    const checksumText = serializeChecksums({ 'skills/x/references/a.md': HASH_A, 'skills/x/references/gone.md': HASH_A });
    const findings = checkReferenceChecksums({
      checksumText,
      referencePaths: ['skills/x/references/a.md', 'skills/x/references/new.md'],
      hashes: { 'skills/x/references/a.md': HASH_B, 'skills/x/references/gone.md': null, 'skills/x/references/new.md': HASH_A },
    });
    const messages = findings.map(f => f.message);
    assert.equal(findings.length, 3);
    assert.ok(messages.some(m => /gone\.md is listed .* but missing/.test(m)));
    assert.ok(messages.some(m => /a\.md changed since/.test(m)));
    assert.ok(messages.some(m => /new\.md is not listed/.test(m)));
  });

  test('matching files pass', () => {
    const checksumText = serializeChecksums({ 'skills/x/references/a.md': HASH_A });
    assert.deepEqual(checkReferenceChecksums({ checksumText, referencePaths: ['skills/x/references/a.md'], hashes: { 'skills/x/references/a.md': HASH_A } }), []);
  });

  test('malformed checksum files are errors', () => {
    assert.match(parseChecksums('nope').findings[0].message, /not valid JSON/);
    assert.match(parseChecksums('[]').findings[0].message, /must map file paths/);
    const { findings, listed } = parseChecksums(JSON.stringify({ 'a.md': 'ABC', 'b.md': HASH_A }));
    assert.match(findings[0].message, /"a\.md" is not a lowercase sha256/);
    assert.deepEqual(listed, { 'b.md': HASH_A });
  });

  test('serializeChecksums sorts keys and ends with a newline', () => {
    assert.equal(serializeChecksums({ 'b.md': HASH_B, 'a.md': HASH_A }), `{\n  "a.md": "${HASH_A}",\n  "b.md": "${HASH_B}"\n}\n`);
  });
});

describe('runChecks on whole snapshots', () => {
  test('a clean snapshot has no findings', () => assert.deepEqual(runChecks(snapshot()), []));

  test('the template\'s own shape passes (root layout too)', () => {
    const texts = manifestTexts('pdf-tools');
    const root = snapshot({ skills: [{ path: 'SKILL.md', text: skillText('pdf-tools', 'Fills forms. Not for Word.') }], manifests: MANIFESTS.map(m => ({ ...m, text: texts[m.path] })) });
    assert.deepEqual(runChecks(root), []);
  });

  test('a broken repo reports each problem', () => {
    const texts = manifestTexts('pdf-tools', { '.codex-plugin/plugin.json': '0.0.9' });
    const broken = snapshot({
      skills: [{ path: 'skills/pdf-tools/SKILL.md', text: skillText('PDF-tools', 'Fills PDF forms.') }],
      manifests: MANIFESTS.map(m => ({
        ...m,
        text: { 'plugin.json': '{ "name": "pdf-tools", }', '.claude-plugin/plugin.json': '{"name":"pdf-tool","version":"0.1.0"}' }[m.path] ?? texts[m.path],
      })),
    });
    const findings = runChecks(broken);
    const checks = new Set(findings.map(f => f.check));
    for (const check of ['name', 'guard', 'manifests', 'names', 'versions']) assert.ok(checks.has(check), `expected a ${check} finding`);
    assert.equal(warnings(findings).length, 1);
    const names = findings.filter(f => f.check === 'names');
    assert.equal(names.length, 1, 'only the misnamed manifest is blamed, not every manifest for the bad SKILL.md name');
    assert.match(names[0].message, /\.claude-plugin\/plugin\.json name "pdf-tool" does not match the skill name "pdf-tools"/);
  });

  test('a SKILL.md that does not parse still has its manifests checked against the folder', () => {
    const findings = runChecks(snapshot({ skills: [{ path: 'skills/other/SKILL.md', text: 'no frontmatter' }] }));
    assert.ok(findings.some(f => f.check === 'frontmatter'));
    // Five manifests named pdf-tools, plus the marketplace lacking an "other" entry.
    assert.equal(findings.filter(f => f.check === 'names').length, 6);
  });

  test('several skills skip skill-to-manifest matching but still check each skill', () => {
    const findings = runChecks(snapshot({ skills: [
      { path: 'skills/pdf-tools/SKILL.md', text: skillText('pdf-tools', 'A. Not for B.') },
      { path: 'skills/other/SKILL.md', text: skillText('other', 'C.') },
    ] }));
    assert.deepEqual(findings.map(f => [f.level, f.check]), [['warn', 'layout'], ['warn', 'guard']]);
  });
});

// ---------------------------------------------------------------------------
// Stochastic properties
// ---------------------------------------------------------------------------

const SEED = Number(process.env.CHECKS_SEED ?? Date.now() % 2 ** 31);
const RUNS = 500;

/** mulberry32: a small seeded PRNG so failures replay with CHECKS_SEED. */
const prng = seed => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

describe(`stochastic (seed ${SEED})`, () => {
  test('names: accepted exactly when every hyphen-separated segment is non-empty [a-z0-9] and length is 1-64', () => {
    const rand = prng(SEED);
    const alphabet = 'abz09-A_. '.split('');
    for (let run = 0; run < RUNS * 4; run += 1) {
      const name = Array.from({ length: Math.floor(rand() * 70) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
      const segmentsOk = name.split('-').every(s => s.length > 0 && [...s].every(c => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')));
      const expectOk = segmentsOk && name.length >= 1 && name.length <= 64;
      assert.equal(checkNameFormat(name, 'S').length === 0, expectOk, `seed ${SEED}: ${JSON.stringify(name)}`);
    }
  });

  test('versions: an error appears exactly when versions differ or one is not x.y.z', () => {
    const rand = prng(SEED + 1);
    const pool = ['0.1.0', '0.1.0', '0.2.0', '1.0.0', '1.0', 'v1.0.0'];
    for (let run = 0; run < RUNS; run += 1) {
      const versions = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pool[Math.floor(rand() * pool.length)]);
      const parsed = versions.map((version, i) => ({ path: `m${i}.json`, versioned: true, json: { version } }));
      const expectOk = new Set(versions).size === 1 && /^\d+\.\d+\.\d+$/.test(versions[0]);
      assert.equal(checkVersions(parsed).length === 0, expectOk, `seed ${SEED}: ${versions}`);
    }
  });

  test('checksum diff: partitions files correctly for random listings', () => {
    const rand = prng(SEED + 2);
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map(f => `skills/x/references/${f}.md`);
    for (let run = 0; run < RUNS; run += 1) {
      const listed = Object.fromEntries(files.filter(() => rand() < 0.6).map(f => [f, rand() < 0.5 ? HASH_A : HASH_B]));
      const onDisk = files.filter(() => rand() < 0.7);
      const actual = Object.fromEntries(files.map(f => [f, onDisk.includes(f) ? (rand() < 0.5 ? HASH_A : HASH_B) : null]));
      const { missing, changed, unlisted } = diffChecksums(listed, actual, onDisk);
      for (const f of files) {
        const isListed = Object.hasOwn(listed, f);
        const exists = onDisk.includes(f);
        assert.equal(missing.includes(f), isListed && !exists, `seed ${SEED}: missing ${f}`);
        assert.equal(changed.includes(f), isListed && exists && actual[f] !== listed[f], `seed ${SEED}: changed ${f}`);
        assert.equal(unlisted.includes(f), !isListed && exists, `seed ${SEED}: unlisted ${f}`);
      }
      const findings = checkReferenceChecksums({ checksumText: serializeChecksums(listed), referencePaths: onDisk, hashes: actual });
      assert.equal(findings.length, missing.length + changed.length + unlisted.length, `seed ${SEED}`);
    }
  });

  test('serializeChecksums round-trips through parseChecksums', () => {
    const rand = prng(SEED + 3);
    for (let run = 0; run < RUNS; run += 1) {
      const map = Object.fromEntries(Array.from({ length: Math.floor(rand() * 6) }, (_, i) => [`skills/s/references/${Math.floor(rand() * 1e6)}-${i}.md`, rand() < 0.5 ? HASH_A : HASH_B]));
      assert.deepEqual(parseChecksums(serializeChecksums(map)), { findings: [], listed: map }, `seed ${SEED}`);
    }
  });
});
