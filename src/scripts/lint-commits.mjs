#!/usr/bin/env node
/**
 * Fails when any commit in a range lacks a valid Conventional Commits header.
 *
 * The release script computes versions from commit headers, so a header it
 * cannot read is a change it silently leaves out of the version and the
 * changelog. CI runs this over every PR's commits to stop that at the door.
 * Merge commits are skipped; `fixup!`/`squash!` commits fail on purpose, so
 * they get squashed before merge.
 *
 * Usage:
 *   node src/scripts/lint-commits.mjs origin/main..HEAD
 *
 * Exit codes: 0 all valid (or the range is empty), 1 offenders found,
 * 2 the range could not be read.
 *
 * @example
 * // node src/scripts/lint-commits.mjs origin/main..HEAD
 * // 2 commits in origin/main..HEAD; 1 invalid:
 * //   3f2a9c1 "Update README"
 * //     - header is not in "type(scope)!: subject" form (...)
 *
 * @see ./lib/conventional.mjs
 * @see ../../.github/workflows/commits.yml
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateHeader } from './lib/conventional.mjs';

/** Separators for `git log --format`: unit separator between fields, record separator between commits. */
const FIELD = '\x1f';
const RECORD = '\x1e';

/**
 * One commit that failed the header rules.
 *
 * @typedef {object} Offender
 * @property {string} hash     Full commit hash.
 * @property {string} header   The first line of its message.
 * @property {readonly string[]} problems  Why it failed.
 */

/**
 * Splits `git log --format=%H%x1f%B%x1e` output into hash/header pairs.
 *
 * @param {string} raw  The command's stdout.
 * @returns {{ hash: string, header: string }[]}  One entry per commit; the
 *   header is the message's first line, trimmed.
 *
 * @example
 * parseRecords('abc\x1ffix: x\n\nbody\x1e\n');
 * // [{ hash: 'abc', header: 'fix: x' }]
 */
export function parseRecords(raw) {
  return raw
    .split(RECORD)
    .map(record => record.replace(/^\s+/, ''))
    .filter(record => record.includes(FIELD))
    .map(record => {
      const at = record.indexOf(FIELD);
      const message = record.slice(at + 1).replace(/^\s+/, '');
      return { hash: record.slice(0, at).trim(), header: message.split(/\r?\n/, 1)[0].trim() };
    });
}

/**
 * Keeps only the commits whose headers break the rules.
 *
 * @param {readonly { hash: string, header: string }[]} records  From
 *   {@link parseRecords}.
 * @returns {Offender[]}  Offenders in input order; empty when all pass.
 *
 * @example
 * findOffenders([{ hash: 'a', header: 'feat: ok' }, { hash: 'b', header: 'wip' }]);
 * // [{ hash: 'b', header: 'wip', problems: ['header is not in ...'] }]
 * @see validateHeader
 */
export function findOffenders(records) {
  return records
    .map(({ hash, header }) => ({ hash, header, problems: validateHeader(header) }))
    .filter(({ problems }) => problems.length > 0);
}

/**
 * Formats the result for a CI log.
 *
 * @param {string} range  The range that was checked.
 * @param {number} total  How many commits it held.
 * @param {readonly Offender[]} offenders  From {@link findOffenders}.
 * @returns {string}  A summary line, then one block per offender.
 *
 * @example
 * formatReport('a..b', 3, []); // '3 commits in a..b; all have valid Conventional Commits headers.'
 */
export function formatReport(range, total, offenders) {
  if (offenders.length === 0) {
    return `${total} commit${total === 1 ? '' : 's'} in ${range}; all have valid Conventional Commits headers.`;
  }
  const blocks = offenders.map(({ hash, header, problems }) =>
    `  ${hash.slice(0, 7)} ${JSON.stringify(header)}\n${problems.map(p => `    - ${p}`).join('\n')}`);
  return [
    `${total} commit${total === 1 ? '' : 's'} in ${range}; ${offenders.length} invalid:`,
    ...blocks,
    '',
    'Reword them (git rebase -i, then "reword") to "type(scope)!: subject", e.g. "fix(loader): handle empty folder".',
  ].join('\n');
}

/**
 * Reads the non-merge commits in a range.
 *
 * @param {string} cwd    Directory inside the repo.
 * @param {string} range  Any revision range git accepts, e.g. `origin/main..HEAD`.
 * @returns {{ hash: string, header: string }[]}  Newest first.
 * @throws {Error} When git cannot resolve the range (often a shallow clone).
 */
function readRange(cwd, range) {
  const raw = execFileSync('git', ['log', '--no-merges', `--format=%H${FIELD}%B${RECORD}`, range, '--'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return parseRecords(raw);
}

/**
 * Reads a range, returning the failure instead of throwing it.
 *
 * @param {string} cwd    Directory inside the repo.
 * @param {string} range  Revision range.
 * @returns {{ records?: { hash: string, header: string }[], error?: any }}
 *   Exactly one of the two is set.
 */
function tryReadRange(cwd, range) {
  try {
    return { records: readRange(cwd, range) };
  } catch (error) {
    return { error };
  }
}

/**
 * Entry point: lint one range and report.
 *
 * @param {string[]} argv  Arguments after the script path; exactly one range.
 * @param {string} cwd     Directory inside the repo.
 * @returns {number}  Exit code: 0 clean, 1 offenders, 2 usage or git error.
 */
export function main(argv, cwd) {
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    console.error('usage: node src/scripts/lint-commits.mjs <range>   (e.g. origin/main..HEAD)');
    return 2;
  }
  const [range] = argv;
  const { records, error } = tryReadRange(cwd, range);
  if (error) {
    console.error(`lint-commits: could not read ${range}: ${String(error.stderr || error.message).trim()}`);
    console.error('If this ran in CI, the checkout was probably shallow; use fetch-depth: 0.');
    return 2;
  }
  const offenders = findOffenders(records);
  const report = formatReport(range, records.length, offenders);
  (offenders.length > 0 ? console.error : console.log)(report);
  return offenders.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2), process.cwd());
}
