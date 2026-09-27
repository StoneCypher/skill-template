#!/usr/bin/env node
/**
 * Turns a fresh copy of the template into a named skill: `npm run init-skill -- <name> "<description>"`.
 *
 * Renames the skill folder under plugin/skills/, rewrites names, descriptions and URLs in SKILL.md,
 * every manifest, package.json and the README, resets versions to 0.1.0, and
 * resets CHANGELOG.md. All new file contents are computed before anything is
 * written, so a validation error leaves the repo untouched. The rewrite rules
 * live in ./lib/rename.mjs; this file only reads, writes and reports.
 *
 * @example
 * // npm run init-skill -- docket "Tracks open tasks in a docket file."
 * // npm run init-skill -- docket "Tracks open tasks." --repo StoneCypher/docket
 * // npm run init-skill -- ledger "Keeps a ledger." --force   (rename an already-initialized skill)
 *
 * @see ./lib/rename.mjs
 * @see ./lib/manifests.mjs
 */

import { readFile, writeFile, rename, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CLAUDE_PLUGIN_PATH, MANIFESTS, SKILLS_DIR, withVersion } from './lib/manifests.mjs';
import {
  TEMPLATE_NAME, TEMPLATE_REPO, checkOptions, normalizeRepo,
  renameManifest, renameReadme, renameSkillMd, resetChangelog,
} from './lib/rename.mjs';

/** The version every new skill starts at. */
export const INITIAL_VERSION = '0.1.0';

/** Absolute path of the repo this script belongs to. */
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Where a skill's folder sits, relative to the repo root: inside the plugin folder users install.
 *
 * @param {string} name  Skill name.
 * @returns {string}  Repo-relative folder in the platform's path style, e.g. 'plugin/skills/docket'.
 *
 * @example
 * skillDir('docket'); // 'plugin/skills/docket' ('plugin\\skills\\docket' on Windows)
 *
 * @see SKILLS_DIR
 */
export function skillDir(name) {
  return join(SKILLS_DIR, name);
}

/** Usage text shown by --help and on bad arguments. */
export const USAGE = `Usage: npm run init-skill -- <name> "<description>" [--repo owner/repo] [--force]

  <name>         lowercase letters, digits and single hyphens, 1-64 characters
  <description>  one sentence on what the skill does
  --repo         GitHub owner/repo (default: the origin remote, else <author>/<name>)
  --force        run even though the skill has already been initialized`;

/**
 * Parsed command-line arguments.
 *
 * @typedef {object} CliArgs
 * @property {string} [name]         The new skill name.
 * @property {string} [description]  The new description.
 * @property {string} [repo]         An explicit `owner/repo`.
 * @property {boolean} force         Whether to run on an already-initialized repo.
 * @property {boolean} help          Whether usage was requested.
 */

/**
 * Parses init-skill's arguments without validating the values.
 *
 * @param {string[]} argv  Arguments after the script path.
 * @returns {CliArgs}  The parsed arguments.
 * @throws {Error} On unknown options or more than two positionals.
 *
 * @example
 * parseCli(['docket', 'Tracks tasks.', '--force']);
 * // { name: 'docket', description: 'Tracks tasks.', repo: undefined, force: true, help: false }
 */
export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (positionals.length > 2) {
    throw new Error(`Expected <name> and "<description>", got ${positionals.length} arguments. Quote the description.`);
  }
  const [name, description] = positionals;
  return { name, description, repo: values.repo, force: values.force, help: values.help };
}

/**
 * Chooses the repository to point URLs at.
 *
 * An explicit --repo wins. Next is the origin remote, unless it still points
 * at the template itself. Last is the manifest author's GitHub account plus
 * the skill name.
 *
 * @param {object} sources
 * @param {string} [sources.explicit]   The --repo value.
 * @param {string} [sources.origin]     The origin remote URL, if any.
 * @param {string} [sources.authorUrl]  The manifest author's URL, e.g. 'https://github.com/StoneCypher'.
 * @param {string} sources.name         The new skill name.
 * @returns {string}  A bare `owner/repo`.
 * @throws {Error} When no source yields a repository.
 *
 * @example
 * chooseRepo({ origin: 'git@github.com:StoneCypher/docket.git', name: 'docket' }); // 'StoneCypher/docket'
 */
