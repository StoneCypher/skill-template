/**
 * Reads Conventional Commits 1.0.0 messages and turns them into a bump level.
 *
 * The release script uses this to compute the next version from history, and
 * the commit linter uses {@link validateHeader} to hold every PR commit to the
 * same grammar, so a release is never computed from messages it cannot read.
 * Every export is pure.
 *
 * Bump rules, in order of precedence:
 *
 * | Commit                                   | Level  |
 * |------------------------------------------|--------|
 * | `type!:` or a `BREAKING CHANGE:` footer  | major  |
 * | `feat`                                   | minor  |
 * | `fix`, `hotfix`, `perf`                  | patch  |
 * | anything else                            | none   |
 *
 * Pre-1.0 rule (see {@link adjustForPreMajor}): while the major version is 0,
 * a breaking change bumps minor instead of major. `feat` still bumps minor and
 * fixes still bump patch. Reaching 1.0.0 is a decision, made by passing
 * `--version 1.0.0` to the release script, never a side effect of a `!`.
 *
 * @see https://www.conventionalcommits.org/en/v1.0.0/
 * @see ./semver.mjs
 * @see ../release.mjs
 * @see ../lint-commits.mjs
 */

import { bump, maxLevel } from './semver.mjs';

/**
 * The commit types this repo accepts, matching the owner's branch-type list.
 *
 * @type {readonly string[]}
 */
export const COMMIT_TYPES = Object.freeze([
  'feat', 'fix', 'hotfix', 'docs', 'refactor', 'perf', 'test',
  'chore', 'ci', 'build', 'style', 'release', 'revert',
]);

/**
 * The longest header the linter accepts, in characters.
 *
 * 100 is commitlint's default; it keeps `git log --oneline` readable without
 * forcing awkward abbreviation.
 */
export const MAX_HEADER_LENGTH = 100;

/** Types that are user-visible fixes and therefore bump patch. */
const PATCH_TYPES = Object.freeze(new Set(['fix', 'hotfix', 'perf']));

/** `type(scope)!: subject` — scope and `!` optional, exactly one space after the colon. */
const HEADER_RE = /^(?<type>[A-Za-z]+)(?:\((?<scope>[^()\r\n]+)\))?(?<bang>!)?: (?<subject>\S.*)$/;

/** A `BREAKING CHANGE:` or `BREAKING-CHANGE:` footer line (the token is case-sensitive per spec). */
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:\s*(.*)$/gm;

/**
 * The structured form of one header line.
 *
 * @typedef {object} Header
 * @property {string} type          Commit type as written, e.g. `feat`.
 * @property {string | undefined} scope  Parenthesised scope, if any.
 * @property {boolean} bang         True when `!` marks the header breaking.
 * @property {string} subject       Text after `: `.
 */

/**
 * The structured form of a whole commit message.
 *
 * @typedef {Header & {
 *   header: string,
 *   body: string,
 *   breaking: boolean,
 *   breakingNotes: readonly string[],
 * }} Commit
 * `breaking` is true for a `!` header or any breaking footer; `breakingNotes`
 * holds the footer descriptions, in order, for the changelog.
 */

/**
 * Splits a header line into its parts, without judging the type.
 *
 * @param {string} header  The first line of a commit message.
 * @returns {Readonly<Header> | undefined}  The parts, or undefined when the
 *   line is not in `type(scope)!: subject` form.
 *
 * @example
 * parseHeader('feat(cli)!: drop --legacy');
 * // { type: 'feat', scope: 'cli', bang: true, subject: 'drop --legacy' }
 * @example
 * parseHeader('Update README'); // undefined
 */
export function parseHeader(header) {
  const groups = HEADER_RE.exec(header)?.groups;
  return groups && Object.freeze({
    type: groups.type,
    scope: groups.scope,
    bang: groups.bang === '!',
    subject: groups.subject,
  });
}

/**
 * Collects the descriptions of every breaking-change footer in a body.
 *
 * @param {string} body  Everything after the header line.
 * @returns {readonly string[]}  Footer descriptions; empty when none.
 *
 * @example
 * breakingNotesOf('Details.\n\nBREAKING CHANGE: config moved to .skillrc');
 * // ['config moved to .skillrc']
 */
export function breakingNotesOf(body) {
  return Object.freeze([...body.matchAll(BREAKING_FOOTER_RE)].map(m => m[1].trim()));
}

/**
 * Parses a full commit message, header and body.
 *
 * @param {string} message  The raw message as `git log --format=%B` prints it;
 *   CRLF line endings are tolerated.
 * @returns {Readonly<Commit> | undefined}  The parsed commit, or undefined when
 *   the header is not conventional (such commits cannot move the version).
 *
 * @example
 * parseCommit('fix: handle empty skill folder\n\nCloses #12');
 * // { type: 'fix', subject: 'handle empty skill folder', breaking: false, ... }
 * @example
 * parseCommit('refactor: split loader\n\nBREAKING-CHANGE: load() is async').breaking; // true
 */
