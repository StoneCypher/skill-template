/**
 * Parses SKILL.md frontmatter: the small YAML subset skills actually use.
 *
 * The repo has no npm dependencies, so this is a hand-written parser rather
 * than js-yaml. It accepts exactly this subset and rejects everything else
 * with a {@link FrontmatterError} that names the line, so an unsupported
 * construct fails loudly instead of parsing into the wrong value:
 *
 * - a `---` fenced block at the very start of the file, closed by `---`;
 * - `key: value` pairs, where a value is a plain scalar (which may continue
 *   on more-indented lines), a single- or double-quoted scalar on one line,
 *   or a literal (`|`) or folded (`>`) block scalar with optional `-` / `+`
 *   chomping;
 * - one level of nested mapping (e.g. `metadata:` followed by indented
 *   `key: value` lines);
 * - blank lines and `#` comment lines.
 *
 * Plain scalars resolve with the YAML 1.2 core schema (`true`, `null`, `42`,
 * `1.5` become boolean, null and numbers), as a real YAML parser would.
 *
 * Out of the subset: sequences, flow collections (`[...]`, `{...}`),
 * anchors, aliases, tags, quoted or complex keys, multi-line quoted scalars,
 * explicit block indentation indicators, and nesting deeper than one level.
 *
 * @see ./checks.mjs
 */

/** How many levels of mapping may sit below the top level. */
export const MAX_NESTING = 1;

/** The line that opens and closes the frontmatter block. */
const FENCE = '---';

/** A mapping key and the rest of its line: `name: value`. */
const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?=\s|$)(.*)$/;

/** A block scalar header: style, optional chomping, optional comment. */
const BLOCK_HEADER = /^([|>])([+-]?)(?:\s+#.*)?$/;

/** Characters that cannot start a plain scalar (YAML c-indicator). */
const RESERVED_START = /^[,[\]{}#&*!|>'"%@`]/;

/** `-`, `?` or `:` followed by whitespace also cannot start a plain scalar. */
const INDICATOR_START = /^[-?:](\s|$)/;

/** Double-quoted escapes that stand for a single fixed character. */
const SIMPLE_ESCAPES = Object.freeze({
  0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f',
  r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\',
  N: '\x85', _: '\xa0', L: ' ', P: ' ',
});

/** Double-quoted escapes followed by a fixed number of hex digits. */
const HEX_ESCAPES = Object.freeze({ x: 2, u: 4, U: 8 });

/**
 * A frontmatter syntax error, or a construct outside the supported subset.
 *
 * @see parseFrontmatter
 */
export class FrontmatterError extends Error {
  /**
   * Builds the error, prefixing the message with its line number.
   *
   * @param {string} message  What is wrong, phrased for the skill author.
   * @param {number} [line]   1-based line number in the whole file.
   *
   * @example
   * new FrontmatterError('duplicate key "name"', 4).message;
   * // 'line 4: duplicate key "name"'
   */
  constructor(message, line) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = 'FrontmatterError';
    this.line = line;
  }
}

/**
 * Splits a SKILL.md file into its raw frontmatter lines and its body.
 *
 * A leading BOM is dropped and CRLF / CR line endings become LF, so the body
 * comes back LF-normalised.
 *
 * @param {string} text  The whole file.
 * @returns {{ lines: string[], body: string }}  The lines between the fences
 *   (fences excluded) and everything after the closing fence line.
 * @throws {FrontmatterError} When the file does not open with `---`, or the
 *   block is never closed.
 *
 * @example
 * splitFrontmatter('---\nname: x\n---\n# Body\n');
 * // { lines: ['name: x'], body: '# Body\n' }
 */
export function splitFrontmatter(text) {
  const all = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (all[0].trimEnd() !== FENCE) {
    throw new FrontmatterError('the file must start with a "---" line that opens the frontmatter', 1);
  }
  const close = all.findIndex((line, i) => i > 0 && line.trimEnd() === FENCE);
  if (close < 0) {
    throw new FrontmatterError('the frontmatter is never closed by a "---" line', 1);
  }
  return { lines: all.slice(1, close), body: all.slice(close + 1).join('\n') };
}

/**
 * Parses a SKILL.md file's frontmatter into data, and returns its body.
 *
 * @param {string} text  The whole SKILL.md file.
 * @returns {{ data: Record<string, unknown>, body: string }}  The frontmatter
 *   mapping (nested mappings are plain objects) and the text after it.
 * @throws {FrontmatterError} On malformed frontmatter or anything outside the
 *   supported subset; the message starts with the file line number.
 *
 * @example
 * parseFrontmatter('---\nname: pdf\ndescription: >-\n  Reads PDFs.\n  Not for Word files.\n---\nBody');
 * // { data: { name: 'pdf', description: 'Reads PDFs. Not for Word files.' }, body: 'Body' }
 * @example
 * parseFrontmatter('---\ntags: [a, b]\n---\n');
 * // throws FrontmatterError: 'line 2: flow collections ([...] / {...}) are outside ...'
 *
 * @see splitFrontmatter
 */
export function parseFrontmatter(text) {
  const { lines, body } = splitFrontmatter(text);
  const ctx = { lines, lineNo: i => i + 2 };
  const { value, next } = parseMapping(ctx, 0, 0, 0);
  if (next < lines.length) {
    throw new FrontmatterError('unexpected content', ctx.lineNo(next));
  }
  return { data: value, body };
}

/**
 * Resolves a plain (unquoted) scalar with the YAML 1.2 core schema.
 *
 * @param {string} text  The scalar text, already trimmed and folded.
 * @returns {string | number | boolean | null}  The typed value.
 *
 * @example
 * resolvePlain('true');   // true
 * @example
 * resolvePlain('0.1.0');  // '0.1.0' (not a number: two dots)
 */
export function resolvePlain(text) {
  if (/^(?:null|Null|NULL|~)?$/.test(text)) return null;
  if (/^(?:true|True|TRUE)$/.test(text)) return true;
  if (/^(?:false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?[0-9]+$/.test(text)) return Number(text);
  if (/^0o[0-7]+$/.test(text)) return parseInt(text.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(text)) return parseInt(text.slice(2), 16);
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(text)) return Number(text);
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(?:nan|NaN|NAN)$/.test(text)) return NaN;
  return text;
}

