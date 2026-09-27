/**
 * Pure validation checks for a skill repo, run by `npm run validate` and CI.
 *
 * Every check takes already-read data (file text, paths, hashes) and returns
 * findings; none touches the disk, so each is testable with plain values.
 * `validate.mjs` gathers a {@link RepoSnapshot} and hands it to {@link runChecks}.
 *
 * @see ../validate.mjs
 * @see ./frontmatter.mjs
 * @see ./manifests.mjs
 */

import { parseFrontmatter, FrontmatterError } from './frontmatter.mjs';
import { versionOf } from './manifests.mjs';

/**
 * One problem found by a check.
 *
 * @typedef {object} Finding
 * @property {'error' | 'warn'} level  Errors fail CI; warnings are printed only.
 * @property {string} check            Which check produced it, for grouping output.
 * @property {string} message          What is wrong and, where useful, how to fix it.
 */

/**
 * A SKILL.md file as read from disk.
 *
 * @typedef {object} SkillFile
 * @property {string} path  Repo-relative path: `SKILL.md` or `skills/<name>/SKILL.md`.
 * @property {string} text  The file's contents.
 */

/**
 * A manifest from `MANIFESTS` (manifests.mjs) with its contents, if the file exists.
 *
 * @typedef {import('./manifests.mjs').ManifestSpec & { text: string | null }} ManifestFile
 */

/**
 * Everything the checks need, read from one repo.
 *
 * @typedef {object} RepoSnapshot
 * @property {SkillFile[]} skills              Every SKILL.md found, sorted by path.
 * @property {ManifestFile[]} manifests        One entry per `MANIFESTS` item.
 * @property {string | null} checksumText      The checksum file's text, or null if absent.
 * @property {string[]} referencePaths         Repo-relative paths of every reference file on disk.
 * @property {Record<string, string | null>} hashes  sha256 of each listed or on-disk reference path; null if missing.
 */

/** Longest skill name the Agent Skills spec allows. */
export const NAME_MAX = 64;

/** Longest description the Agent Skills spec allows. */
export const DESCRIPTION_MAX = 1024;

/** Lowercase letters and digits in hyphen-separated runs: no leading, trailing or double hyphen. */
export const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The guard sentence that says what a skill should not trigger on. */
export const GUARD_PATTERN = /\bNot for\b/i;

/** Semantic Versioning 2.0.0, from semver.org. */
export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Where the reference-file checksums live. */
export const CHECKSUM_FILE = '.github/reference-checksums.json';

/** A lowercase sha256 hex digest. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A skill folder's SKILL.md path; captures the folder name. */
const NESTED_SKILL = /^skills\/([^/]+)\/SKILL\.md$/;

/**
 * Builds an error finding.
 *
 * @param {string} check    The check's name.
 * @param {string} message  The problem.
 * @returns {Finding}
 *
 * @example
 * error('versions', 'plugin.json has no version'); // { level: 'error', check: 'versions', message: '...' }
 */
export const error = (check, message) => ({ level: 'error', check, message });

/**
 * Builds a warning finding.
 *
 * @param {string} check    The check's name.
 * @param {string} message  The problem.
 * @returns {Finding}
 *
 * @example
 * warn('guard', 'no "Not for" sentence'); // { level: 'warn', check: 'guard', message: '...' }
 */
export const warn = (check, message) => ({ level: 'warn', check, message });

/**
 * Checks that the repo holds exactly one skill.
 *
 * @param {string[]} skillPaths  Repo-relative paths of every SKILL.md found.
 * @returns {Finding[]}  An error for none, a warning for several.
 *
 * @example
 * checkSkillCount(['skills/pdf/SKILL.md']); // []
 * @example
 * checkSkillCount([]); // [{ level: 'error', check: 'layout', ... }]
 */
export function checkSkillCount(skillPaths) {
  if (skillPaths.length === 0) {
    return [error('layout', 'no SKILL.md found; expected skills/<name>/SKILL.md or SKILL.md at the repo root')];
  }
  if (skillPaths.length > 1) {
    return [warn('layout', `found ${skillPaths.length} skills (${skillPaths.join(', ')}); a skill repo normally holds one, and skill-to-manifest name matching is skipped`)];
  }
  return [];
}

