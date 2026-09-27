#!/usr/bin/env node
/**
 * Plans a release from Conventional Commits and, with --write, applies it.
 *
 * Reads the commits since the last `v*` tag (all commits if there is none),
 * computes the next version, and either prints the plan (`--dry-run`, the
 * default) or bumps every versioned manifest together and prepends a dated
 * section to CHANGELOG.md (`--write`). All manifests move at once because
 * each host reads its own and Claude Code's `/plugin update` does nothing
 * unless the version changes.
 *
 * It never commits, tags or pushes. Tagging and publishing need the owner's
 * explicit go-ahead, so the script prints the exact commands for a human to
 * run instead.
 *
 * Usage:
 *   npm run release                    # dry run: print the plan
 *   npm run release -- --write         # bump manifests, update CHANGELOG.md
 *   npm run release -- --version 1.0.0 --write   # force a version
 *   node src/scripts/release.mjs --repo ../other-skill   # plan another checkout
 *
 * @example
 * // With v0.1.0 tagged and a `feat:` commit since:
 * //   node src/scripts/release.mjs
 * //   Last release tag : v0.1.0
 * //   Next version     : 0.2.0 (minor)
 *
 * @see ./lib/conventional.mjs
 * @see ./lib/manifests.mjs
 * @see ./lint-commits.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MANIFESTS, versionOf, withVersion, readManifest, writeManifest } from './lib/manifests.mjs';
import { parseCommit, nextVersion } from './lib/conventional.mjs';
import { parse, format, fromTag, compare, isValid } from './lib/semver.mjs';

/** Repo-relative path of the changelog. */
export const CHANGELOG_PATH = 'CHANGELOG.md';

/** What a missing CHANGELOG.md is created with; mirrors the committed file. */
export const CHANGELOG_HEADER = [
  '# Changelog',
  '',
  'All notable changes to this project are documented in this file.',
  '',
  'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),',
  'and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).',
  '',
  '## [Unreleased]',
  '',
].join('\n');

/**
 * Changelog groups, in the order they are printed.
 *
 * Breaking commits go only under "Breaking changes", whatever their type.
 * docs/test/chore/ci/build/style/release commits are not user-facing and are
 * left out; write a note under `## [Unreleased]` by hand if one matters.
 *
 * @type {readonly { title: string, accepts: (c: import('./lib/conventional.mjs').Commit) => boolean }[]}
 */
export const CHANGELOG_GROUPS = Object.freeze([
  { title: 'Breaking changes', accepts: c => c.breaking },
  { title: 'Added',            accepts: c => !c.breaking && c.type === 'feat' },
  { title: 'Fixed',            accepts: c => !c.breaking && ['fix', 'hotfix'].includes(c.type) },
  { title: 'Changed',          accepts: c => !c.breaking && ['perf', 'refactor', 'revert'].includes(c.type) },
]);

/** Separators for `git log --format`: unit separator between fields, record separator between commits. */
const FIELD = '\x1f';
const RECORD = '\x1e';

/**
 * A commit read from git, parsed when its header is conventional.
 *
 * @typedef {object} LoggedCommit
 * @property {string} hash  Full commit hash.
 * @property {Readonly<import('./lib/conventional.mjs').Commit> | undefined} commit
 *   The parsed message, or undefined when it is not conventional.
 */

/**
 * Splits `git log --format=%H%x1f%B%x1e` output into hash/message records.
 *
 * @param {string} raw  The command's stdout.
 * @returns {{ hash: string, message: string }[]}  One record per commit, in
 *   log order (newest first).
 *
 * @example
 * parseLog('abc\x1ffeat: x\n\x1e\ndef\x1ffix: y\n\x1e\n');
 * // [{ hash: 'abc', message: 'feat: x' }, { hash: 'def', message: 'fix: y' }]
 */
export function parseLog(raw) {
  return raw
    .split(RECORD)
    .map(record => record.replace(/^\s+/, ''))
    .filter(record => record.includes(FIELD))
    .map(record => {
      const at = record.indexOf(FIELD);
      return { hash: record.slice(0, at).trim(), message: record.slice(at + 1).trim() };
    });
}

