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
  checkMarketplaceSource, checkPluginLicense, checkPluginDevFiles, devFileReason, toLf, PLUGIN_SOURCE, PLUGIN_LICENSE,
} from './checks.mjs';
import { MANIFESTS, MARKETPLACE_PATH, isMarketplace } from './manifests.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** The Codex manifest's path, taken from MANIFESTS so fixtures follow the layout. */
const CODEX = MANIFESTS.find(m => m.host === 'Codex').path;

/** The Claude plugin manifest's path, taken from MANIFESTS. */
const CLAUDE = MANIFESTS.find(m => m.host === 'Claude Code' && !isMarketplace(m.path)).path;

/** The Antigravity manifest's path, taken from MANIFESTS. */
const ANTIGRAVITY = MANIFESTS.find(m => m.host === 'Antigravity').path;

/** A short licence text for snapshots. */
const LICENSE_TEXT = 'MIT License\n\nCopyright (c) 2026 Someone\n';

/** Builds a SKILL.md text from a name and description. */
const skillText = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

/** Builds manifest texts shaped like the template's, with a given name and per-path versions. */
const manifestTexts = (name, versions = {}) => {
  const v = path => versions[path] ?? '0.1.0';
  const body = ({ path, versioned }) => {
    if (isMarketplace(path)) return { name, owner: { name: 'x' }, plugins: [{ name, source: PLUGIN_SOURCE, version: v(path) }] };
    if (!versioned) return { name };
    return path === 'package.json' ? { name, version: v(path), private: true } : { name, version: v(path) };
  };
  return Object.fromEntries(MANIFESTS.map(m => [m.path, JSON.stringify(body(m))]));
};

/** Builds a full, clean snapshot, then applies overrides. */
const snapshot = (overrides = {}) => {
  const texts = manifestTexts('pdf-tools');
  return {
    skills: [{ path: 'plugin/skills/pdf-tools/SKILL.md', text: skillText('pdf-tools', 'Fills PDF forms. Not for Word files.') }],
    manifests: MANIFESTS.map(m => ({ ...m, text: texts[m.path] })),
    checksumText: null,
    referencePaths: [],
    hashes: {},
    rootLicense: LICENSE_TEXT,
    pluginLicense: LICENSE_TEXT,
    pluginPaths: ['plugin/LICENSE', 'plugin/skills/pdf-tools/SKILL.md', ...MANIFESTS.filter(m => m.path.startsWith('plugin/')).map(m => m.path)],
    ...overrides,
  };
};

const errors = findings => findings.filter(f => f.level === 'error');
const warnings = findings => findings.filter(f => f.level === 'warn');

describe('layout', () => {
  test('one skill is fine', () => assert.deepEqual(checkSkillCount(['plugin/skills/a/SKILL.md']), []));
  test('no skill is an error', () => assert.equal(errors(checkSkillCount([])).length, 1));
  test('no skill names the plugin/skills layout', () => {
    assert.match(checkSkillCount([])[0].message, /expected plugin\/skills\/<name>\/SKILL\.md$/);
  });
  test('several skills warn', () => {
    const findings = checkSkillCount(['plugin/skills/a/SKILL.md', 'plugin/skills/b/SKILL.md']);
    assert.equal(warnings(findings).length, 1);
    assert.match(findings[0].message, /found 2 skills/);
  });
  test('expected name comes from the folder under plugin/skills, and nowhere else', () => {
    assert.deepEqual(expectedSkillName('plugin/skills/pdf/SKILL.md'), { name: 'pdf', source: 'its folder name' });
    assert.equal(expectedSkillName('skills/pdf/SKILL.md').name, undefined, 'the old repo-root skills/ layout is gone');
    assert.equal(expectedSkillName('SKILL.md').name, undefined, 'the root SKILL.md layout is gone');
    assert.equal(expectedSkillName('plugin/skills/a/b/SKILL.md').name, undefined);
  });
});