/**
 * Works out which name a SKILL.md must declare, from where it sits.
 *
 * @param {string} skillPath             `skills/<name>/SKILL.md` or `SKILL.md`.
 * @param {string | undefined} packageName  package.json's `name`, used for the root layout.
 * @returns {{ name: string | undefined, source: string }}  The expected name
 *   and a phrase naming where it came from, for messages.
 *
 * @example
 * expectedSkillName('skills/pdf/SKILL.md', 'pdf'); // { name: 'pdf', source: 'its folder name' }
 * @example
 * expectedSkillName('SKILL.md', 'pdf'); // { name: 'pdf', source: 'the package.json name' }
 */
export function expectedSkillName(skillPath, packageName) {
  const nested = NESTED_SKILL.exec(skillPath);
  return nested
    ? { name: nested[1], source: 'its folder name' }
    : { name: packageName, source: 'the package.json name' };
}

/**
 * Checks a skill name against the Agent Skills naming rules.
 *
 * @param {string} name  The frontmatter `name`.
 * @param {string} path  The SKILL.md path, for messages.
 * @returns {Finding[]}
 *
 * @example
 * checkNameFormat('pdf-tools', 'skills/pdf-tools/SKILL.md'); // []
 * @example
 * checkNameFormat('PDF--Tools', 'SKILL.md'); // one error
 */
export function checkNameFormat(name, path) {
  const findings = [];
  if (name.length < 1 || name.length > NAME_MAX) {
    findings.push(error('name', `${path}: name "${name}" is ${name.length} characters; it must be 1-${NAME_MAX}`));
  }
  if (!NAME_PATTERN.test(name)) {
    findings.push(error('name', `${path}: name "${name}" must be lowercase letters, digits and single hyphens, with no leading or trailing hyphen`));
  }
  return findings;
}

/**
 * Checks a description's length against the Agent Skills limit.
 *
 * @param {string} description  The frontmatter `description`.
 * @param {string} path         The SKILL.md path, for messages.
 * @returns {Finding[]}
 *
 * @example
 * checkDescriptionLength('Reads PDFs.', 'SKILL.md'); // []
 */
export function checkDescriptionLength(description, path) {
  return description.length > DESCRIPTION_MAX
    ? [error('description', `${path}: description is ${description.length} characters; the limit is ${DESCRIPTION_MAX}`)]
    : [];
}

/**
 * Rejects a description containing `<` or `>`, which Claude Code refuses to load.
 *
 * Claude Code treats angle brackets in a skill description as XML-like tags
 * and rejects the skill, so a placeholder such as `<things>` left in the
 * description stops it installing at all. YAML block indicators (`>-`) sit
 * outside the parsed value and are unaffected.
 *
 * @param {string} description  The parsed frontmatter `description`.
 * @param {string} path         The SKILL.md path, for messages.
 * @returns {Finding[]}  One error when the description has an angle bracket, else none.
 *
 * @example
 * checkDescriptionBrackets('Reads PDFs. Not for Word files.', 'SKILL.md'); // []
 * @example
 * checkDescriptionBrackets('Reads PDFs. Not for <things>.', 'SKILL.md'); // one error
 *
 * @see checkSkill
 */
export function checkDescriptionBrackets(description, path) {
  return /[<>]/.test(description)
    ? [error('description', `${path}: description contains "<" or ">"; Claude Code rejects angle brackets in a skill description, so reword it without them`)]
    : [];
}

/**
 * Warns when a description never says what the skill is not for.
 *
 * A guard sentence ("Not for ...") keeps a skill from triggering on nearby
 * requests; it is advice, so this only warns.
 *
 * @param {string} description  The frontmatter `description`.
 * @param {string} path         The SKILL.md path, for messages.
 * @returns {Finding[]}
 *
 * @example
 * checkGuardSentence('Reads PDFs. Not for Word files.', 'SKILL.md'); // []
 * @example
 * checkGuardSentence('Reads PDFs.', 'SKILL.md'); // one warning
 */
export function checkGuardSentence(description, path) {
  return GUARD_PATTERN.test(description)
    ? []
    : [warn('guard', `${path}: description has no guard sentence (e.g. "Not for ..."); say what should not trigger this skill`)];
}