/**
 * Renders one changelog bullet for a commit.
 *
 * @param {LoggedCommit} logged  A commit with a parsed message.
 * @returns {string}  A Markdown list item; breaking notes follow as sub-items.
 *
 * @example
 * formatEntry({ hash: 'a1b2c3d4e5', commit: parseCommit('feat(skills): add docket') });
 * // '- **skills:** add docket (a1b2c3d)'
 */
export function formatEntry({ hash, commit }) {
  const scope = commit.scope ? `**${commit.scope}:** ` : '';
  const notes = commit.breakingNotes.map(note => `\n  - ${note}`).join('');
  return `- ${scope}${commit.subject} (${hash.slice(0, 7)})${notes}`;
}

/**
 * Sorts commits into the changelog groups, dropping empty groups.
 *
 * @param {readonly LoggedCommit[]} logged  Commits since the last release;
 *   unparseable ones are ignored.
 * @returns {{ title: string, entries: string[] }[]}  Non-empty groups in
 *   {@link CHANGELOG_GROUPS} order, entries oldest first.
 *
 * @example
 * groupCommits([{ hash: 'abcdef0', commit: parseCommit('fix: x') }]);
 * // [{ title: 'Fixed', entries: ['- x (abcdef0)'] }]
 */
export function groupCommits(logged) {
  const oldestFirst = logged.filter(l => l.commit).reverse();
  return CHANGELOG_GROUPS
    .map(({ title, accepts }) => ({
      title,
      entries: oldestFirst.filter(l => accepts(l.commit)).map(formatEntry),
    }))
    .filter(group => group.entries.length > 0);
}

/**
 * Renders the body of a release section: carried-over notes, then groups.
 *
 * @param {readonly { title: string, entries: string[] }[]} groups  From
 *   {@link groupCommits}.
 * @param {string} carried  Hand-written text moved out of `## [Unreleased]`;
 *   may be empty.
 * @returns {string}  Markdown without the `## [x.y.z]` heading.
 *
 * @example
 * renderSectionBody([{ title: 'Fixed', entries: ['- x (abcdef0)'] }], '');
 * // '### Fixed\n\n- x (abcdef0)'
 */
export function renderSectionBody(groups, carried) {
  const generated = groups.map(({ title, entries }) => `### ${title}\n\n${entries.join('\n')}`);
  const parts = [carried.trim(), ...generated].filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n') : '- No user-facing changes.';
}

/**
 * Finds the `## [Unreleased]` block in a changelog.
 *
 * @param {string[]} lines  The changelog split on newlines.
 * @returns {{ heading: number, end: number }}  Index of the heading line and
 *   of the first line after the block (the next `## ` heading, or the length).
 * @throws {Error} When there is no `## [Unreleased]` heading.
 */
