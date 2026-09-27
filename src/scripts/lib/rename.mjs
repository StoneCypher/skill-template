/**
 * Pure text and JSON rewrites that turn the template into a named skill.
 *
 * `npm run init-skill` reads each file, hands its contents here, and writes
 * back what comes out. Nothing in this module touches the disk, so every rule
 * can be tested on strings.
 *
 * @see ../init-skill.mjs
 * @see ./manifests.mjs
 */

import { isMarketplace } from './manifests.mjs';

/** The skill name the template ships with; init-skill replaces it. */
export const TEMPLATE_NAME = 'skill-template';

/** The GitHub `owner/repo` the template ships with; init-skill replaces it. */
export const TEMPLATE_REPO = 'StoneCypher/skill-template';

/** Longest skill name the Agent Skills spec allows. */
export const MAX_NAME_LENGTH = 64;

/** Longest `description` the Agent Skills spec allows. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** Words Claude refuses inside a skill name. */
export const RESERVED_NAME_WORDS = Object.freeze(['anthropic', 'claude']);

/** Opens a README block that only makes sense in the template itself. */
export const TEMPLATE_ONLY_START = '<!-- template-only:start -->';

/** Closes a README block that only makes sense in the template itself. */
export const TEMPLATE_ONLY_END = '<!-- template-only:end -->';

/** Opens a README block, hidden in the template, that each skill shows. */
export const SKILL_ONLY_START = '<!-- skill-only:start';

/** Closes a README block, hidden in the template, that each skill shows. */
export const SKILL_ONLY_END = 'skill-only:end -->';

/**
 * Everything a rename needs to know.
 *
 * @typedef {object} RenameOptions
 * @property {string} oldName      The skill's current name, usually 'skill-template'.
 * @property {string} newName      The name to give it; must pass {@link validateSkillName}.
 * @property {string} description  What the skill does; must pass {@link validateDescription}.
 * @property {string} repo         The GitHub `owner/repo` the skill will live in.
 */

/**
 * Checks a skill name against the Agent Skills naming rules.
 *
 * Hosts use the name as a folder name and a lookup key, so it must be
 * lowercase letters, digits and single hyphens, 1 to 64 characters, with no
 * hyphen at either end. Claude also refuses names containing its reserved words.
 *
 * @param {string} name  The proposed skill name.
 * @returns {string}  The same name, for chaining.
 * @throws {Error} When the name breaks any rule; the message names the rule.
 *
 * @example
 * validateSkillName('docket'); // 'docket'
 * @example
 * validateSkillName('Docket'); // throws: must use only lowercase letters, digits and hyphens
 */
export function validateSkillName(name) {
  const fail = why => { throw new Error(`Invalid skill name "${name}": ${why}.`); };
  if (typeof name !== 'string' || name.length === 0) fail('it must not be empty');
  if (name.length > MAX_NAME_LENGTH) fail(`it must be at most ${MAX_NAME_LENGTH} characters (it is ${name.length})`);
  if (!/^[a-z0-9-]+$/.test(name)) fail('it must use only lowercase letters, digits and hyphens');
  if (name.startsWith('-') || name.endsWith('-')) fail('it must not start or end with a hyphen');
  if (name.includes('--')) fail('it must not contain two hyphens in a row');
  const reserved = RESERVED_NAME_WORDS.find(word => name.includes(word));
  if (reserved) fail(`it must not contain the reserved word "${reserved}"`);
  return name;
}

/**
 * Checks a skill description against the Agent Skills limits.
 *
 * The description is what hosts show the model when deciding whether to load
 * the skill, so it must be present, at most 1024 characters, on one line, and
 * free of angle brackets (Claude rejects XML-like tags there).
 *
 * @param {string} description  The proposed description.
 * @returns {string}  The description with surrounding whitespace trimmed.
 * @throws {Error} When the description breaks any rule.
 *
 * @example
 * validateDescription(' Tracks open tasks in a docket file. '); // 'Tracks open tasks in a docket file.'
 * @example
 * validateDescription(''); // throws: must not be empty
 */