/**
 * Checks that `name` and `description` are present, non-empty strings.
 *
 * @param {Record<string, unknown>} data  Parsed frontmatter.
 * @param {string} path                   The SKILL.md path, for messages.
 * @returns {Finding[]}
 *
 * @example
 * checkRequiredFields({ name: 'pdf', description: 'x' }, 'SKILL.md'); // []
 * @example
 * checkRequiredFields({ name: 42 }, 'SKILL.md'); // two errors
 */
export function checkRequiredFields(data, path) {
  return ['name', 'description'].flatMap(field => {
    if (!Object.hasOwn(data, field) || data[field] === null) return [error('frontmatter', `${path}: frontmatter is missing "${field}"`)];
    if (typeof data[field] !== 'string') return [error('frontmatter', `${path}: "${field}" must be text, not ${typeof data[field]}; quote it`)];
    if (data[field].trim() === '') return [error('frontmatter', `${path}: "${field}" is empty`)];
    return [];
  });
}

/**
 * Parses and checks one SKILL.md: frontmatter, fields, name and description (length, angle brackets, guard).
 *
 * @param {SkillFile} skill                  The file.
 * @param {string | undefined} packageName  package.json's name, for the root layout.
 * @returns {{ findings: Finding[], name: string | undefined }}  Findings, and
 *   the declared name when it is usable for manifest matching.
 *
 * @example
 * checkSkill({ path: 'skills/pdf/SKILL.md', text: '---\nname: pdf\ndescription: Reads PDFs. Not for Word.\n---\n' }, 'pdf');
 * // { findings: [], name: 'pdf' }
 *
 * @see expectedSkillName
 */
export function checkSkill(skill, packageName) {
  let data;
  try {
    ({ data } = parseFrontmatter(skill.text));
  } catch (err) {
    if (!(err instanceof FrontmatterError)) throw err;
    return { findings: [error('frontmatter', `${skill.path}: frontmatter does not parse: ${err.message}`)], name: undefined };
  }
  const required = checkRequiredFields(data, skill.path);
  const hasName = typeof data.name === 'string' && data.name !== '';
  const hasDescription = typeof data.description === 'string';
  const expected = expectedSkillName(skill.path, packageName);
  const mismatch = hasName && expected.name !== undefined && data.name !== expected.name
    ? [error('name', `${skill.path}: name "${data.name}" does not match ${expected.source} "${expected.name}"`)]
    : [];
  const findings = [
    ...required,
    ...(hasName ? checkNameFormat(data.name, skill.path) : []),
    ...mismatch,
    ...(hasDescription ? checkDescriptionLength(data.description, skill.path) : []),
    ...(hasDescription ? checkDescriptionBrackets(data.description, skill.path) : []),
    ...(hasDescription ? checkGuardSentence(data.description, skill.path) : []),
  ];
  return { findings, name: hasName ? data.name : undefined };
}

/**
 * Parses every manifest, reporting missing files and invalid JSON.
 *
 * @param {ManifestFile[]} manifests  One entry per manifest spec.
 * @returns {{ findings: Finding[], parsed: Array<ManifestFile & { json: any }> }}
 *   Findings, and the manifests that parsed to a JSON object.
 *
 * @example
 * parseManifests([{ path: 'plugin.json', host: 'Antigravity', versioned: false, text: '{"name":"x"}' }]);
 * // { findings: [], parsed: [{ ..., json: { name: 'x' } }] }
 */
export function parseManifests(manifests) {
  const results = manifests.map(m => {
    if (m.text === null) return { finding: error('manifests', `${m.path} (${m.host}) is missing`) };
    if (m.text.startsWith('﻿')) return { finding: error('manifests', `${m.path} (${m.host}) starts with a byte-order mark; save it as UTF-8 without BOM`) };
    try {
      const json = JSON.parse(m.text);
      return json !== null && typeof json === 'object' && !Array.isArray(json)
        ? { manifest: { ...m, json } }
        : { finding: error('manifests', `${m.path} (${m.host}) must hold a JSON object`) };
    } catch (err) {
      return { finding: error('manifests', `${m.path} (${m.host}) is not valid JSON: ${err.message}`) };
    }
  });
  return {
    findings: results.flatMap(r => (r.finding ? [r.finding] : [])),
    parsed: results.flatMap(r => (r.manifest ? [r.manifest] : [])),
  };
}