describe('marketplace source', () => {
  const market = source => [{ path: MARKETPLACE_PATH, json: { name: 'pdf', plugins: [{ name: 'other', source: './x' }, { name: 'pdf', source }] } }];

  test('"./plugin" passes, and other plugin entries are not judged', () => {
    assert.equal(PLUGIN_SOURCE, './plugin');
    assert.deepEqual(checkMarketplaceSource(market('./plugin')), []);
  });

  for (const bad of ['./', '.', 'plugin', './plugin/', undefined, { source: 'github', repo: 'a/b' }]) {
    test(`source ${JSON.stringify(bad)} is an error`, () => {
      const findings = checkMarketplaceSource(market(bad));
      assert.deepEqual(findings.map(f => [f.level, f.check]), [['error', 'layout']]);
      assert.match(findings[0].message, /must be "\.\/plugin"/);
    });
  }

  test('non-marketplace manifests and a missing own entry are left to other checks', () => {
    assert.deepEqual(checkMarketplaceSource([{ path: CLAUDE, json: { name: 'pdf', source: './' } }]), []);
    assert.deepEqual(checkMarketplaceSource([{ path: MARKETPLACE_PATH, json: { name: 'pdf', plugins: [{ name: 'x', source: './' }] } }]), []);
  });

  test('runChecks reports a marketplace still pointing at the repo root', () => {
    const texts = manifestTexts('pdf-tools');
    const rooted = JSON.stringify({ ...JSON.parse(texts[MARKETPLACE_PATH]), plugins: [{ name: 'pdf-tools', source: './', version: '0.1.0' }] });
    const findings = runChecks(snapshot({ manifests: MANIFESTS.map(m => ({ ...m, text: m.path === MARKETPLACE_PATH ? rooted : texts[m.path] })) }));
    assert.deepEqual(findings.map(f => [f.level, f.check]), [['error', 'layout']]);
  });
});

describe('plugin licence', () => {
  test('identical copies pass, and so do copies that differ only in CRLF versus LF', () => {
    assert.equal(PLUGIN_LICENSE, 'plugin/LICENSE');
    assert.deepEqual(checkPluginLicense({ rootLicense: LICENSE_TEXT, pluginLicense: LICENSE_TEXT }), []);
    assert.deepEqual(checkPluginLicense({ rootLicense: LICENSE_TEXT, pluginLicense: LICENSE_TEXT.replaceAll('\n', '\r\n') }), []);
  });

  test('a missing plugin copy is an error that says to copy LICENSE', () => {
    const findings = checkPluginLicense({ rootLicense: LICENSE_TEXT, pluginLicense: null });
    assert.deepEqual(findings.map(f => [f.level, f.check]), [['error', 'license']]);
    assert.match(findings[0].message, /plugin\/LICENSE is missing/);
  });

  test('a missing root copy is an error too', () => {
    assert.match(checkPluginLicense({ rootLicense: null, pluginLicense: LICENSE_TEXT })[0].message, /LICENSE is missing at the repo root/);
    assert.equal(checkPluginLicense({}).length, 2);
  });

  test('different text is an error, even a single character', () => {
    const findings = checkPluginLicense({ rootLicense: LICENSE_TEXT, pluginLicense: LICENSE_TEXT.replace('2026', '2025') });
    assert.match(findings[0].message, /plugin\/LICENSE differs from LICENSE/);
    assert.equal(checkPluginLicense({ rootLicense: 'a\r\n', pluginLicense: 'a\r' }).length, 1, 'a bare CR is not a line-ending difference');
  });

  test('toLf only rewrites CR LF pairs', () => {
    assert.equal(toLf('a\r\nb\rc\n'), 'a\nb\rc\n');
  });

  test('runChecks reports a drifted plugin licence', () => {
    const findings = runChecks(snapshot({ pluginLicense: 'Apache-2.0\n' }));
    assert.deepEqual(findings.map(f => [f.level, f.check]), [['error', 'license']]);
  });
});