export function validateDescription(description) {
  const fail = why => { throw new Error(`Invalid description: ${why}.`); };
  const text = typeof description === 'string' ? description.trim() : '';
  if (text.length === 0) fail('it must not be empty');
  if (text.length > MAX_DESCRIPTION_LENGTH) fail(`it must be at most ${MAX_DESCRIPTION_LENGTH} characters (it is ${text.length})`);
  if (/[\r\n]/.test(text)) fail('it must be a single line');
  if (/[<>]/.test(text)) fail('it must not contain "<" or ">"');
  return text;
}

/**
 * Checks and normalizes a GitHub repository given as `owner/repo` or a URL.
 *
 * @param {string} repo  `owner/repo`, `https://github.com/owner/repo(.git)`,
 *   or `git@github.com:owner/repo(.git)`.
 * @returns {string}  The bare `owner/repo`.
 * @throws {Error} When the value is not a recognizable GitHub repository.
 *
 * @example
 * normalizeRepo('https://github.com/StoneCypher/docket.git'); // 'StoneCypher/docket'
 */
export function normalizeRepo(repo) {
  const bare = String(repo ?? '')
    .trim()
    .replace(/^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(bare)) {
    throw new Error(`Invalid repository "${repo}": expected owner/repo or a GitHub URL.`);
  }
  return bare;
}

/**
 * Validates and normalizes a full set of rename options in one step.
 *
 * @param {RenameOptions} options  The raw options.
 * @returns {RenameOptions}  Options with a trimmed description and bare repo.
 * @throws {Error} When any field is invalid.
 *
 * @example
 * checkOptions({ oldName: 'skill-template', newName: 'docket',
 *   description: 'Tracks tasks.', repo: 'StoneCypher/docket' });
 */
export function checkOptions({ oldName, newName, description, repo }) {
  return Object.freeze({
    oldName: validateSkillName(oldName),
    newName: validateSkillName(newName),
    description: validateDescription(description),
    repo: normalizeRepo(repo),
  });
}

/**
 * Renders a string as a YAML scalar, quoting only when a plain scalar would misparse.
 *
 * JSON double-quoted strings are valid YAML, so quoting reuses JSON.stringify.
 *
 * @param {string} text  A single-line string.
 * @returns {string}  The text, bare or double-quoted.
 *
 * @example
 * yamlScalar('Tracks tasks.');      // 'Tracks tasks.'
 * yamlScalar('Note: tracks tasks'); // '"Note: tracks tasks"'
 */
