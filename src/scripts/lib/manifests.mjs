/**
 * Knows the repo layout: every manifest it ships, where each keeps its version, and where the plugin and skills live.
 *
 * Every host reads its own manifest, and Claude Code's `/plugin update` does
 * nothing unless the version moves, so all versioned manifests must agree.
 * This module is the one place that lists them; the validator, init-skill,
 * checksums and the release script all read it.
 *
 * @see ../validate.mjs
 * @see ../release.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A manifest file and how to reach its version, if it has one.
 *
 * @typedef {object} ManifestSpec
 * @property {string} path    Repo-relative path, forward slashes.
 * @property {string} host    Which tool reads it, for error messages.
 * @property {boolean} versioned  False when the format has no version field
 *   (Antigravity's plugin.json); such files are checked as JSON only.
 */

/**
 * The folder, relative to the repo root, that holds everything a user installs.
 *
 * The marketplace points hosts at this folder (`"source": "./plugin"`), and
 * hosts copy the whole plugin source into their cache, so only the skill, the
 * plugin manifests and the licence belong here. Development files (scripts,
 * tests, package.json, .github) stay at the repo root, out of users' caches.
 *
 * @example
 * `${PLUGIN_ROOT}/skills/docket/SKILL.md`; // 'plugin/skills/docket/SKILL.md'
 */
export const PLUGIN_ROOT = 'plugin';

/**
 * The folder, relative to the repo root, that holds one subfolder per skill.
 *
 * Codex accepts only a real subdirectory as its `skills` path, so skills sit
 * at `plugin/skills/<name>/SKILL.md`, never at the plugin root.
 *
 * @example
 * `${SKILLS_DIR}/docket/references/spec.md`; // 'plugin/skills/docket/references/spec.md'
 */
export const SKILLS_DIR = `${PLUGIN_ROOT}/skills`;

/** Where the Claude Code marketplace lives: at the repo root, outside the plugin, so it can point into it. */
export const MARKETPLACE_PATH = '.claude-plugin/marketplace.json';

/** Where Claude Code's plugin manifest lives; it also names the skill for init-skill. */
export const CLAUDE_PLUGIN_PATH = `${PLUGIN_ROOT}/.claude-plugin/plugin.json`;

/** @type {readonly ManifestSpec[]} */
export const MANIFESTS = Object.freeze([
  { path: CLAUDE_PLUGIN_PATH,                         host: 'Claude Code',        versioned: true },
  { path: MARKETPLACE_PATH,                           host: 'Claude Code',        versioned: true },
  { path: `${PLUGIN_ROOT}/.codex-plugin/plugin.json`, host: 'Codex',              versioned: true },
  { path: `${PLUGIN_ROOT}/plugin.json`,               host: 'Antigravity',        versioned: false },
  { path: 'package.json',                             host: 'npm (repo tooling)', versioned: true },
]);

/**
 * Tells whether a repo-relative path is a Claude marketplace rather than a plugin manifest.
 *
 * Marketplaces list plugins instead of being one, so their name and version
 * live in a plugin entry; every rule that treats them differently asks here.
 *
 * @param {string} path  A manifest's repo-relative path.
 * @returns {boolean}  True for any `marketplace.json`.
 *
 * @example
 * isMarketplace('.claude-plugin/marketplace.json'); // true
 * @example
 * isMarketplace('plugin/.claude-plugin/plugin.json'); // false
 */
export const isMarketplace = path => path.endsWith('marketplace.json');

/**
 * Reads the version a parsed manifest declares.
 *
 * A marketplace lists plugins rather than being one, so its version is the
 * entry whose `name` matches the manifest's own `name`.
 *
 * @param {string} path  The manifest's repo-relative path, which selects the rule.
 * @param {any} json     The parsed manifest.
 * @returns {string | undefined}  The version, or undefined if absent.
 *
 * @example
 * versionOf('plugin/.codex-plugin/plugin.json', { version: '0.1.0' }); // '0.1.0'
 * @example
 * versionOf('.claude-plugin/marketplace.json',
 *   { name: 'docket', plugins: [{ name: 'docket', version: '0.2.0' }] }); // '0.2.0'
 * @see isMarketplace
 */
export function versionOf(path, json) {
  if (isMarketplace(path)) {
    return json?.plugins?.find(p => p?.name === json?.name)?.version;
  }
  return json?.version;
}

/**
 * Returns a copy of a parsed manifest with its version replaced.
 *
 * Pure: the input is not modified.
 *
 * @param {string} path     The manifest's repo-relative path.
 * @param {any} json        The parsed manifest.
 * @param {string} version  The new version, e.g. '0.2.0'.
 * @returns {any}  The updated manifest.
 * @throws {Error} When a marketplace has no plugin entry matching its own name.
 *
 * @example
 * withVersion('package.json', { name: 'x', version: '0.1.0' }, '0.2.0');
 * // { name: 'x', version: '0.2.0' }
 */
export function withVersion(path, json, version) {
  if (isMarketplace(path)) {
    const index = json.plugins?.findIndex(p => p?.name === json.name) ?? -1;
    if (index < 0) {
      throw new Error(`${path}: no plugin entry named "${json.name}" to version`);
    }
    const plugins = json.plugins.map((p, i) => (i === index ? { ...p, version } : p));
    return { ...json, plugins };
  }
  return { ...json, version };
}

/**
 * Reads and parses one manifest from disk.
 *
 * @param {string} root  Absolute path of the repo root.
 * @param {string} path  The manifest's repo-relative path.
 * @returns {Promise<any>}  The parsed JSON.
 * @throws {SyntaxError} When the file is not valid JSON.
 */
export async function readManifest(root, path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}

/**
 * Writes a manifest back to disk as two-space JSON with a trailing newline.
 *
 * @param {string} root  Absolute path of the repo root.
 * @param {string} path  The manifest's repo-relative path.
 * @param {any} json     The manifest to write.
 * @returns {Promise<void>}
 */
export async function writeManifest(root, path, json) {
  await writeFile(join(root, path), `${JSON.stringify(json, null, 2)}\n`, 'utf8');
}