describe('dev files under plugin/', () => {
  const flagged = [
    'plugin/package.json', 'plugin/src/scripts/x.mjs', 'plugin/node_modules/', 'plugin/skills/pdf/node_modules/',
    'plugin/skills/pdf/scripts/fill.test.mjs', 'plugin/a.test.js',
  ];
  const fine = [
    'plugin/LICENSE', 'plugin/plugin.json', 'plugin/.claude-plugin/plugin.json', 'plugin/skills/pdf/SKILL.md',
    'plugin/skills/pdf/references/testing.md', 'plugin/skills/pdf/package.json', 'plugin/skills/pdf/src/fill.py',
    'plugin/source.md', 'plugin/latest.md',
  ];

  for (const path of flagged) test(`warns about ${path}`, () => assert.equal(typeof devFileReason(path), 'string'));
  for (const path of fine) test(`accepts ${path}`, () => assert.equal(devFileReason(path), undefined));

  test('checkPluginDevFiles warns once per dev file and names the plugin cache', () => {
    const findings = checkPluginDevFiles([...fine, ...flagged]);
    assert.equal(findings.length, flagged.length);
    assert.ok(findings.every(f => f.level === 'warn' && f.check === 'plugin-contents'));
    assert.match(findings[0].message, /copied to every user's plugin cache/);
  });

  test('runChecks passes dev-file warnings through without errors', () => {
    const base = snapshot();
    const findings = runChecks({ ...base, pluginPaths: [...base.pluginPaths, 'plugin/package.json'] });
    assert.deepEqual(findings.map(f => [f.level, f.check]), [['warn', 'plugin-contents']]);
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
      const findings = checkDescriptionBrackets(bad, 'plugin/skills/x/SKILL.md');
      assert.equal(errors(findings).length, 1, bad);
      assert.match(findings[0].message, /^plugin\/skills\/x\/SKILL\.md: .*Claude Code rejects angle brackets/);
    }
  });

  test('checkSkill flags brackets in the parsed value, not in a >- block indicator', () => {
    const folded = '---\nname: x\ndescription: >-\n  Fills forms.\n  Not for Word.\n---\n';
    assert.deepEqual(checkSkill({ path: 'plugin/skills/x/SKILL.md', text: folded }).findings, []);
    const bracketed = '---\nname: x\ndescription: >-\n  Fills forms.\n  Not for <things>.\n---\n';
    const { findings } = checkSkill({ path: 'plugin/skills/x/SKILL.md', text: bracketed });
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
    const { findings, name } = checkSkill({ path: 'plugin/skills/x/SKILL.md', text: '---\nname: x\ntags: [a]\n---\n' });
    assert.equal(name, undefined);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /^plugin\/skills\/x\/SKILL\.md: frontmatter does not parse: line 3: flow collections/);
  });

  test('checkSkill reports a missing frontmatter block', () => {
    const { findings } = checkSkill({ path: 'plugin/skills/x/SKILL.md', text: '# Just a body\n' });
    assert.match(findings[0].message, /must start with a "---"/);
  });

  test('checkSkill catches a folder mismatch and a bad name together', () => {
    const { findings } = checkSkill({ path: 'plugin/skills/pdf/SKILL.md', text: skillText('PDF_Tools', 'Does it. Not for that.') });
    const messages = errors(findings).map(f => f.message).join('\n');
    assert.match(messages, /must be lowercase/);
    assert.match(messages, /does not match its folder name "pdf"/);
  });

  test('a SKILL.md outside plugin/skills/<name>/ has no folder name to match, so only its own fields are checked', () => {
    const { findings, name } = checkSkill({ path: 'SKILL.md', text: skillText('pdf', 'Does it. Not for that.') });
    assert.deepEqual(findings, []);
    assert.equal(name, 'pdf');
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
      { path: ANTIGRAVITY, json: { name: 'pdf-old' } },
      { path: MARKETPLACE_PATH, json: { name: 'pdf', plugins: [{ name: 'other' }] } },
      { path: CODEX, json: {} },
    ]);
    const messages = findings.map(f => f.message);
    assert.equal(findings.length, 3);
    assert.ok(messages.some(m => /^plugin\/\.codex-plugin\/plugin\.json has no "name"/.test(m)));
    assert.ok(messages.some(m => /^plugin\/plugin\.json name "pdf-old" does not match/.test(m)));
    assert.ok(messages.some(m => /no plugin entry named "pdf" \(entries: other\)/.test(m)));
  });

  test('without a skill name, manifests must still agree with each other', () => {
    const findings = checkManifestNames(undefined, [
      { path: 'package.json', json: { name: 'a' } },
      { path: ANTIGRAVITY, json: { name: 'b' } },
    ]);
    assert.match(findings[0].message, /^plugin\/plugin\.json name "b" differs from package\.json name "a"/);
  });

  test('a marketplace with no plugins is an error', () => {
    assert.match(checkManifestNames('a', [{ path: MARKETPLACE_PATH, json: { name: 'a' } }])[0].message, /lists no plugins/);
  });
});