export function yamlScalar(text) {
  const risky = /^[\s\-?:,[\]{}#&*!|>'"%@`]|: |:$| #|\s$/.test(text)
    || /^(?:true|false|yes|no|on|off|null|~|[-+.\d][\d._eE+-]*)$/i.test(text);
  return risky ? JSON.stringify(text) : text;
}

/**
 * Splits a Markdown file into its YAML frontmatter and body.
 *
 * @param {string} text  File contents starting with a `---` line.
 * @returns {{ frontmatter: string, body: string, eol: string }}  The frontmatter
 *   without its fences, the rest of the file, and the line ending in use.
 * @throws {Error} When the file has no frontmatter.
 */
function splitFrontmatter(text) {
  const match = /^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('SKILL.md has no YAML frontmatter (expected it to start with a --- line).');
  return { frontmatter: match[2], body: text.slice(match[0].length), eol: match[1] };
}

/**
 * Replaces one top-level key in YAML frontmatter, including any continuation lines.
 *
 * A value can wrap onto indented lines (folded or plain multi-line scalars);
 * those lines belong to the key and are replaced with it.
 *
 * @param {string[]} lines  Frontmatter lines.
 * @param {string} key      The top-level key, e.g. 'name'.
 * @param {string} value    The already-rendered YAML scalar.
 * @returns {string[]}  New lines; the key is appended if it was absent.
 */
function setFrontmatterKey(lines, key, value) {
  const start = lines.findIndex(line => line.startsWith(`${key}:`));
  const replacement = `${key}: ${value}`;
  if (start < 0) return [...lines, replacement];
  const rest = lines.slice(start + 1);
  const continuation = rest.findIndex(line => !/^\s/.test(line) || line.trim() === '');
  const end = start + 1 + (continuation < 0 ? rest.length : continuation);
  return [...lines.slice(0, start), replacement, ...lines.slice(end)];
}

/**
 * Rewrites SKILL.md's frontmatter `name` and `description` and its H1 title.
 *
 * Only an H1 that is exactly the old name is renamed, so a hand-written title
 * survives a second run.
 *
 * @param {string} text             SKILL.md contents.
 * @param {RenameOptions} options   Validated rename options.
 * @returns {string}  The rewritten SKILL.md.
 * @throws {Error} When SKILL.md has no frontmatter.
 *
 * @example
 * renameSkillMd('---\nname: skill-template\ndescription: x\n---\n\n# skill-template\n',
 *   { oldName: 'skill-template', newName: 'docket', description: 'Tracks tasks.', repo: 'a/b' });
 * // '---\nname: docket\ndescription: Tracks tasks.\n---\n\n# docket\n'
 */
export function renameSkillMd(text, { oldName, newName, description }) {
  const { frontmatter, body, eol } = splitFrontmatter(text);
  const lines = setFrontmatterKey(
    setFrontmatterKey(frontmatter.split(/\r?\n/), 'name', yamlScalar(newName)),
    'description', yamlScalar(description),
  );
  const heading = new RegExp(`^# ${escapeRegExp(oldName)}[ \\t]*$`, 'm');
  return `---${eol}${lines.join(eol)}${eol}---${eol}${body.replace(heading, `# ${newName}`)}`;
}

/**
 * Escapes a string for literal use inside a RegExp.
 *
 * @param {string} text  Any string.
 * @returns {string}  The string with RegExp metacharacters escaped.
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces the template's GitHub URL, and bare old-name strings, anywhere in a JSON value.
 *
 * Catches fields a manifest format may add later (display names, bug URLs)
 * without this module having to know each one.
 *
 * @param {any} value              Any parsed JSON value.
 * @param {RenameOptions} options  Validated rename options.
 * @param {string} oldRepo         The repository to replace, `owner/repo`.
 * @returns {any}  A deep copy with replacements applied.
 */
function deepReplace(value, options, oldRepo) {
  if (typeof value === 'string') {
    if (value === options.oldName) return options.newName;
    return value.split(`github.com/${oldRepo}`).join(`github.com/${options.repo}`);
  }
  if (Array.isArray(value)) return value.map(item => deepReplace(item, options, oldRepo));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepReplace(v, options, oldRepo)]));
  }
  return value;
}

/**
 * Sets the repository field in whichever shape the manifest already uses.
 *
 * @param {any} current  The existing `repository` value: a string or `{ type, url }`.
 * @param {string} url   The new repository URL.
 * @returns {any}  The value in the same shape.
 */
function repositoryLike(current, url) {
  return current && typeof current === 'object' ? { ...current, url: `git+${url}.git` } : url;
}

