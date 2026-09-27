/**
 * Validates a skill repo: frontmatter, names, manifests, versions, vendored files.
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

import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CHECKSUM_FILE, parseChecksums, runChecks } from './lib/checks.mjs';
import { MANIFESTS } from './lib/manifests.mjs';
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
 * Finds every SKILL.md in either supported layout.
 *
 * Skills may sit at `skills/<name>/SKILL.md` or, for a single-skill repo, at
 * the root as `SKILL.md`; both are found so the layout can change without
 * touching the validator.
 *
 * @param {string} root  Absolute repo root.
 * @returns {Promise<string[]>}  Repo-relative paths, root first, then sorted.
 *
 * @example
 * await findSkillPaths('/repo'); // ['skills/skill-template/SKILL.md']
 */
export async function findSkillPaths(root) {
  const nested = (await listSubdirectories(join(root, 'skills'))).map(d => `skills/${d}/SKILL.md`);
  const candidates = ['SKILL.md', ...nested];
  const present = await Promise.all(candidates.map(p => isFile(root, p)));
  return candidates.filter((_, i) => present[i]);
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
  return { skills, manifests, checksumText, referencePaths, hashes };
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