/**
 * Checks that every manifest names the skill, including the marketplace's plugin entry.
 *
 * With `skillName` undefined (no usable skill, or several), it checks only
 * that the manifests agree with each other.
 *
 * @param {string | undefined} skillName  The SKILL.md name every manifest must use.
 * @param {Array<{ path: string, json: any }>} parsed  Parsed manifests.
 * @returns {Finding[]}
 *
 * @example
 * checkManifestNames('pdf', [{ path: 'package.json', json: { name: 'pdf' } }]); // []
 */
export function checkManifestNames(skillName, parsed) {
  const names = parsed.map(m => ({ path: m.path, name: m.json.name }));
  const missing = names.filter(n => typeof n.name !== 'string')
    .map(n => error('names', `${n.path} has no "name"`));
  const named = names.filter(n => typeof n.name === 'string');
  const target = skillName ?? named[0]?.name;
  const wrong = named.filter(n => n.name !== target).map(n => error('names', skillName === undefined
    ? `${n.path} name "${n.name}" differs from ${named[0].path} name "${target}"`
    : `${n.path} name "${n.name}" does not match the skill name "${target}"`));
  const entries = parsed.filter(m => m.path.endsWith('marketplace.json')).flatMap(m => {
    const plugins = Array.isArray(m.json.plugins) ? m.json.plugins : [];
    if (plugins.length === 0) return [error('names', `${m.path} lists no plugins`)];
    return target !== undefined && !plugins.some(p => p?.name === target)
      ? [error('names', `${m.path} has no plugin entry named "${target}" (entries: ${plugins.map(p => p?.name).join(', ')})`)]
      : [];
  });
  return [...missing, ...wrong, ...entries];
}

/**
 * Checks that every versioned manifest has the same, valid semver version.
 *
 * Claude Code's `/plugin update` does nothing unless the version moves, so a
 * manifest left behind silently strands users on the old release.
 *
 * @param {Array<{ path: string, versioned: boolean, json: any }>} parsed  Parsed manifests.
 * @returns {Finding[]}
 *
 * @example
 * checkVersions([
 *   { path: 'package.json', versioned: true, json: { version: '0.2.0' } },
 *   { path: '.codex-plugin/plugin.json', versioned: true, json: { version: '0.1.0' } },
 * ]); // one error listing both versions
 *
 * @see versionOf
 */
export function checkVersions(parsed) {
  const versions = parsed.filter(m => m.versioned).map(m => ({ path: m.path, version: versionOf(m.path, m.json) }));
  const absent = versions.filter(v => typeof v.version !== 'string')
    .map(v => error('versions', `${v.path} has no version`));
  const present = versions.filter(v => typeof v.version === 'string');
  const invalid = present.filter(v => !SEMVER_PATTERN.test(v.version))
    .map(v => error('versions', `${v.path} version "${v.version}" is not valid semver (e.g. 1.2.3)`));
  const distinct = new Set(present.map(v => v.version));
  const mismatch = distinct.size > 1
    ? [error('versions', `manifest versions differ; bump them together: ${present.map(v => `${v.path} ${v.version}`).join(', ')}`)]
    : [];
  return [...absent, ...invalid, ...mismatch];
}

/**
 * Parses the checksum file into a path-to-digest map.
 *
 * @param {string} text  The checksum file's contents.
 * @returns {{ findings: Finding[], listed: Record<string, string> }}  Findings
 *   for malformed content, and the entries that are well formed.
 *
 * @example
 * parseChecksums('{"skills/x/references/a.md":"' + 'ab'.repeat(32) + '"}');
 * // { findings: [], listed: { 'skills/x/references/a.md': 'abab...' } }
 */
export function parseChecksums(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { findings: [error('references', `${CHECKSUM_FILE} is not valid JSON: ${err.message}`)], listed: {} };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { findings: [error('references', `${CHECKSUM_FILE} must map file paths to sha256 digests`)], listed: {} };
  }
  const entries = Object.entries(json);
  return {
    findings: entries.filter(([, v]) => typeof v !== 'string' || !SHA256_HEX.test(v))
      .map(([k]) => error('references', `${CHECKSUM_FILE}: "${k}" is not a lowercase sha256 hex digest`)),
    listed: Object.fromEntries(entries.filter(([, v]) => typeof v === 'string' && SHA256_HEX.test(v))),
  };
}

