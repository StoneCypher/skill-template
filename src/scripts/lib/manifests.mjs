/**
 * Knows every manifest this repo ships, and where each keeps its version.
 *
 * Every host reads its own manifest, and Claude Code's `/plugin update` does
 * nothing unless the version moves, so all versioned manifests must agree.
 * This module is the one place that lists them; the validator and the release
 * script both read it.
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

/** @type {readonly ManifestSpec[]} */
export const MANIFESTS = Object.freeze([
  { path: '.claude-plugin/plugin.json',      host: 'Claude Code',        versioned: true },
  { path: '.claude-plugin/marketplace.json', host: 'Claude Code',        versioned: true },
  { path: '.codex-plugin/plugin.json',       host: 'Codex',              versioned: true },
  { path: 'plugin.json',                     host: 'Antigravity',        versioned: false },
  { path: 'package.json',                    host: 'npm (repo tooling)', versioned: true },
]);

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
 * versionOf('.codex-plugin/plugin.json', { version: '0.1.0' }); // '0.1.0'
 * @example
 * versionOf('.claude-plugin/marketplace.json',
 *   { name: 'docket', plugins: [{ name: 'docket', version: '0.2.0' }] }); // '0.2.0'
 */
export function versionOf(path, json) {
  if (path.endsWith('marketplace.json')) {
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
  if (path.endsWith('marketplace.json')) {
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