describe('versions', () => {
  const parsed = versions => Object.entries(versions).map(([path, version]) => ({
    path, versioned: true, json: isMarketplace(path) ? { name: 'x', plugins: [{ name: 'x', version }] } : { version },
  }));

  test('equal valid versions pass; unversioned manifests are ignored', () => {
    assert.deepEqual(checkVersions([...parsed({ 'package.json': '1.2.3', [MARKETPLACE_PATH]: '1.2.3' }),
      { path: ANTIGRAVITY, versioned: false, json: { version: 'nonsense' } }]), []);
  });

  test('a mismatch names every manifest and version', () => {
    const [finding] = checkVersions(parsed({ 'package.json': '0.2.0', [CODEX]: '0.1.0', [MARKETPLACE_PATH]: '0.2.0' }));
    assert.match(finding.message, /package\.json 0\.2\.0, plugin\/\.codex-plugin\/plugin\.json 0\.1\.0, \.claude-plugin\/marketplace\.json 0\.2\.0/);
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
    assert.match(checkReferenceChecksums({ checksumText: null, referencePaths: ['plugin/skills/x/references/a.md'], hashes: {} })[0].message, /no \.github\/reference-checksums\.json/);
  });

  test('reports changed, missing and unlisted files', () => {
    const checksumText = serializeChecksums({ 'plugin/skills/x/references/a.md': HASH_A, 'plugin/skills/x/references/gone.md': HASH_A });
    const findings = checkReferenceChecksums({
      checksumText,
      referencePaths: ['plugin/skills/x/references/a.md', 'plugin/skills/x/references/new.md'],
      hashes: { 'plugin/skills/x/references/a.md': HASH_B, 'plugin/skills/x/references/gone.md': null, 'plugin/skills/x/references/new.md': HASH_A },
    });
    const messages = findings.map(f => f.message);
    assert.equal(findings.length, 3);
    assert.ok(messages.some(m => /gone\.md is listed .* but missing/.test(m)));
    assert.ok(messages.some(m => /a\.md changed since/.test(m)));
    assert.ok(messages.some(m => /new\.md is not listed/.test(m)));
  });

  test('matching files pass', () => {
    const checksumText = serializeChecksums({ 'plugin/skills/x/references/a.md': HASH_A });
    assert.deepEqual(checkReferenceChecksums({ checksumText, referencePaths: ['plugin/skills/x/references/a.md'], hashes: { 'plugin/skills/x/references/a.md': HASH_A } }), []);
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

  test('a clean snapshot with no plugin/LICENSE and a root-sourced marketplace fails on exactly those', () => {
    const texts = manifestTexts('pdf-tools');
    const rooted = texts[MARKETPLACE_PATH].replace(`"source":"${PLUGIN_SOURCE}"`, '"source":"./"');
    const findings = runChecks(snapshot({
      pluginLicense: null,
      manifests: MANIFESTS.map(m => ({ ...m, text: m.path === MARKETPLACE_PATH ? rooted : texts[m.path] })),
    }));
    assert.deepEqual(findings.map(f => [f.level, f.check]), [['error', 'layout'], ['error', 'license']]);
  });

  test('a broken repo reports each problem', () => {
    const texts = manifestTexts('pdf-tools', { [CODEX]: '0.0.9' });
    const broken = snapshot({
      skills: [{ path: 'plugin/skills/pdf-tools/SKILL.md', text: skillText('PDF-tools', 'Fills PDF forms.') }],
      manifests: MANIFESTS.map(m => ({
        ...m,
        text: { [ANTIGRAVITY]: '{ "name": "pdf-tools", }', [CLAUDE]: '{"name":"pdf-tool","version":"0.1.0"}' }[m.path] ?? texts[m.path],
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
    const findings = runChecks(snapshot({ skills: [{ path: 'plugin/skills/other/SKILL.md', text: 'no frontmatter' }] }));
    assert.ok(findings.some(f => f.check === 'frontmatter'));
    // Five manifests named pdf-tools, plus the marketplace lacking an "other" entry.
    assert.equal(findings.filter(f => f.check === 'names').length, 6);
  });

  test('several skills skip skill-to-manifest matching but still check each skill', () => {
    const findings = runChecks(snapshot({ skills: [
      { path: 'plugin/skills/pdf-tools/SKILL.md', text: skillText('pdf-tools', 'A. Not for B.') },
      { path: 'plugin/skills/other/SKILL.md', text: skillText('other', 'C.') },
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
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map(f => `plugin/skills/x/references/${f}.md`);
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
      const map = Object.fromEntries(Array.from({ length: Math.floor(rand() * 6) }, (_, i) => [`plugin/skills/s/references/${Math.floor(rand() * 1e6)}-${i}.md`, rand() < 0.5 ? HASH_A : HASH_B]));
      assert.deepEqual(parseChecksums(serializeChecksums(map)), { findings: [], listed: map }, `seed ${SEED}`);
    }
  });
});