export function parseCommit(message) {
  const [first = '', ...rest] = String(message).replace(/\r\n?/g, '\n').split('\n');
  const header = first.trim();
  const parsed = parseHeader(header);
  if (!parsed) {
    return undefined;
  }
  const body = rest.join('\n').trim();
  const breakingNotes = breakingNotesOf(body);
  return Object.freeze({
    ...parsed,
    header,
    body,
    breaking: parsed.bang || breakingNotes.length > 0,
    breakingNotes,
  });
}

/**
 * Checks a header against this repo's commit rules, for linting PRs.
 *
 * @param {string} header  The first line of a commit message.
 * @returns {readonly string[]}  Human-readable problems; empty means valid.
 *
 * @example
 * validateHeader('feat(skills): add docket skill'); // []
 * @example
 * validateHeader('Feat: add thing');
 * // ['unknown type "Feat" (types are lowercase; allowed: feat, fix, ...)']
 * @see COMMIT_TYPES
 */
export function validateHeader(header) {
  const text = String(header ?? '');
  const parsed = parseHeader(text);
  const lengthProblem = text.length > MAX_HEADER_LENGTH
    ? [`header is ${text.length} characters; the limit is ${MAX_HEADER_LENGTH}`]
    : [];
  if (!parsed) {
    return Object.freeze([
      'header is not in "type(scope)!: subject" form (e.g. "fix(loader): handle empty folder")',
      ...lengthProblem,
    ]);
  }
  const typeProblem = COMMIT_TYPES.includes(parsed.type)
    ? []
    : [`unknown type "${parsed.type}" (types are lowercase; allowed: ${COMMIT_TYPES.join(', ')})`];
  return Object.freeze([...typeProblem, ...lengthProblem]);
}

/**
 * Says how far one parsed commit, on its own, would move the version.
 *
 * @param {Commit} commit  A result of {@link parseCommit}.
 * @returns {'none' | 'patch' | 'minor' | 'major'}  The commit's level, before
 *   the pre-1.0 adjustment.
 *
 * @example
 * levelOf(parseCommit('perf: cache manifest reads')); // 'patch'
 * levelOf(parseCommit('docs: fix typo')); // 'none'
 */
export function levelOf(commit) {
  if (commit.breaking) return 'major';
  if (commit.type === 'feat') return 'minor';
  if (PATCH_TYPES.has(commit.type)) return 'patch';
  return 'none';
}

/**
 * Finds the largest level among a set of commits.
 *
 * @param {Iterable<Commit | undefined>} commits  Parsed commits; undefined
 *   entries (unparseable messages) are skipped.
 * @returns {'none' | 'patch' | 'minor' | 'major'}  `none` for an empty set.
 *
 * @example
 * bumpLevel(['fix: a', 'feat: b', 'docs: c'].map(parseCommit)); // 'minor'
 */
export function bumpLevel(commits) {
  return [...commits].filter(Boolean).map(levelOf).reduce(maxLevel, 'none');
}

/**
 * Applies the pre-1.0 rule: at major 0, a breaking change bumps minor.
 *
 * Chosen because SemVer §4 says anything may change before 1.0.0, so a major
 * bump is not required to signal breakage there; because the owner's other
 * projects (rackled.com via /sc-commit) sit at 0.x and advance minor per
 * change; and because an accidental `!` should never declare the API stable.
 * This matches release-please's `bump-minor-pre-major`. Features are not
 * demoted to patch (release-please's optional `bump-patch-for-minor-pre-major`),
 * so a 0.x minor still means "something new or something broke" and a patch
 * still means "fixes only".
 *
 * @param {string} level  The raw level from {@link bumpLevel}.
 * @param {import('./semver.mjs').Version} current  The version being bumped from.
 * @returns {'none' | 'patch' | 'minor' | 'major'}  The level to actually apply.
 *
 * @example
 * adjustForPreMajor('major', { major: 0, minor: 4, patch: 1 }); // 'minor'
 * adjustForPreMajor('major', { major: 1, minor: 4, patch: 1 }); // 'major'
 */
export function adjustForPreMajor(level, current) {
  return current.major === 0 && level === 'major' ? 'minor' : maxLevel(level, 'none');
}

/**
 * Computes the version a set of commits calls for.
 *
 * @param {import('./semver.mjs').Version} current  The last released version.
 * @param {Iterable<Commit | undefined>} commits  Commits since that release.
 * @returns {{ level: string, version: Readonly<import('./semver.mjs').Version> }}
 *   The applied level and the resulting version (equal to `current` when the
 *   level is `none`).
 *
 * @example
 * nextVersion({ major: 0, minor: 1, patch: 0 }, [parseCommit('feat!: new layout')]);
 * // { level: 'minor', version: { major: 0, minor: 2, patch: 0 } }
 * @see adjustForPreMajor
 */
export function nextVersion(current, commits) {
  const level = adjustForPreMajor(bumpLevel(commits), current);
  return { level, version: bump(current, level) };
}
