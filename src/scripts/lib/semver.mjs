/**
 * Parses, formats, compares and bumps plain `MAJOR.MINOR.PATCH` versions.
 *
 * Exists so the release script can compute the next version with no npm
 * dependency. Deliberately narrower than full SemVer 2.0.0: pre-release and
 * build suffixes (`1.0.0-rc.1`, `1.0.0+abc`) are rejected, because no host
 * manifest this repo ships needs them and a stricter grammar catches typos.
 * Every function is pure.
 *
 * @see ./conventional.mjs
 * @see ../release.mjs
 */

/**
 * The bump levels, least to most significant; index order is significance.
 *
 * `none` means "nothing releasable happened", not "release the same number".
 *
 * @type {readonly ('none' | 'patch' | 'minor' | 'major')[]}
 */
export const LEVELS = Object.freeze(['none', 'patch', 'minor', 'major']);

/**
 * A parsed version.
 *
 * @typedef {object} Version
 * @property {number} major  Incompatible-change counter; 0 means "not yet stable".
 * @property {number} minor  Feature counter within a major.
 * @property {number} patch  Fix counter within a minor.
 */

/** Accepts `1.2.3`; no leading zeros (SemVer 2.0.0 §2), no `v`, no suffixes. */
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Parses a version string into its three numeric parts.
 *
 * @param {string} text  A plain version such as `0.1.0`. A leading `v` is not
 *   accepted here; strip it first (see {@link fromTag}).
 * @returns {Readonly<Version>}  The frozen parts.
 * @throws {TypeError} When the text is not exactly `MAJOR.MINOR.PATCH`, or a
 *   part exceeds `Number.MAX_SAFE_INTEGER`.
 *
 * @example
 * parse('0.4.2'); // { major: 0, minor: 4, patch: 2 }
 * @example
 * parse('1.0.0-rc.1'); // throws TypeError
 */
export function parse(text) {
  const match = VERSION_RE.exec(String(text));
  if (!match) {
    throw new TypeError(`not a MAJOR.MINOR.PATCH version: ${JSON.stringify(text)}`);
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new TypeError(`version part too large: ${JSON.stringify(text)}`);
  }
  return Object.freeze({ major, minor, patch });
}

/**
 * Reports whether a string is a version {@link parse} would accept.
 *
 * @param {string} text  Candidate version.
 * @returns {boolean}  True when parseable.
 *
 * @example
 * isValid('0.1.0'); // true
 * isValid('v0.1.0'); // false
 */
export function isValid(text) {
  try {
    parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turns parsed parts back into the canonical string.
 *
 * @param {Version} version  Parts to join.
 * @returns {string}  e.g. `0.2.0`.
 *
 * @example
 * format({ major: 1, minor: 2, patch: 3 }); // '1.2.3'
 */
export function format({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

/**
 * Reads the version out of a release tag name.
 *
 * @param {string} tag  A tag such as `v0.3.1`; the `v` prefix is required,
 *   matching the `v*` tags the release checklist creates.
 * @returns {Readonly<Version> | undefined}  The version, or undefined when the
 *   tag is not a `v`-prefixed plain version (e.g. `v1`, `latest`).
 *
 * @example
 * fromTag('v0.3.1'); // { major: 0, minor: 3, patch: 1 }
 * fromTag('nightly'); // undefined
 */
export function fromTag(tag) {
  return tag.startsWith('v') && isValid(tag.slice(1)) ? parse(tag.slice(1)) : undefined;
}

/**
 * Orders two versions by precedence.
 *
 * @param {Version} a  Left operand.
 * @param {Version} b  Right operand.
 * @returns {-1 | 0 | 1}  Negative when `a` precedes `b`, zero when equal.
 *
 * @example
 * compare(parse('0.9.0'), parse('0.10.0')); // -1 (numeric, not lexical)
 */
export function compare(a, b) {
  const diff = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  return /** @type {-1 | 0 | 1} */ (Math.sign(diff));
}

/**
 * Picks the more significant of two bump levels.
 *
 * @param {string} a  A member of {@link LEVELS}.
 * @param {string} b  A member of {@link LEVELS}.
 * @returns {'none' | 'patch' | 'minor' | 'major'}  Whichever ranks higher.
 * @throws {RangeError} When either is not a known level.
 *
 * @example
 * maxLevel('patch', 'minor'); // 'minor'
 */
export function maxLevel(a, b) {
  return LEVELS[Math.max(rankOf(a), rankOf(b))];
}

/**
 * Finds a level's position in {@link LEVELS}.
 *
 * @param {string} level  Candidate level.
 * @returns {number}  0 for `none` through 3 for `major`.
 * @throws {RangeError} When the level is unknown.
 */
export function rankOf(level) {
  const rank = LEVELS.indexOf(/** @type {any} */ (level));
  if (rank < 0) {
    throw new RangeError(`unknown bump level: ${JSON.stringify(level)}`);
  }
  return rank;
}

/**
 * Returns the version after applying a bump; lower parts reset to zero.
 *
 * @param {Version} version  The current version.
 * @param {string} level     A member of {@link LEVELS}; `none` returns an
 *   equal copy.
 * @returns {Readonly<Version>}  The bumped version.
 * @throws {RangeError} When the level is unknown.
 *
 * @example
 * format(bump(parse('1.3.7'), 'minor')); // '1.4.0'
 * @example
 * format(bump(parse('1.3.7'), 'major')); // '2.0.0'
 */
export function bump({ major, minor, patch }, level) {
  switch (LEVELS[rankOf(level)]) {
    case 'major': return Object.freeze({ major: major + 1, minor: 0, patch: 0 });
    case 'minor': return Object.freeze({ major, minor: minor + 1, patch: 0 });
    case 'patch': return Object.freeze({ major, minor, patch: patch + 1 });
    default:      return Object.freeze({ major, minor, patch });
  }
}