/**
 * Rewrites a parsed manifest's identity fields for the new skill.
 *
 * Every manifest gets `name` and `description`. `homepage` and `repository`
 * are updated when the format already has them. A Claude marketplace is named
 * after the skill (marketplace names are unique per user, and every skill repo
 * ships one), and its plugin entry for the old name is renamed with it.
 * Remaining exact old-name strings and template GitHub URLs are replaced too.
 * Pure: the input is not modified.
 *
 * @param {string} path             The manifest's repo-relative path, which selects the rules.
 * @param {any} json                The parsed manifest.
 * @param {RenameOptions} options   Validated rename options.
 * @param {string} [oldRepo]        The repository being replaced, `owner/repo`.
 * @returns {any}  The rewritten manifest.
 * @throws {Error} When a marketplace has no plugin entry for the old name.
 *
 * @example
 * renameManifest('plugin/.codex-plugin/plugin.json',
 *   { name: 'skill-template', description: 'x', repository: 'https://github.com/StoneCypher/skill-template' },
 *   { oldName: 'skill-template', newName: 'docket', description: 'Tracks tasks.', repo: 'StoneCypher/docket' });
 * // { name: 'docket', description: 'Tracks tasks.', repository: 'https://github.com/StoneCypher/docket' }
 * @see ./manifests.mjs
 */
export function renameManifest(path, json, options, oldRepo = TEMPLATE_REPO) {
  const url = `https://github.com/${options.repo}`;
  const marketplace = isMarketplace(path);
  const base = { ...json, name: options.newName };
  if (!marketplace || 'description' in json) base.description = options.description;
  if ('homepage' in json) base.homepage = `${url}#readme`;
  if ('repository' in json) base.repository = repositoryLike(json.repository, url);
  if (marketplace) {
    const index = (json.plugins ?? []).findIndex(p => p?.name === options.oldName);
    if (index < 0) throw new Error(`${path}: no plugin entry named "${options.oldName}" to rename`);
    base.plugins = json.plugins.map((p, i) =>
      (i === index ? { ...p, name: options.newName, description: options.description } : p));
  }
  return deepReplace(base, options, oldRepo);
}

/**
 * Removes every template-only block from a README, markers included.
 *
 * @param {string} text  README contents.
 * @returns {string}  The README without template-only blocks.
 * @throws {Error} When a start marker has no matching end marker.
 *
 * @example
 * stripTemplateOnly('a\n<!-- template-only:start -->\nb\n<!-- template-only:end -->\nc\n'); // 'a\nc\n'
 */
export function stripTemplateOnly(text) {
  return cutBlocks(text, TEMPLATE_ONLY_START, TEMPLATE_ONLY_END, () => '');
}

/**
 * Uncomments every skill-only block, which the template hides inside an HTML comment.
 *
 * @param {string} text  README contents.
 * @returns {string}  The README with skill-only blocks shown and their markers gone.
 * @throws {Error} When a start marker has no matching end marker.
 *
 * @example
 * revealSkillOnly('<!-- skill-only:start\n# <name>\nskill-only:end -->\n'); // '# <name>\n'
 */
export function revealSkillOnly(text) {
  return cutBlocks(text, SKILL_ONLY_START, SKILL_ONLY_END, inner => inner.replace(/^\r?\n/, ''));
}

/**
 * Replaces each marker-delimited block (and the rest of its end marker's line) with a transform of its inside.
 *
 * @param {string} text                   The text to scan.
 * @param {string} start                  Start marker.
 * @param {string} end                    End marker.
 * @param {(inner: string) => string} fn  Maps the block's inside to its replacement.
 * @returns {string}  The rewritten text.
 * @throws {Error} When a start marker is unmatched.
 */
function cutBlocks(text, start, end, fn) {
  const from = text.indexOf(start);
  if (from < 0) return text;
  const to = text.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`README: "${start}" has no matching "${end}".`);
  const lineEnd = /\r?\n/.exec(text.slice(to + end.length));
  const after = lineEnd ? to + end.length + lineEnd.index + lineEnd[0].length : text.length;
  const replaced = fn(text.slice(from + start.length, to));
  return text.slice(0, from) + replaced + cutBlocks(text.slice(after), start, end, fn);
}