export function chooseRepo({ explicit, origin, authorUrl, name }) {
  if (explicit) return normalizeRepo(explicit);
  const fromOrigin = tryRepo(origin);
  if (fromOrigin && fromOrigin !== TEMPLATE_REPO) return fromOrigin;
  const owner = /github\.com\/([A-Za-z0-9-]+)\/?$/.exec(authorUrl ?? '')?.[1];
  if (owner) return `${owner}/${name}`;
  throw new Error('Could not work out the GitHub repository; pass --repo owner/repo.');
}

/**
 * Normalizes a repository if it is one, and returns undefined if it is not.
 *
 * @param {string} [value]  A candidate `owner/repo` or GitHub URL.
 * @returns {string | undefined}  The bare `owner/repo`, or undefined.
 */
function tryRepo(value) {
  try { return value ? normalizeRepo(value) : undefined; } catch { return undefined; }
}

/**
 * Reads the origin remote's URL, if the repo has git and an origin.
 *
 * @param {string} root  Repo root.
 * @returns {string | undefined}  The URL, or undefined when there is none.
 */
export function gitOrigin(root) {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Tells whether a path exists.
 *
 * @param {string} path  Absolute path.
 * @returns {Promise<boolean>}  True when it exists.
 */
async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

/**
 * Reads a text file, or returns undefined when it does not exist.
 *
 * @param {string} path  Absolute path.
 * @returns {Promise<string | undefined>}  The contents, or undefined.
 */
async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Serializes JSON the way manifests.mjs writes it: two spaces and a trailing newline.
 *
 * @param {any} json  Any JSON value.
 * @returns {string}  The file contents.
 */
const jsonText = json => `${JSON.stringify(json, null, 2)}\n`;

/**
 * Computes the new contents of every manifest: renamed, then versioned at 0.1.0.
 *
 * @param {Map<string, string>} originals  Repo-relative path to current contents (missing files absent).
 * @param {import('./lib/rename.mjs').RenameOptions} options  Validated rename options.
 * @param {string} oldRepo  The repository being replaced.
 * @returns {Map<string, string>}  Repo-relative path to new contents.
 * @throws {SyntaxError} When a manifest is not valid JSON.
 */
export function planManifests(originals, options, oldRepo) {
  const planned = MANIFESTS
    .filter(spec => originals.has(spec.path))
    .map(spec => {
      const renamed = renameManifest(spec.path, JSON.parse(originals.get(spec.path)), options, oldRepo);
      return [spec.path, jsonText(spec.versioned ? withVersion(spec.path, renamed, INITIAL_VERSION) : renamed)];
    });
  return new Map(planned);
}

/**
 * Reads every manifest listed in MANIFESTS that exists, so the rename covers all of them.
 *
 * @param {string} root  Repo root.
 * @returns {Promise<Map<string, string>>}  Repo-relative path to contents; missing files are absent.
 *
 * @example
 * await readManifests('/repo'); // Map { 'plugin/.claude-plugin/plugin.json' => '{...}', ... }
 *
 * @see MANIFESTS
 */
export async function readManifests(root) {
  const texts = await Promise.all(MANIFESTS.map(({ path }) => readOptional(join(root, path))));
  return new Map(MANIFESTS.flatMap(({ path }, i) => (texts[i] === undefined ? [] : [[path, texts[i]]])));
}

/**
 * Picks out and parses the Claude plugin manifest, which records the skill's current name, repository and author.
 *
 * @param {Map<string, string>} originals  Manifest contents from {@link readManifests}.
 * @returns {any}  The parsed Claude plugin manifest.
 * @throws {Error} When the Claude plugin manifest is missing.
 * @throws {SyntaxError} When it is not valid JSON.
 *
 * @example
 * identityManifest(new Map([['plugin/.claude-plugin/plugin.json', '{"name":"skill-template"}']])).name; // 'skill-template'
 *
 * @see CLAUDE_PLUGIN_PATH
 */
export function identityManifest(originals) {
  const text = originals.get(CLAUDE_PLUGIN_PATH);
  if (text === undefined) throw new Error(`No ${CLAUDE_PLUGIN_PATH}; init-skill reads the current skill name from it.`);
  return JSON.parse(text);
}

/**
 * Initializes the skill in a repo: the whole CLI, minus process handling.
 *
 * @param {object} [params]
 * @param {string[]} [params.argv]  Arguments after the script path.
 * @param {string} [params.root]    Repo root; defaults to the repo holding this script.
 * @param {(root: string) => string | undefined} [params.origin]  Reads the origin URL; injectable for tests.
 * @returns {Promise<string>}  The report to print.
 * @throws {Error} On bad arguments, a missing Claude plugin manifest, an invalid name or description,
 *   a second run without --force, or a target folder that already exists. Nothing is written in those cases.
 *
 * @example
 * await main({ argv: ['docket', 'Tracks open tasks in a docket file.'] });
 */
export async function main({ argv = process.argv.slice(2), root = DEFAULT_ROOT, origin = gitOrigin } = {}) {
  const args = parseCli(argv);
  if (args.help) return USAGE;
  if (!args.name || !args.description) throw new Error(`Missing <name> or "<description>".\n\n${USAGE}`);

  const originals = await readManifests(root);
  const claude = identityManifest(originals);
  const oldName = claude.name;
  if (oldName !== TEMPLATE_NAME && !args.force) {
    throw new Error(`This repo was already initialized as "${oldName}". Pass --force to rename it again.`);
  }
  const oldRepo = tryRepo(claude.repository) ?? TEMPLATE_REPO;
  const repo = chooseRepo({ explicit: args.repo, origin: origin(root), authorUrl: claude.author?.url, name: args.name });
  const options = checkOptions({ oldName, newName: args.name, description: args.description, repo });

  const oldDir = join(root, skillDir(oldName));
  const newDir = join(root, skillDir(options.newName));
  const moving = oldDir !== newDir;
  if (!(await exists(join(oldDir, 'SKILL.md')))) throw new Error(`No SKILL.md at ${oldDir}.`);
  if (moving && (await exists(newDir))) throw new Error(`${newDir} already exists; remove it or choose another name.`);

  const readme = await readOptional(join(root, 'README.md'));
  const changelog = await readOptional(join(root, 'CHANGELOG.md'));

  const writes = new Map(planManifests(originals, options, oldRepo));
  writes.set(join(skillDir(options.newName), 'SKILL.md'), renameSkillMd(await readFile(join(oldDir, 'SKILL.md'), 'utf8'), options));
  if (readme !== undefined) writes.set('README.md', renameReadme(readme, options, oldRepo));
  if (changelog !== undefined) writes.set('CHANGELOG.md', resetChangelog(changelog));

  if (moving) await rename(oldDir, newDir);
  for (const [path, text] of writes) await writeFile(join(root, path), text, 'utf8');

  return report(options, [...writes.keys()], moving ? [skillDir(oldName), skillDir(options.newName)] : undefined);
}

/**
 * Builds the summary and next steps printed after a successful run.
 *
 * @param {import('./lib/rename.mjs').RenameOptions} options  The applied options.
 * @param {string[]} written  Repo-relative paths that were rewritten.
 * @param {[string, string]} [moved]  The folder's old and new paths, if it moved.
 * @returns {string}  Human-readable report.
 */
export function report(options, written, moved) {
  const slash = path => path.split('\\').join('/');
  const lines = [
    `Initialized skill "${options.newName}" for github.com/${options.repo} at version ${INITIAL_VERSION}.`,
    ...(moved ? [`  moved    ${slash(moved[0])}/ -> ${slash(moved[1])}/`] : []),
    ...written.map(path => `  rewrote  ${slash(path)}`),
    '',
    'Next:',
    `  1. Write the instructions in ${slash(skillDir(options.newName))}/SKILL.md.`,
    '  2. Extend its description with trigger phrases and a guard sentence ("Not for ...").',
    '  3. npm test, then npm run validate.',
    '  4. npm run release, then work through RELEASING.md.',
  ];
  return lines.join('\n');
}

/**
 * Tells whether this module is being run directly rather than imported.
 *
 * Compares file paths case-insensitively on Windows, where drive-letter case can differ.
 *
 * @returns {boolean}  True when invoked as a script.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const invoked = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
}

if (isEntryPoint()) {
  main().then(
    text => console.log(text),
    error => { console.error(`init-skill: ${error.message}`); process.exitCode = 1; },
  );
}