export function findUnreleased(lines) {
  const heading = lines.findIndex(line => /^## \[Unreleased\]\s*$/i.test(line));
  if (heading < 0) {
    throw new Error(`${CHANGELOG_PATH} has no "## [Unreleased]" heading to release from`);
  }
  const next = lines.findIndex((line, i) => i > heading && /^## /.test(line));
  return { heading, end: next < 0 ? lines.length : next };
}

/**
 * Returns a changelog with a new release section below an emptied Unreleased.
 *
 * Anything written by hand under `## [Unreleased]` moves into the new
 * section, above the generated groups, as Keep a Changelog intends.
 *
 * @param {string} changelog  Current CHANGELOG.md text.
 * @param {string} version    The version being released, e.g. `0.2.0`.
 * @param {string} date       Release date as `YYYY-MM-DD`.
 * @param {readonly { title: string, entries: string[] }[]} groups  From
 *   {@link groupCommits}.
 * @returns {string}  The updated changelog.
 * @throws {Error} When the version already has a section (a second --write
 *   before committing), or there is no Unreleased heading.
 *
 * @example
 * insertRelease('# Changelog\n\n## [Unreleased]\n', '0.2.0', '2026-09-26',
 *   [{ title: 'Added', entries: ['- x (abcdef0)'] }]);
 * // '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-09-26\n\n### Added\n\n- x (abcdef0)\n'
 */
export function insertRelease(changelog, version, date, groups) {
  if (new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\]`, 'm').test(changelog)) {
    throw new Error(`${CHANGELOG_PATH} already has a section for ${version}; was --write run twice?`);
  }
  const lines = changelog.replace(/\r\n?/g, '\n').split('\n');
  const { heading, end } = findUnreleased(lines);
  const carried = lines.slice(heading + 1, end).join('\n');
  const section = `## [${version}] - ${date}\n\n${renderSectionBody(groups, carried)}`;
  const before = lines.slice(0, heading + 1).join('\n');
  const after = lines.slice(end).join('\n').replace(/^\n+/, '');
  return `${before}\n\n${section}\n${after ? `\n${after}` : ''}`.replace(/\n*$/, '\n');
}

/**
 * Picks the one version every versioned manifest agrees on.
 *
 * @param {readonly { path: string, version: string | undefined }[]} found
 *   Each versioned manifest's path and declared version.
 * @returns {string}  The shared version.
 * @throws {Error} When they disagree or one is missing or invalid; releasing
 *   from a split state would hide which host is stale.
 *
 * @example
 * agreedVersion([{ path: 'package.json', version: '0.1.0' },
 *   { path: 'plugin/.codex-plugin/plugin.json', version: '0.1.0' }]); // '0.1.0'
 */
export function agreedVersion(found) {
  const distinct = [...new Set(found.map(f => f.version))];
  if (distinct.length !== 1 || !isValid(distinct[0])) {
    const listing = found.map(f => `  ${f.path}: ${f.version ?? '(none)'}`).join('\n');
    throw new Error(`versioned manifests must agree on one valid version first (npm run validate):\n${listing}`);
  }
  return distinct[0];
}

/**
 * The decision the script reached.
 *
 * @typedef {object} Plan
 * @property {string} from    The manifests' current version.
 * @property {string} to      The version to release; equal to `from` when
 *   the manifests already hold an unreleased version or nothing is releasable.
 * @property {string} level   `major`/`minor`/`patch`/`none`, `forced`, or
 *   `as-is` (manifests already ahead of the last tag).
 * @property {boolean} releasable  False when there is nothing to release.
 */

/**
 * Decides the next version from manifests, the last tag and the commits.
 *
 * Rules: a forced version wins but must move forward; if the manifests hold a
 * version with no tag yet (the very first release, or a hand bump) that
 * version is released as-is; otherwise the commits decide.
 *
 * @param {object} input
 * @param {string} input.current   Version the manifests agree on.
 * @param {string | undefined} input.lastTag  Newest `v*` tag reachable from HEAD.
 * @param {readonly LoggedCommit[]} input.logged  Commits since that tag.
 * @param {string | undefined} input.forced  `--version`, if given.
 * @returns {Plan}  What to release.
 * @throws {Error} When the forced version is invalid or not ahead, or the
 *   manifests are behind the last tag.
 *
 * @example
 * planRelease({ current: '0.1.0', lastTag: 'v0.1.0', forced: undefined,
 *   logged: [{ hash: 'abc', commit: parseCommit('feat: x') }] });
 * // { from: '0.1.0', to: '0.2.0', level: 'minor', releasable: true }
 */
export function planRelease({ current, lastTag, logged, forced }) {
  const now = parse(current);
  const released = lastTag === undefined ? undefined : fromTag(lastTag);
  if (forced !== undefined) {
    return planForced(now, released, forced);
  }
  if (released === undefined || compare(now, released) > 0) {
    return { from: current, to: current, level: 'as-is', releasable: true };
  }
  if (compare(now, released) < 0) {
    throw new Error(`manifests say ${current} but the last tag is ${lastTag}; the manifests are behind`);
  }
  const { level, version } = nextVersion(now, logged.map(l => l.commit));
  return { from: current, to: format(version), level, releasable: level !== 'none' };
}

/**
 * Validates a `--version` override against the current state.
 *
 * @param {import('./lib/semver.mjs').Version} now  Manifests' version.
 * @param {import('./lib/semver.mjs').Version | undefined} released  Last tag's version.
 * @param {string} forced  The requested version.
 * @returns {Plan}  A forced plan.
 * @throws {TypeError} When `forced` is not `MAJOR.MINOR.PATCH`.
 * @throws {Error} When it is below the manifests or not above the last tag.
 */
export function planForced(now, released, forced) {
  const target = parse(forced);
  if (compare(target, now) < 0) {
    throw new Error(`--version ${forced} is below the manifests' ${format(now)}`);
  }
  if (released !== undefined && compare(target, released) <= 0) {
    throw new Error(`--version ${forced} is not above the last release ${format(released)}`);
  }
  return { from: format(now), to: forced, level: 'forced', releasable: true };
}

/**
 * Lists the commands a human runs after `--write` to ship the release.
 *
 * The release commit goes through a PR because main is protected; the tag is
 * created only after that PR merges, on the merged commit.
 *
 * @param {string} version  The released version, e.g. `0.2.0`.
 * @param {readonly string[]} files  Repo-relative paths `--write` changed.
 * @param {string} date  Today as `YYYY-MM-DD`, for the branch name.
 * @returns {string[]}  One shell command or instruction per line.
 *
 * @example
 * nextCommands('0.2.0', ['CHANGELOG.md', 'package.json'], '2026-09-26')[0];
 * // 'git switch -c release_26-09-26_v0-2-0'
 */
export function nextCommands(version, files, date) {
  const branch = `release_${date.slice(2)}_v${version.replaceAll('.', '-')}`;
  return [
    `git switch -c ${branch}`,
    'npm run validate',
    `git add ${files.join(' ')}`,
    `git commit -m "release: v${version}"`,
    `git push -u origin ${branch}`,
    '# open a PR, let CI pass and merge it into main, then on the merged main:',
    'git switch main',
    'git pull --ff-only',
    `git tag -a v${version} -m "v${version}"`,
    `git push origin v${version}`,
  ];
}

/**
 * Formats a date as `YYYY-MM-DD` in the local time zone, for changelog headings.
 *
 * Local rather than UTC so an evening release in the Americas is not dated
 * tomorrow.
 *
 * @param {Date} date  The moment to format.
 * @returns {string}  The local calendar date.
 *
 * @example
 * localIsoDate(new Date(2026, 8, 26, 23, 30)); // '2026-09-26'
 */
export function localIsoDate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Reads the command line.
 *
 * @param {string[]} argv  Arguments after the script path.
 * @returns {{ write: boolean, version: string | undefined, repo: string | undefined, help: boolean }}
 *   The chosen mode (dry run unless `--write`); `repo` is a directory inside
 *   the repo to release, when not the current one.
 * @throws {TypeError} On unknown options (from `util.parseArgs`).
 * @throws {Error} When `--write` and `--dry-run` are both given.
 *
 * @example
 * parseCli(['--write', '--version', '1.0.0']);
 * // { write: true, version: '1.0.0', repo: undefined, help: false }
 */
export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      'write':   { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'version': { type: 'string' },
      'repo':    { type: 'string' },
      'help':    { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.write && values['dry-run']) {
    throw new Error('choose one of --write and --dry-run');
  }
  return { write: values.write, version: values.version, repo: values.repo, help: values.help };
}

/**
 * Runs git with an argument array (no shell, so no metacharacter surprises).
 *
 * @param {string} cwd  Directory to run in.
 * @param {string[]} args  Git arguments.
 * @returns {string}  Stdout.
 * @throws {Error} When git exits non-zero.
 */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Finds the newest `vX.Y.Z` tag reachable from HEAD.
 *
 * @param {string} root  Repo root.
 * @returns {string | undefined}  The tag, or undefined when none exists.
 */
function lastReleaseTag(root) {
  return git(root, ['tag', '--list', 'v*', '--merged', 'HEAD', '--sort=-v:refname'])
    .split('\n')
    .map(t => t.trim())
    .find(t => fromTag(t) !== undefined);
}

/**
 * Reads and parses the commits after a tag, excluding merge commits.
 *
 * @param {string} root  Repo root.
 * @param {string | undefined} tag  Starting tag; all history when undefined.
 * @returns {LoggedCommit[]}  Newest first.
 */
function readCommits(root, tag) {
  const range = tag === undefined ? 'HEAD' : `${tag}..HEAD`;
  const raw = git(root, ['log', '--no-merges', `--format=%H${FIELD}%B${RECORD}`, range]);
  return parseLog(raw).map(({ hash, message }) => ({ hash, commit: parseCommit(message) }));
}

/**
 * Loads every versioned manifest with its current version.
 *
 * @param {string} root  Repo root.
 * @returns {Promise<{ path: string, json: any, version: string | undefined }[]>}
 * @throws {Error} When a manifest is missing or unparseable.
 */
async function loadManifests(root) {
  const versioned = MANIFESTS.filter(m => m.versioned);
  return Promise.all(versioned.map(async ({ path }) => {
    const json = await readManifest(root, path);
    return { path, json, version: versionOf(path, json) };
  }));
}

/**
 * Reads CHANGELOG.md, falling back to a fresh header when it does not exist.
 *
 * @param {string} root  Repo root.
 * @returns {Promise<string>}  The changelog text.
 */
async function loadChangelog(root) {
  try {
    return await readFile(join(root, CHANGELOG_PATH), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return CHANGELOG_HEADER;
    throw error;
  }
}

/**
 * Prints the plan, the changelog preview, and what comes next.
 *
 * @param {object} report  Everything worth showing.
 * @returns {void}
 */
function printPlan({ lastTag, plan, logged, groups, files, write, date }) {
  const conventional = logged.filter(l => l.commit).length;
  const lines = [
    `Last release tag : ${lastTag ?? '(none; first release)'}`,
    `Manifest version : ${plan.from}`,
    `Commits since    : ${logged.length} (${conventional} conventional, ${logged.length - conventional} ignored)`,
    `Next version     : ${plan.releasable ? `${plan.to} (${plan.level})` : '(nothing to release)'}`,
  ];
  console.log(lines.join('\n'));
  if (!plan.releasable) {
    console.log('\nNo feat, fix, hotfix, perf or breaking commits since the last tag.');
    console.log('Pass --version X.Y.Z to release anyway.');
    return;
  }
  console.log(`\nChangelog section:\n\n## [${plan.to}] - ${date}\n\n${renderSectionBody(groups, '')}\n`);
  console.log(`${write ? 'Updated' : 'Would update'}: ${files.join(', ')}`);
  if (!write) {
    console.log('\nDry run: nothing written. Re-run with --write to apply.');
    return;
  }
  console.log('\nThis script does not commit, tag or push. Next, by hand:\n');
  console.log(nextCommands(plan.to, files, date).map(c => `  ${c}`).join('\n'));
  console.log('\nPushing the tag publishes the release; do it only when you mean to ship.');
}

/**
 * Entry point: plan, print, and optionally write.
 *
 * @param {string[]} argv  Arguments after the script path.
 * @param {string} cwd     Directory inside the repo to release.
 * @returns {Promise<number>}  Process exit code.
 */
export async function main(argv, cwd) {
  const options = parseCli(argv);
  if (options.help) {
    console.log('usage: node src/scripts/release.mjs [--dry-run | --write] [--version X.Y.Z] [--repo DIR]');
    return 0;
  }
  const root = git(resolve(cwd, options.repo ?? '.'), ['rev-parse', '--show-toplevel']).trim();
  const manifests = await loadManifests(root);
  const current = agreedVersion(manifests);
  const lastTag = lastReleaseTag(root);
  const logged = readCommits(root, lastTag);
  const plan = planRelease({ current, lastTag, logged, forced: options.version });
  const date = localIsoDate(new Date());
  const groups = groupCommits(logged);
  const files = [CHANGELOG_PATH, ...manifests.map(m => m.path)];
  const changelog = plan.releasable
    ? insertRelease(await loadChangelog(root), plan.to, date, groups)
    : undefined;
  if (options.write && plan.releasable) {
    await Promise.all(manifests.map(m => writeManifest(root, m.path, withVersion(m.path, m.json, plan.to))));
    await writeFile(join(root, CHANGELOG_PATH), changelog, 'utf8');
  }
  printPlan({ lastTag, plan, logged, groups, files, write: options.write, date });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2), process.cwd())
    .then(code => { process.exitCode = code; })
    .catch(error => {
      console.error(`release: ${error.message}`);
      process.exitCode = 1;
    });
}