/**
 * Fills the README placeholders `<name>`, `<repo>` and `<description>`.
 *
 * @param {string} text             README contents.
 * @param {RenameOptions} options   Validated rename options.
 * @returns {string}  The README with placeholders filled.
 *
 * @example
 * fillPlaceholders('/plugin install <name>@<name>', { newName: 'docket', repo: 'a/b', description: 'x' });
 * // '/plugin install docket@docket'
 */
export function fillPlaceholders(text, { newName, repo, description }) {
  return text
    .replaceAll('<name>', newName)
    .replaceAll('<repo>', repo)
    .replaceAll('<description>', description);
}

/**
 * Replaces a previous skill name with the new one where it stands as a whole name.
 *
 * Used on a forced second run, when the README placeholders are already gone.
 * A match must not touch another name character (letter, digit or hyphen) on
 * either side, so `docket` does not match inside `dockets` or `my-docket`.
 *
 * @param {string} text             README contents.
 * @param {RenameOptions} options   Validated rename options.
 * @param {string} oldRepo          The repository being replaced, `owner/repo`.
 * @returns {string}  The README with old names and repository replaced.
 */
function replaceOldName(text, { oldName, newName, repo }, oldRepo) {
  const withRepo = text.replaceAll(oldRepo, repo);
  return withRepo.replace(new RegExp(`(?<![a-z0-9-])${escapeRegExp(oldName)}(?![a-z0-9-])`, 'g'), newName);
}

/**
 * Turns the template README into the skill's README.
 *
 * Drops template-only blocks, reveals skill-only blocks, then fills
 * placeholders. When the README has already been through this once (no
 * placeholders or markers left), old names and repository are replaced instead.
 *
 * @param {string} text             README contents.
 * @param {RenameOptions} options   Validated rename options.
 * @param {string} [oldRepo]        The repository being replaced, `owner/repo`.
 * @returns {string}  The skill's README.
 * @throws {Error} When a block marker is unmatched.
 *
 * @example
 * renameReadme('<!-- template-only:start -->\nx\n<!-- template-only:end -->\n# <name>\n',
 *   { oldName: 'skill-template', newName: 'docket', description: 'd', repo: 'a/b' });
 * // '# docket\n'
 */
export function renameReadme(text, options, oldRepo = TEMPLATE_REPO) {
  const fresh = text.includes(TEMPLATE_ONLY_START) || text.includes(SKILL_ONLY_START) || text.includes('<name>');
  if (!fresh) return replaceOldName(text, options, oldRepo);
  return fillPlaceholders(revealSkillOnly(stripTemplateOnly(text)), options);
}

/**
 * Resets a changelog to its preamble plus an empty Unreleased section.
 *
 * Everything before the first `## ` heading (title and intro) is kept; every
 * release section and link definition after it is dropped, since they
 * describe the template, not the new skill.
 *
 * @param {string} text  CHANGELOG.md contents.
 * @returns {string}  The reset changelog.
 *
 * @example
 * resetChangelog('# Changelog\n\n## [0.3.0]\n- stuff\n'); // '# Changelog\n\n## [Unreleased]\n'
 */
export function resetChangelog(text) {
  const first = text.search(/^## /m);
  const preamble = (first < 0 ? text : text.slice(0, first)).trimEnd();
  return `${preamble || '# Changelog'}\n\n## [Unreleased]\n`;
}

/**
 * Rewrites package.json's name and description for the new skill.
 *
 * @param {any} json                The parsed package.json.
 * @param {RenameOptions} options   Validated rename options.
 * @param {string} [oldRepo]        The repository being replaced, `owner/repo`.
 * @returns {any}  The rewritten package.json.
 *
 * @example
 * renamePackage({ name: 'skill-template', description: 'x' },
 *   { oldName: 'skill-template', newName: 'docket', description: 'Tracks tasks.', repo: 'a/b' });
 * // { name: 'docket', description: 'Tracks tasks.' }
 */
export function renamePackage(json, options, oldRepo = TEMPLATE_REPO) {
  return renameManifest('package.json', json, options, oldRepo);
}
