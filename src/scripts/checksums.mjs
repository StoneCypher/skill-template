/**
 * Records or verifies sha256 checksums of the skill's reference files.
 *
 * Reference files (anything under `skills/<name>/references/`, or
 * `references/` for a root-level SKILL.md) are loaded by the model on
 * demand, whether written for this skill or copied in, and should change
 * only on purpose. `.github/reference-checksums.json` pins them;
 * `npm run validate` fails when a pinned file drifts or a new one appears
 * unrecorded, so every edit is a deliberate `npm run checksums`.
 *
 * Usage:
 *   node src/scripts/checksums.mjs [root]           report drift; exit 1 if any
 *   node src/scripts/checksums.mjs --write [root]   rewrite the checksum file
 *
 * This module also holds the repo-reading helpers validate.mjs shares.
 *
 * @see ./lib/checks.mjs
 * @see ./validate.mjs
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKSUM_FILE, diffChecksums, parseChecksums, serializeChecksums } from './lib/checks.mjs';

/**
 * Turns CRLF into LF in raw bytes, so checksums agree across platforms.
 *
 * Git's `core.autocrlf` rewrites text files to CRLF on Windows checkouts and
 * LF on Linux CI; hashing the raw bytes would make the same commit fail on
 * one of them. Bytes round-trip exactly through latin1.
 *
 * @param {Buffer} bytes  File contents.
 * @returns {Buffer}  The contents with every CR LF pair replaced by LF.
 *
 * @example
 * normalizeEol(Buffer.from('a\r\nb')).toString(); // 'a\nb'
 */
export const normalizeEol = bytes => Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');

/**
 * Hashes file contents for the checksum file, line endings normalised.
 *
 * @param {Buffer} bytes  File contents.
 * @returns {string}  Lowercase sha256 hex of the LF-normalised bytes.
 *
 * @example
 * sha256(Buffer.from('')); // 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
 *
 * @see normalizeEol
 */
export const sha256 = bytes => createHash('sha256').update(normalizeEol(bytes)).digest('hex');

/**
 * Converts an absolute path under root into a repo-relative, forward-slash path.
 *
 * @param {string} root  Absolute repo root.
 * @param {string} abs   Absolute path inside it.
 * @returns {string}  e.g. `skills/pdf/references/spec.md`.
 */
const toRepoPath = (root, abs) => relative(root, abs).split(sep).join('/');

/**
 * True when an error means "no such file or directory".
 *
 * @param {unknown} err  A caught error.
 * @returns {boolean}
 */
const isMissing = err => err?.code === 'ENOENT' || err?.code === 'ENOTDIR';

/**
 * Lists every regular file below a directory, recursively.
 *
 * @param {string} dir  Absolute directory path; a missing directory yields [].
 * @returns {Promise<string[]>}  Absolute file paths.
 */
async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const nested = await Promise.all(entries.map(e => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return Promise.resolve(e.isFile() ? [full] : []);
  }));
  return nested.flat();
}

/**
 * Lists the names of a directory's subdirectories.
 *
 * @param {string} dir  Absolute directory path; a missing directory yields [].
 * @returns {Promise<string[]>}  Subdirectory names, sorted.
 */
export async function listSubdirectories(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

/**
 * Lists every reference file in a repo.
 *
 * @param {string} root  Absolute repo root.
 * @returns {Promise<string[]>}  Repo-relative paths under
 *   `skills/<name>/references/` and root `references/`, sorted.
 *
 * @example
 * await listReferenceFiles('/repo'); // ['skills/pdf/references/spec.md']
 */
export async function listReferenceFiles(root) {
  const skillDirs = await listSubdirectories(join(root, 'skills'));
  const dirs = [...skillDirs.map(d => join(root, 'skills', d, 'references')), join(root, 'references')];
  const files = (await Promise.all(dirs.map(walk))).flat();
  return files.map(f => toRepoPath(root, f)).sort();
}

/**
 * Reads a repo file as text, or null when it does not exist.
 *
 * @param {string} root  Absolute repo root.
 * @param {string} path  Repo-relative path.
 * @returns {Promise<string | null>}
 */
export async function readTextOrNull(root, path) {
  try {
    return await readFile(join(root, path), 'utf8');
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * Hashes a set of repo files.
 *
 * @param {string} root     Absolute repo root.
 * @param {string[]} paths  Repo-relative paths.
 * @returns {Promise<Record<string, string | null>>}  Path -> sha256 hex, or
 *   null for a file that does not exist.
 *
 * @example
 * await hashFiles('/repo', ['skills/pdf/references/spec.md', 'gone.md']);
 * // { 'skills/pdf/references/spec.md': '9f86d0...', 'gone.md': null }
 */
export async function hashFiles(root, paths) {
  const pairs = await Promise.all(paths.map(async p => {
    try {
      return [p, sha256(await readFile(join(root, p)))];
    } catch (err) {
      if (isMissing(err)) return [p, null];
      throw err;
    }
  }));
  return Object.fromEntries(pairs);
}

/**
 * Tells whether a module is the script Node was started with.
 *
 * @param {string} moduleUrl  The module's `import.meta.url`.
 * @returns {boolean}  True when run directly, false when imported.
 */
export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(moduleUrl);
  const started = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === started.toLowerCase() : self === started;
}

/**
 * Formats a checksum drift report.
 *
 * @param {{ missing: string[], changed: string[], unlisted: string[] }} diff  From diffChecksums.
 * @returns {string[]}  One line per drifted file; empty when in sync.
 *
 * @example
 * describeDrift({ missing: [], changed: ['a.md'], unlisted: [] }); // ['  changed   a.md']
 */
export const describeDrift = ({ missing, changed, unlisted }) => [
  ...missing.map(p => `  removed   ${p}`),
  ...changed.map(p => `  changed   ${p}`),
  ...unlisted.map(p => `  added     ${p}`),
];

/**
 * Runs the command line: report drift, or rewrite the checksum file.
 *
 * @param {string[]} args  Arguments after the script name: `--write` and/or a root path.
 * @returns {Promise<number>}  The exit code: 1 on drift in report mode, else 0.
 */
export async function main(args) {
  const write = args.includes('--write');
  const root = resolve(args.find(a => !a.startsWith('--')) ?? process.cwd());
  const references = await listReferenceFiles(root);
  const existing = await readTextOrNull(root, CHECKSUM_FILE);
  const listed = existing === null ? {} : parseChecksums(existing).listed;
  const actual = await hashFiles(root, [...new Set([...Object.keys(listed), ...references])]);
  const drift = describeDrift(diffChecksums(listed, actual, references));
  if (write) {
    if (references.length === 0 && existing === null) {
      console.log('No reference files; no checksum file needed.');
      return 0;
    }
    const current = Object.fromEntries(references.map(p => [p, actual[p]]));
    await mkdir(dirname(join(root, CHECKSUM_FILE)), { recursive: true });
    await writeFile(join(root, CHECKSUM_FILE), serializeChecksums(current), 'utf8');
    console.log(`Wrote ${CHECKSUM_FILE} (${references.length} file(s)).${drift.length ? `\n${drift.join('\n')}` : ''}`);
    return 0;
  }
  if (drift.length === 0) {
    console.log(`${CHECKSUM_FILE} is up to date (${references.length} file(s)).`);
    return 0;
  }
  console.log(`${CHECKSUM_FILE} is out of date; run npm run checksums if these changes are deliberate:\n${drift.join('\n')}`);
  return 1;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