/**
 * Compares recorded checksums with actual ones.
 *
 * @param {Record<string, string>} listed                  Recorded path -> digest.
 * @param {Record<string, string | null>} actual           Actual path -> digest; null when the file is missing.
 * @param {string[]} onDisk                                Every reference file path on disk.
 * @returns {{ missing: string[], changed: string[], unlisted: string[] }}
 *   Listed files that are gone, listed files whose content changed, and
 *   reference files the checksum file does not list. Each sorted.
 *
 * @example
 * diffChecksums({ 'a.md': 'x' }, { 'a.md': 'y', 'b.md': 'z' }, ['a.md', 'b.md']);
 * // { missing: [], changed: ['a.md'], unlisted: ['b.md'] }
 */
export function diffChecksums(listed, actual, onDisk) {
  const paths = Object.keys(listed).sort();
  return {
    missing: paths.filter(p => actual[p] === null || actual[p] === undefined),
    changed: paths.filter(p => typeof actual[p] === 'string' && actual[p] !== listed[p]),
    unlisted: [...onDisk].sort().filter(p => !Object.hasOwn(listed, p)),
  };
}

/**
 * Checks that reference files match their recorded checksums.
 *
 * Every listed file must exist and match, and every reference file must be
 * listed, so adding or editing a reference file is always deliberate.
 *
 * @param {Pick<RepoSnapshot, 'checksumText' | 'referencePaths' | 'hashes'>} snapshot
 * @returns {Finding[]}
 *
 * @example
 * checkReferenceChecksums({ checksumText: null, referencePaths: [], hashes: {} }); // []
 *
 * @see diffChecksums
 */
export function checkReferenceChecksums({ checksumText, referencePaths, hashes }) {
  if (checksumText === null) {
    return referencePaths.length === 0
      ? []
      : [error('references', `${referencePaths.length} reference file(s) but no ${CHECKSUM_FILE}; run npm run checksums`)];
  }
  const { findings, listed } = parseChecksums(checksumText);
  const { missing, changed, unlisted } = diffChecksums(listed, hashes, referencePaths);
  return [
    ...findings,
    ...missing.map(p => error('references', `${p} is listed in ${CHECKSUM_FILE} but missing`)),
    ...changed.map(p => error('references', `${p} changed since its checksum was recorded; restore it, or run npm run checksums if the change is deliberate`)),
    ...unlisted.map(p => error('references', `${p} is not listed in ${CHECKSUM_FILE}; run npm run checksums to record it`)),
  ];
}

/**
 * Serialises a checksum map as the checksum file's text: sorted keys, two-space JSON, trailing newline.
 *
 * @param {Record<string, string>} digests  Path -> sha256 hex.
 * @returns {string}  File contents; stable for equal maps.
 *
 * @example
 * serializeChecksums({ 'b.md': '2', 'a.md': '1' }); // '{\n  "a.md": "1",\n  "b.md": "2"\n}\n'
 */
export function serializeChecksums(digests) {
  const sorted = Object.fromEntries(Object.keys(digests).sort().map(k => [k, digests[k]]));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * Runs every check against a repo snapshot.
 *
 * @param {RepoSnapshot} snapshot  Data read from the repo by validate.mjs.
 * @returns {Finding[]}  All findings, errors and warnings, in check order.
 *
 * @example
 * runChecks(snapshot).filter(f => f.level === 'error').length; // 0 for a clean repo
 */
export function runChecks(snapshot) {
  const manifests = parseManifests(snapshot.manifests);
  const rawPackageName = manifests.parsed.find(m => m.path === 'package.json')?.json.name;
  const packageName = typeof rawPackageName === 'string' ? rawPackageName : undefined;
  const skills = snapshot.skills.map(s => checkSkill(s, packageName));
  // Manifests are compared with the folder name when there is one: a wrong
  // SKILL.md name is already reported, and blaming every manifest for it too
  // would bury the real problem.
  const skillName = skills.length === 1
    ? expectedSkillName(snapshot.skills[0].path, packageName).name ?? skills[0].name
    : undefined;
  return [
    ...checkSkillCount(snapshot.skills.map(s => s.path)),
    ...skills.flatMap(s => s.findings),
    ...manifests.findings,
    ...checkManifestNames(skillName, manifests.parsed),
    ...checkVersions(manifests.parsed),
    ...checkReferenceChecksums(snapshot),
  ];
}
