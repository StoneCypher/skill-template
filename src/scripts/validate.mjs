/**
 * Validates a skill repo: frontmatter, names, manifests, versions, reference files, and what ships under plugin/.
 *
 * Reads the repo once into a snapshot, runs the pure checks in lib/checks.mjs
 * on it, prints findings grouped by check, and exits 1 on any error. Warnings
 * are printed but do not fail.
 *
 * Usage: node src/scripts/validate.mjs [root]   (root defaults to the cwd)
 *
 * @see ./lib/checks.mjs
 * @see ./checksums.mjs
 */

import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CHECKSUM_FILE, PLUGIN_LICENSE, parseChecksums, runChecks } from './lib/checks.mjs';
import { MANIFESTS, PLUGIN_ROOT, SKILLS_DIR } from './lib/manifests.mjs';
import { hashFiles, isMain, listReferenceFiles, listSubdirectories, readTextOrNull } from './checksums.mjs';

/**
 * True when a repo-relative path is an existing regular file.
 *
 * @param {string} root  Absolute repo root.
 * @param {string} path  Repo-relative path.
 * @returns {Promise<boolean>}
 */
async function isFile(root, path) {
  try {
    return (await stat(join(root, path))).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds every SKILL.md, which must sit at `plugin/skills/<name>/SKILL.md`.
 *
 * Codex accepts only a real subdirectory as its skills path, so a SKILL.md at
 * the repo or plugin root is never found (and never loads).
 *
 * @param {string} root  Absolute repo root.
 * @returns {Promise<string[]>}  Repo-relative paths, sorted.
 *
 * @example
 * await findSkillPaths('/repo'); // ['plugin/skills/skill-template/SKILL.md']
 *
 * @see SKILLS_DIR
 */
export async function findSkillPaths(root) {
  const candidates = (await listSubdirectories(join(root, SKILLS_DIR))).map(d => `${SKILLS_DIR}/${d}/SKILL.md`);
  const present = await Promise.all(candidates.map(p => isFile(root, p)));
  return candidates.filter((_, i) => present[i]);
}

/**
 * Lists everything under `plugin/`, so dev files that would reach users' caches can be flagged.
 *
 * `node_modules` folders are reported once, with a trailing `/`, and not
 * descended into: one is enough to warn about, and walking it would be slow.
 *
 * @param {string} root         Absolute repo root.
 * @param {string} [dir]        Repo-relative folder to list; defaults to the plugin root.
 * @returns {Promise<string[]>}  Repo-relative, forward-slash paths, sorted; [] when the folder is missing.
 *
 * @example
 * await listPluginPaths('/repo');
 * // ['plugin/.claude-plugin/plugin.json', 'plugin/LICENSE', 'plugin/skills/pdf/SKILL.md', ...]
 */
export async function listPluginPaths(root, dir = PLUGIN_ROOT) {
  let entries;
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
    throw err;
  }
  const nested = await Promise.all(entries.map(e => {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === 'node_modules' ? [`${path}/`] : listPluginPaths(root, path);
    return e.isFile() ? [path] : [];
  }));
  return nested.flat().sort();
}

/**
 * Reads everything the checks need from a repo.
 *
 * @param {string} root  Absolute repo root.
 * @returns {Promise<import('./lib/checks.mjs').RepoSnapshot>}
 */
export async function readSnapshot(root) {
  const skillPaths = await findSkillPaths(root);
  const skills = await Promise.all(skillPaths.map(async path => ({ path, text: await readTextOrNull(root, path) ?? '' })));
  const manifests = await Promise.all(MANIFESTS.map(async m => ({ ...m, text: await readTextOrNull(root, m.path) })));
  const checksumText = await readTextOrNull(root, CHECKSUM_FILE);
  const referencePaths = await listReferenceFiles(root);
  const listed = checksumText === null ? [] : Object.keys(parseChecksums(checksumText).listed);
  const hashes = await hashFiles(root, [...new Set([...listed, ...referencePaths])]);
  const rootLicense = await readTextOrNull(root, 'LICENSE');
  const pluginLicense = await readTextOrNull(root, PLUGIN_LICENSE);
  const pluginPaths = await listPluginPaths(root);
  return { skills, manifests, checksumText, referencePaths, hashes, rootLicense, pluginLicense, pluginPaths };
}

/**
 * Formats findings for the terminal, grouped by check in first-seen order.
 *
 * @param {import('./lib/checks.mjs').Finding[]} findings  From runChecks.
 * @returns {string}  The report, ending in a one-line summary.
 *
 * @example
 * formatFindings([{ level: 'warn', check: 'guard', message: 'SKILL.md: no guard' }]);
 * // '[guard]\n  warn   SKILL.md: no guard\n\n0 errors, 1 warning'
 */
export function formatFindings(findings) {
  const groups = [...new Set(findings.map(f => f.check))];
  const sections = groups.map(group => [
    `[${group}]`,
    ...findings.filter(f => f.check === group).map(f => `  ${f.level.padEnd(5)}  ${f.message}`),
  ].join('\n'));
  const errors = findings.filter(f => f.level === 'error').length;
  const warnings = findings.length - errors;
  const summary = `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`;
  return [...sections, summary].join('\n\n');
}

/**
 * Runs the command line: validate one repo and report.
 *
 * @param {string[]} args  Arguments after the script name: an optional root path.
 * @returns {Promise<number>}  The exit code: 1 when any finding is an error, else 0.
 */
export async function main(args) {
  const root = resolve(args[0] ?? process.cwd());
  const findings = runChecks(await readSnapshot(root));
  console.log(`Validating ${root}\n\n${formatFindings(findings)}`);
  return findings.some(f => f.level === 'error') ? 1 : 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