/**
 * Counts a line's leading spaces.
 *
 * @param {string} line  One raw line.
 * @returns {number}  The number of leading space characters (tabs excluded).
 *
 * @example
 * indentOf('  key: v'); // 2
 */
const indentOf = line => /^ */.exec(line)[0].length;

/** True for a line holding only whitespace. */
const isBlank = line => line.trim() === '';

/** True for a blank line or a `#` comment line. */
const isSkippable = line => isBlank(line) || line.trimStart().startsWith('#');

/**
 * Finds the next line that carries content (not blank, not a comment).
 *
 * @param {string[]} lines  The frontmatter lines.
 * @param {number} from     Index to start looking at.
 * @returns {number}  The index, or `lines.length` when none remains.
 */
const nextContent = (lines, from) => {
  const found = lines.findIndex((line, i) => i >= from && !isSkippable(line));
  return found < 0 ? lines.length : found;
};

/**
 * Removes a trailing ` # comment` from a plain scalar line.
 *
 * @param {string} text  The scalar text.
 * @returns {{ text: string, hadComment: boolean }}  The text without the
 *   comment (trimmed), and whether one was cut.
 */
const stripComment = text => {
  const at = text.search(/\s#/);
  return at < 0
    ? { text: text.trimEnd(), hadComment: false }
    : { text: text.slice(0, at).trimEnd(), hadComment: true };
};

/**
 * Rejects line starts that belong to YAML features outside the subset.
 *
 * @param {string} content  The line with its indentation removed.
 * @param {number} line     File line number, for the error.
 * @throws {FrontmatterError} For sequences, complex keys, quoted keys, flow
 *   collections, anchors, aliases, tags and directives.
 */
function rejectUnsupportedKey(content, line) {
  if (/^-(\s|$)/.test(content)) throw new FrontmatterError('sequences ("- item") are outside the supported frontmatter subset', line);
  if (/^\?(\s|$)/.test(content)) throw new FrontmatterError('complex keys ("? key") are outside the supported frontmatter subset', line);
  if (/^["']/.test(content)) throw new FrontmatterError('quoted keys are outside the supported frontmatter subset; write the key bare', line);
  if (/^[[{]/.test(content)) throw new FrontmatterError('flow collections ([...] / {...}) are outside the supported frontmatter subset', line);
  if (/^[&*!]/.test(content)) throw new FrontmatterError('anchors, aliases and tags (&, *, !) are outside the supported frontmatter subset', line);
  if (/^%/.test(content)) throw new FrontmatterError('YAML directives (%) are not allowed in frontmatter', line);
}

/**
 * Parses a block of `key: value` lines that share one indentation.
 *
 * @param {{ lines: string[], lineNo: (i: number) => number }} ctx  The lines
 *   and a map from line index to file line number.
 * @param {number} start   Index of the first line to read.
 * @param {number} indent  The mapping's indentation, in spaces.
 * @param {number} depth   0 for the top level, 1 for a nested mapping.
 * @returns {{ value: Record<string, unknown>, next: number }}  The mapping and
 *   the index of the first line not consumed.
 * @throws {FrontmatterError} On bad keys, duplicates or stray indentation.
 */
function parseMapping(ctx, start, indent, depth) {
  const { lines } = ctx;
  const entries = new Map();
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isSkippable(line)) { i += 1; continue; }
    if (/^ *\t/.test(line)) throw new FrontmatterError('tabs cannot indent YAML; use spaces', ctx.lineNo(i));
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) throw new FrontmatterError('unexpected indentation', ctx.lineNo(i));
    const content = line.slice(ind);
    rejectUnsupportedKey(content, ctx.lineNo(i));
    const match = KEY_LINE.exec(content);
    if (!match) throw new FrontmatterError(`expected "key: value", got "${content.trim()}"`, ctx.lineNo(i));
    const key = match[1];
    if (entries.has(key)) throw new FrontmatterError(`duplicate key "${key}"`, ctx.lineNo(i));
    const { value, next } = parseValue(ctx, i, indent, depth, match[2].trim());
    entries.set(key, value);
    i = next;
  }
  return { value: Object.fromEntries(entries), next: i };
}

/**
 * Parses the value that follows `key:` on line `i`, and any lines it owns.
 *
 * @param {{ lines: string[], lineNo: (i: number) => number }} ctx  Parser context.
 * @param {number} i       Index of the `key:` line.
 * @param {number} indent  The indentation of the key.
 * @param {number} depth   Nesting depth of the mapping holding the key.
 * @param {string} rest    The text after the colon, trimmed.
 * @returns {{ value: unknown, next: number }}  The value and the next line index.
 * @throws {FrontmatterError} On unsupported or malformed values.
 */
function parseValue(ctx, i, indent, depth, rest) {
  const line = ctx.lineNo(i);
  if (rest === '' || rest.startsWith('#')) return parseNestedOrNull(ctx, i, indent, depth);
  if (rest[0] === '|' || rest[0] === '>') return parseBlockScalar(ctx, i, indent, rest);
  if (rest[0] === '"' || rest[0] === "'") {
    const { value, after } = rest[0] === '"' ? readDoubleQuoted(rest, line) : readSingleQuoted(rest, line);
    if (after !== '' && !/^\s+#/.test(after)) {
      throw new FrontmatterError(`unexpected text after the closing quote: "${after.trim()}"`, line);
    }
    return { value, next: i + 1 };
  }
  if (/^[[{]/.test(rest)) throw new FrontmatterError('flow collections ([...] / {...}) are outside the supported frontmatter subset; quote the value if it is text', line);
  if (/^[&*!]/.test(rest)) throw new FrontmatterError('anchors, aliases and tags (&, *, !) are outside the supported frontmatter subset; quote the value if it is text', line);
  if (RESERVED_START.test(rest) || INDICATOR_START.test(rest)) {
    throw new FrontmatterError(`a plain value cannot start with "${rest[0]}"; quote it`, line);
  }
  return parsePlain(ctx, i, indent, rest);
}

/**
 * Parses an empty `key:` as a nested mapping when indented lines follow, else null.
 *
 * @param {{ lines: string[], lineNo: (i: number) => number }} ctx  Parser context.
 * @param {number} i       Index of the `key:` line.
 * @param {number} indent  The key's indentation.
 * @param {number} depth   Nesting depth of the mapping holding the key.
 * @returns {{ value: Record<string, unknown> | null, next: number }}
 * @throws {FrontmatterError} When the nesting would exceed {@link MAX_NESTING}.
 */
function parseNestedOrNull(ctx, i, indent, depth) {
  const j = nextContent(ctx.lines, i + 1);
  if (j >= ctx.lines.length || indentOf(ctx.lines[j]) <= indent) return { value: null, next: i + 1 };
  if (depth >= MAX_NESTING) {
    throw new FrontmatterError(`nesting deeper than ${MAX_NESTING} level is outside the supported frontmatter subset`, ctx.lineNo(j));
  }
  return parseMapping(ctx, j, indentOf(ctx.lines[j]), depth + 1);
}

/**
 * Rejects a plain-scalar fragment that YAML would read as something else.
 *
 * @param {string} text  One line's worth of plain scalar text.
 * @param {number} line  File line number, for the error.
 * @throws {FrontmatterError} When the text holds `: ` or ends with `:`.
 */
function rejectColon(text, line) {
  if (/:(\s|$)/.test(text)) {
    throw new FrontmatterError('a plain value cannot contain ": " or end with ":"; quote the value', line);
  }
}

/**
 * Parses a plain scalar, folding any more-indented continuation lines.
 *
 * A single line break between continuation lines becomes a space; a break
 * with n blank lines becomes n newlines, as YAML folds plain scalars.
 *
 * @param {{ lines: string[], lineNo: (i: number) => number }} ctx  Parser context.
 * @param {number} i       Index of the `key:` line.
 * @param {number} indent  The key's indentation.
 * @param {string} rest    The text after the colon, trimmed.
 * @returns {{ value: unknown, next: number }}
 * @throws {FrontmatterError} On colons, comments inside a multi-line value, or
 *   continuation lines that look like sequence items.
 */
function parsePlain(ctx, i, indent, rest) {
  const { lines } = ctx;
  const first = stripComment(rest);
  rejectColon(first.text, ctx.lineNo(i));
  const parts = [first.text];
  let blanks = 0;
  let next = i + 1;
  for (let j = i + 1; j < lines.length; j += 1) {
    const line = lines[j];
    if (isBlank(line)) { blanks += 1; continue; }
    if (indentOf(line) <= indent) break;
    const content = line.trim();
    const where = ctx.lineNo(j);
    // A comment line ends the scalar; any indented text after it is then
    // rejected by the mapping as unexpected indentation, as YAML does.
    if (content.startsWith('#')) break;
    if (first.hadComment || /\s#/.test(content)) {
      throw new FrontmatterError('comments inside a multi-line plain value are outside the supported frontmatter subset', where);
    }
    if (/^-(\s|$)/.test(content)) {
      throw new FrontmatterError('sequences ("- item") are outside the supported frontmatter subset', where);
    }
    rejectColon(content, where);
    parts.push(blanks === 0 ? ' ' : '\n'.repeat(blanks), content);
    blanks = 0;
    next = j + 1;
  }
  return { value: resolvePlain(parts.join('')), next };
}

/**
 * Reads a double-quoted scalar that must close on the same line.
 *
 * @param {string} text  Text starting with the opening `"`.
 * @param {number} line  File line number, for errors.
 * @returns {{ value: string, after: string }}  The unescaped value and the
 *   text after the closing quote.
 * @throws {FrontmatterError} On an unknown escape or an unclosed quote.
 *
 * @example
 * readDoubleQuoted('"a\\tb" # c', 3); // { value: 'a\tb', after: ' # c' }
 */
function readDoubleQuoted(text, line) {
  let value = '';
  let k = 1;
  while (k < text.length) {
    const ch = text[k];
    if (ch === '"') return { value, after: text.slice(k + 1) };
    if (ch !== '\\') { value += ch; k += 1; continue; }
    const code = text[k + 1];
    if (code === undefined) break;
    if (Object.hasOwn(SIMPLE_ESCAPES, code)) { value += SIMPLE_ESCAPES[code]; k += 2; continue; }
    if (!Object.hasOwn(HEX_ESCAPES, code)) throw new FrontmatterError(`unknown escape "\\${code}" in a double-quoted value`, line);
    const hex = text.slice(k + 2, k + 2 + HEX_ESCAPES[code]);
    if (!new RegExp(`^[0-9a-fA-F]{${HEX_ESCAPES[code]}}$`).test(hex)) {
      throw new FrontmatterError(`"\\${code}" needs ${HEX_ESCAPES[code]} hex digits in a double-quoted value`, line);
    }
    value += String.fromCodePoint(parseInt(hex, 16));
    k += 2 + HEX_ESCAPES[code];
  }
  throw new FrontmatterError('a double-quoted value must close on the same line (multi-line quoted values are outside the supported subset)', line);
}

/**
 * Reads a single-quoted scalar that must close on the same line.
 *
 * @param {string} text  Text starting with the opening `'`.
 * @param {number} line  File line number, for errors.
 * @returns {{ value: string, after: string }}  The value (`''` unescaped to
 *   `'`) and the text after the closing quote.
 * @throws {FrontmatterError} On an unclosed quote.
 *
 * @example
 * readSingleQuoted("'it''s'", 2); // { value: "it's", after: '' }
 */
function readSingleQuoted(text, line) {
  let value = '';
  let k = 1;
  while (k < text.length) {
    if (text[k] !== "'") { value += text[k]; k += 1; continue; }
    if (text[k + 1] === "'") { value += "'"; k += 2; continue; }
    return { value, after: text.slice(k + 1) };
  }
  throw new FrontmatterError('a single-quoted value must close on the same line (multi-line quoted values are outside the supported subset)', line);
}

/**
 * Parses a literal (`|`) or folded (`>`) block scalar and applies chomping.
 *
 * @param {{ lines: string[], lineNo: (i: number) => number }} ctx  Parser context.
 * @param {number} i       Index of the `key: |` line.
 * @param {number} indent  The key's indentation; content must be deeper.
 * @param {string} header  The header text, e.g. `>-` or `| # comment`.
 * @returns {{ value: string, next: number }}
 * @throws {FrontmatterError} On an unsupported header or bad indentation.
 */
function parseBlockScalar(ctx, i, indent, header) {
  const match = BLOCK_HEADER.exec(header);
  if (!match) {
    const detail = /^[|>][-+]?[0-9]/.test(header) || /^[|>][0-9]/.test(header)
      ? 'explicit indentation indicators are outside the supported subset'
      : `invalid block scalar header "${header}"`;
    throw new FrontmatterError(detail, ctx.lineNo(i));
  }
  const [, style, chomp] = match;
  const { lines } = ctx;
  const firstContent = lines.findIndex((line, j) => j > i && !isBlank(line));
  const contentIndent = firstContent < 0 ? 0 : indentOf(lines[firstContent]);
  if (firstContent < 0 || contentIndent <= indent) {
    const end = firstContent < 0 ? lines.length : firstContent;
    return { value: chompBlock('', end - i - 1, false, chomp), next: end };
  }
  let next = i + 1;
  while (next < lines.length && (isBlank(lines[next]) || indentOf(lines[next]) >= contentIndent)) next += 1;
  if (next < lines.length && indentOf(lines[next]) > indent) {
    throw new FrontmatterError('this block scalar line is indented less than the block\'s first line', ctx.lineNo(next));
  }
  const body = lines.slice(i + 1, next);
  return { value: foldBlock(body, contentIndent, style === '>', chomp), next };
}

/**
 * Joins block scalar lines per YAML's literal or folded rules, then chomps.
 *
 * Folding: a single break between two normal lines becomes a space; a break
 * followed by n empty lines becomes n newlines; breaks around more-indented
 * lines (those starting with whitespace) are kept.
 *
 * @param {string[]} body       The block's raw lines, trailing blanks included.
 * @param {number} indent       The content indentation to strip.
 * @param {boolean} folded      True for `>`, false for `|`.
 * @param {'' | '-' | '+'} chomp  Clip, strip or keep.
 * @returns {string}  The scalar value.
 *
 * @example
 * foldBlock(['  a', '  b', ''], 2, true, ''); // 'a b\n'
 */
function foldBlock(body, indent, folded, chomp) {
  let result = '';
  let empty = 0;
  let started = false;
  let moreIndented = false;
  for (const line of body) {
    if (/^ *$/.test(line) && line.length <= indent) { empty += 1; continue; }
    const text = line.slice(indent);
    if (!folded) {
      result += '\n'.repeat(started ? empty + 1 : empty);
    } else if (/^[ \t]/.test(text)) {
      moreIndented = true;
      result += '\n'.repeat(started ? empty + 1 : empty);
    } else if (moreIndented) {
      moreIndented = false;
      result += '\n'.repeat(empty + 1);
    } else if (empty === 0) {
      result += started ? ' ' : '';
    } else {
      result += '\n'.repeat(empty);
    }
    result += text;
    started = true;
    empty = 0;
  }
  return chompBlock(result, empty, started, chomp);
}

/**
 * Applies a block scalar's chomping indicator to its trailing line breaks.
 *
 * @param {string} text       The content so far, without its final break.
 * @param {number} empty      Trailing empty lines after the last content line.
 * @param {boolean} started   Whether any content line was read.
 * @param {'' | '-' | '+'} chomp  `''` clip (one break), `-` strip, `+` keep all.
 * @returns {string}  The chomped value.
 *
 * @example
 * chompBlock('text', 2, true, '+'); // 'text\n\n\n'
 */
function chompBlock(text, empty, started, chomp) {
  if (chomp === '-') return text;
  if (chomp === '+') return text + '\n'.repeat(started ? empty + 1 : empty);
  return started ? `${text}\n` : text;
}
