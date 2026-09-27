/**
 * Tests the SKILL.md frontmatter parser: fixed cases from the YAML spec,
 * clear errors for everything outside the subset, and randomized round trips.
 *
 * Stochastic tests draw from a seeded PRNG. The seed is printed in every
 * failure message; rerun with FRONTMATTER_SEED=<seed> to reproduce.
 *
 * @see ./frontmatter.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, splitFrontmatter, resolvePlain, FrontmatterError } from './frontmatter.mjs';

/** Wraps frontmatter lines in fences, followed by a body. */
const doc = (lines, body = '') => `---\n${lines.join('\n')}\n---\n${body}`;

/** Parses fenced lines and returns just the data. */
const dataOf = lines => parseFrontmatter(doc(lines)).data;

/** Asserts that parsing throws a FrontmatterError whose message matches. */
const rejects = (lines, pattern) => assert.throws(
  () => parseFrontmatter(doc(lines)),
  err => err instanceof FrontmatterError && pattern.test(err.message),
);

describe('splitFrontmatter', () => {
  test('separates fenced lines from the body, keeping the body exact', () => {
    assert.deepEqual(splitFrontmatter('---\nname: x\n---\n\n# Title\n'), { lines: ['name: x'], body: '\n# Title\n' });
  });

  test('normalises CRLF and drops a BOM', () => {
    assert.deepEqual(splitFrontmatter('﻿---\r\nname: x\r\n---\r\nbody\r\n'), { lines: ['name: x'], body: 'body\n' });
  });

  test('rejects a file that does not open with a fence', () => {
    assert.throws(() => splitFrontmatter('# no frontmatter\n'), /line 1: the file must start/);
  });

  test('rejects an unclosed block', () => {
    assert.throws(() => splitFrontmatter('---\nname: x\n'), /never closed/);
  });
});

describe('scalars', () => {
  test('reads the template SKILL.md shape', () => {
    const { data, body } = parseFrontmatter('---\nname: skill-template\ndescription: Does a thing. Not for other things.\n---\n\n# skill-template\n');
    assert.deepEqual(data, { name: 'skill-template', description: 'Does a thing. Not for other things.' });
    assert.equal(body, '\n# skill-template\n');
  });

  test('strips trailing comments from plain values but keeps # inside words', () => {
    assert.deepEqual(dataOf(['a: one # note', 'b: C#-style', 'c: x#y']), { a: 'one', b: 'C#-style', c: 'x#y' });
  });

  test('resolves plain scalars with the core schema', () => {
    assert.deepEqual(dataOf(['a: true', 'b: null', 'c: 42', 'd: 1.5', 'e: 0.1.0', 'f: ~', 'g: 0x1F', 'h: -.inf']),
      { a: true, b: null, c: 42, d: 1.5, e: '0.1.0', f: null, g: 31, h: -Infinity });
    assert.ok(Number.isNaN(resolvePlain('.nan')));
  });

  test('folds a plain value across continuation lines', () => {
    assert.deepEqual(dataOf(['description: first line', '  second line', '', '  new para', 'name: x']),
      { description: 'first line second line\nnew para', name: 'x' });
  });

  test('reads single-quoted values, unescaping doubled quotes', () => {
    assert.deepEqual(dataOf(["a: 'it''s: fine # really'", "b: '' # empty"]), { a: "it's: fine # really", b: '' });
  });

  test('reads double-quoted escapes', () => {
    assert.deepEqual(dataOf(['a: "tab\\there \\"q\\" \\u00e9\\x41\\U0001F600 \\\\"']), { a: 'tab\there "q" éA\u{1F600} \\' });
  });

  test('an empty key with nothing indented under it is null', () => {
    assert.deepEqual(dataOf(['a:', 'b: 1']), { a: null, b: 1 });
  });

  test('skips comment and blank lines', () => {
    assert.deepEqual(dataOf(['# lead', '', 'a: 1', '   # indented comment', 'b: 2']), { a: 1, b: 2 });
  });

  test('empty frontmatter yields an empty object', () => {
    assert.deepEqual(parseFrontmatter('---\n---\nbody').data, {});
  });

  test('a key named __proto__ becomes an own property, not a prototype', () => {
    const data = dataOf(['__proto__: x']);
    assert.equal(Object.getPrototypeOf(data), Object.prototype);
    assert.ok(Object.hasOwn(data, '__proto__'));
  });
});

describe('block scalars (YAML 1.2 spec examples)', () => {
  test('chomping: strip, clip, keep (spec 8.4-8.6 shape)', () => {
    assert.deepEqual(dataOf(['strip: |-', '  text', 'clip: |', '  text', 'keep: |+', '  text', '', 'end: 1']),
      { strip: 'text', clip: 'text\n', keep: 'text\n\n', end: 1 });
  });

  test('literal keeps line breaks and inner indentation', () => {
    assert.deepEqual(dataOf(['a: |', '  line 1', '    indented', '', '  line 3']), { a: 'line 1\n  indented\n\nline 3\n' });
  });

  test('folded with more-indented lines (spec example 8.10)', () => {
    const lines = ['a: >', '', '  folded', '  line', '', '  next', '  line', '    * bullet', '', '    * list',
      '    * lines', '', '  last', '  line', '', '# Comment'];
    assert.deepEqual(dataOf(lines), { a: '\nfolded line\nnext line\n  * bullet\n\n  * list\n  * lines\n\nlast line\n' });
  });

  test('folded strip is the usual long-description form', () => {
    assert.deepEqual(dataOf(['description: >-', '  Reads PDFs and', '  fills forms.', '  Not for Word files.', 'name: pdf']),
      { description: 'Reads PDFs and fills forms. Not for Word files.', name: 'pdf' });
  });

  test('# inside a block scalar is content, and a header comment is allowed', () => {
    assert.deepEqual(dataOf(['a: | # header comment', '  # not a comment']), { a: '# not a comment\n' });
  });

  test('an empty block scalar is the empty string', () => {
    assert.deepEqual(dataOf(['a: >', 'b: |', '']), { a: '', b: '' });
  });

  test('a block scalar may end the frontmatter', () => {
    assert.deepEqual(parseFrontmatter('---\na: |\n  x\n---\nbody').data, { a: 'x\n' });
  });
});

describe('nested maps', () => {
  test('reads one level of nesting, including block scalars inside it', () => {
    assert.deepEqual(dataOf(['name: x', 'metadata:', '  author: me', '  note: >-', '    long', '    text', 'license: MIT']),
      { name: 'x', metadata: { author: 'me', note: 'long text' }, license: 'MIT' });
  });

  test('rejects a second level of nesting', () => rejects(['metadata:', '  inner:', '    deep: 1'], /line 4: nesting deeper than 1/));

  test('rejects ragged indentation inside a nested map', () => rejects(['metadata:', '    a: 1', '  b: 2'], /line 4: unexpected indentation/));
});

describe('outside the subset: clear errors, never a wrong parse', () => {
  const cases = [
    ['sequence under a key', ['tools:', '  - Read'], /sequences/],
    ['top-level sequence', ['- a'], /sequences/],
    ['flow sequence value', ['tags: [a, b]'], /flow collections/],
    ['flow map value', ['meta: {a: 1}'], /flow collections/],
    ['anchor', ['a: &x 1'], /anchors/],
    ['alias', ['a: *x'], /anchors/],
    ['tag', ['a: !!str 1'], /tags/],
    ['quoted key', ['"a": 1'], /quoted keys/],
    ['complex key', ['? a'], /complex keys/],
    ['colon in plain value', ['description: Use when: X'], /cannot contain ": "/],
    ['trailing colon in plain value', ['a: b:'], /cannot contain ": "/],
    ['multi-line double-quoted', ['a: "open', '  close"'], /must close on the same line/],
    ['multi-line single-quoted', ["a: 'open", "  close'"], /must close on the same line/],
    ['text after closing quote', ['a: "x" y'], /after the closing quote/],
    ['unknown escape', ['a: "\\q"'], /unknown escape/],
    ['short hex escape', ['a: "\\u12"'], /4 hex digits/],
    ['indentation indicator', ['a: |2', '    x'], /explicit indentation indicators/],
    ['bad block header', ['a: |x'], /invalid block scalar header/],
    ['duplicate key', ['a: 1', 'a: 2'], /line 3: duplicate key "a"/],
    ['tab indentation', ['meta:', '\ta: 1'], /tabs cannot indent/],
    ['stray indentation', ['a: "x"', '  b: 1'], /line 3: unexpected indentation/],
    ['not a mapping line', ['just text'], /expected "key: value"/],
    ['key without space after colon', ['a:b'], /expected "key: value"/],
    ['text after a comment that ended a plain value', ['a: x', '  # c', '  y'], /line 4: unexpected indentation/],
    ['trailing comment inside multi-line plain', ['a: x # c', '  y'], /comments inside a multi-line plain value/],
    ['block line less indented than first', ['a: |', '    x', '  y'], /indented less than/],
    ['reserved start character', ['a: @x'], /cannot start with "@"/],
    ['directive', ['%YAML 1.2'], /directives/],
  ];
  for (const [label, lines, pattern] of cases) {
    test(label, () => rejects(lines, pattern));
  }
});

// ---------------------------------------------------------------------------
// Stochastic tests
// ---------------------------------------------------------------------------

/** The seed for this run; set FRONTMATTER_SEED to replay a failure. */
const SEED = Number(process.env.FRONTMATTER_SEED ?? Date.now() % 2 ** 31);

/** How many random documents each property checks; FRONTMATTER_RUNS overrides it for soak runs. */
const RUNS = Number(process.env.FRONTMATTER_RUNS ?? 400);

/**
 * Makes a deterministic PRNG (mulberry32) so a failing seed can be replayed.
 *
 * @param {number} seed  Any 32-bit integer.
 * @returns {() => number}  A function returning floats in [0, 1).
 */
const prng = seed => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Random helpers bound to one PRNG. */
const gen = rand => {
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = xs => xs[int(0, xs.length - 1)];
  const times = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const word = () => pick('abcdefghijklmnopqrstuvwxyz'.split('')) + times(int(0, 7), () => pick('abcdefghijklmnopqrstuvwxyz0123456789.,;()/-\'"'.split(''))).join('');
  return { int, pick, times, word };
};

/** Words that the core schema would not read as a string. */
const TYPED_WORDS = /^(?:null|Null|NULL|true|True|TRUE|false|False|FALSE)$/;

/**
 * Builds a random string safe to write as a plain scalar: words of letters,
 * digits and harmless punctuation, starting with a letter, single-spaced.
 */
const plainText = g => g.times(g.int(1, 12), g.word).filter(w => !TYPED_WORDS.test(w)).join(' ') || 'fallback';

/** Builds a random one-line string with awkward characters, for quoting. */
const awkwardText = g => g.times(g.int(0, 20), () => g.pick(['a', 'Z', ' ', ':', '#', "'", '"', '\\', '-', '[', '{', '&', '*', '!', '|', '>', '%', '@', '`', 'é', '\u{1F600}', '\t', ','])).join('');

/** Builds a random multi-line string for literal blocks and double quotes. */
const multilineText = g => {
  const lines = g.times(g.int(1, 5), i => (i > 0 && g.int(0, 3) === 0 ? '' : (g.int(0, 3) === 0 && i > 0 ? '  ' : '') + plainText(g)));
  return lines.join('\n') + '\n'.repeat(g.int(0, 3));
};

/** Escapes a string for a double-quoted YAML scalar. */
const doubleQuote = s => `"${[...s].map(ch => {
  if (ch === '"') return '\\"';
  if (ch === '\\') return '\\\\';
  if (ch === '\n') return '\\n';
  if (ch === '\t') return '\\t';
  const cp = ch.codePointAt(0);
  return cp < 0x20 ? `\\x${cp.toString(16).padStart(2, '0')}` : ch;
}).join('')}"`;

/** The chomping indicator that reproduces a value's trailing newlines. */
const chompFor = s => {
  const trailing = /\n*$/.exec(s)[0].length;
  return trailing === 0 ? '-' : trailing === 1 ? '' : '+';
};

/**
 * Writes a string as a literal block. Requires a first line that is non-empty
 * and does not start with a space (else YAML needs an indentation indicator).
 */
const literalBlock = (s, pad) => {
  const content = s.replace(/\n+$/, '');
  const trailing = s.length - content.length;
  const lines = content.split('\n').map(l => (l === '' ? '' : pad + l));
  return [`|${chompFor(s)}`, ...lines, ...Array(Math.max(0, trailing - 1)).fill('')];
};

/**
 * Writes paragraphs as a folded block and returns the value YAML defines for
 * it: words within a paragraph are wrapped at random spaces (each break folds
 * back to one space) and n newlines between paragraphs are written as n
 * blank lines. Built from the spec's folding rule, not from the parser.
 */
const foldedBlock = (g, pad) => {
  const paras = g.times(g.int(1, 4), () => plainText(g));
  const gaps = g.times(paras.length - 1, () => g.int(1, 3));
  const trailing = g.int(0, 3);
  const value = paras.map((p, i) => p + (i < gaps.length ? '\n'.repeat(gaps[i]) : '')).join('') + '\n'.repeat(trailing);
  const wrap = p => p.split(' ').reduce((acc, w) => {
    if (acc.length > 0 && g.int(0, 2) > 0) acc[acc.length - 1] += ` ${w}`; else acc.push(w);
    return acc;
  }, []).map(l => pad + l);
  const body = paras.flatMap((p, i) => [...wrap(p), ...(i < gaps.length ? Array(gaps[i]).fill('') : [])]);
  return { value, lines: [`>${chompFor(value)}`, ...body, ...Array(Math.max(0, trailing - 1)).fill('')] };
};

/** Writes a plain string, sometimes wrapped over continuation lines. */
const plainLines = (g, s, pad) => {
  const words = s.split(' ');
  const out = [words[0]];
  for (const w of words.slice(1)) {
    if (g.int(0, 3) === 0) out.push(pad + w); else out[out.length - 1] += ` ${w}`;
  }
  return out;
};

/**
 * Generates one random scalar entry: its expected value and its YAML lines
 * (the first line is appended after `key: `).
 */
const scalarEntry = (g, pad) => {
  switch (g.int(0, 7)) {
    case 0: { const v = plainText(g); return { value: v, lines: plainLines(g, v, pad) }; }
    case 1: { const v = awkwardText(g).replace(/\t/g, ' '); return { value: v, lines: [`'${v.replaceAll("'", "''")}'`] }; }
    case 2: { const v = awkwardText(g) + multilineText(g); return { value: v, lines: [doubleQuote(v)] }; }
    case 3: { const v = multilineText(g); return { value: v, lines: literalBlock(v, pad) }; }
    case 4: return foldedBlock(g, pad);
    case 5: { const v = g.int(-1e6, 1e6); return { value: v, lines: [String(v)] }; }
    case 6: { const v = g.pick([true, false, null]); return { value: v, lines: [String(v)] }; }
    default: { const v = `${g.int(0, 9)}.${g.int(0, 99)}.${g.int(0, 999)}`; return { value: v, lines: [v] }; }
  }
};

/** Generates a random key that is unique within `used`. */
const freshKey = (g, used) => {
  const key = `${g.pick('abcdefghijklmnopqrstuvwxyz_'.split(''))}${g.times(g.int(0, 10), () => g.pick('abcdefghijklmnopqrstuvwxyz0123456789-_.'.split(''))).join('')}`;
  return used.has(key) || key === '__proto__' ? freshKey(g, used) : key;
};

/** Emits `key: first` plus continuation lines for one entry. */
const emit = (key, indent, { lines: [first, ...more] }) => [`${indent}${key}: ${first}`.trimEnd(), ...more];

/**
 * Generates a random frontmatter document and the data it must parse to.
 *
 * @returns {{ text: string, data: object, body: string }}
 */
const randomDocument = g => {
  const data = {};
  const out = [];
  const used = new Set();
  for (let n = g.int(0, 8); n > 0; n -= 1) {
    const key = freshKey(g, used);
    used.add(key);
    let last;
    if (g.int(0, 5) === 0) {
      const pad = ' '.repeat(g.int(1, 4));
      const inner = {};
      const innerUsed = new Set();
      out.push(`${key}:`);
      for (let m = g.int(1, 4); m > 0; m -= 1) {
        const k = freshKey(g, innerUsed);
        innerUsed.add(k);
        last = scalarEntry(g, pad + ' '.repeat(g.int(1, 3)));
        inner[k] = last.value;
        out.push(...emit(k, pad, last));
      }
      data[key] = inner;
    } else {
      last = scalarEntry(g, ' '.repeat(g.int(1, 4)));
      data[key] = last.value;
      out.push(...emit(key, '', last));
    }
    // A blank line after a keep (`+`) block belongs to that block's value, so
    // only a column-0 comment may follow one.
    const keeps = /^[|>]\+/.test(last.lines[0]);
    if (g.int(0, 4) === 0) out.push(keeps ? '# comment' : g.pick(['', '# comment']));
  }
  const body = g.pick(['', '\n', '# Title\n\nText with --- inside.\n', `\n${plainText(g)}`]);
  return { text: doc(out, body), data, body };
};

describe(`stochastic (seed ${SEED})`, () => {
  test('round-trips generated frontmatter to the data it was generated from', () => {
    const g = gen(prng(SEED));
    for (let run = 0; run < RUNS; run += 1) {
      const { text, data, body } = randomDocument(g);
      const parsed = parseFrontmatter(text);
      assert.deepEqual(parsed.data, data, `seed ${SEED}, run ${run}\n${text}`);
      assert.equal(parsed.body, body, `seed ${SEED}, run ${run}`);
    }
  });

  test('CRLF line endings parse to the same data as LF', () => {
    const g = gen(prng(SEED + 1));
    for (let run = 0; run < RUNS; run += 1) {
      const { text } = randomDocument(g);
      assert.deepEqual(parseFrontmatter(text.replaceAll('\n', '\r\n')).data, parseFrontmatter(text).data, `seed ${SEED}, run ${run}`);
    }
  });

  test('arbitrary input either parses or throws FrontmatterError, never anything else', () => {
    const g = gen(prng(SEED + 2));
    const alphabet = ['-', '-', ':', ' ', ' ', '\n', '\n', '\t', '#', '|', '>', '+', '"', "'", '\\', '[', '{', '&', 'a', 'b', '1', 'x', 'u'];
    for (let run = 0; run < RUNS * 5; run += 1) {
      const junk = `---\n${g.times(g.int(0, 60), () => g.pick(alphabet)).join('')}\n---\n`;
      try {
        const { data } = parseFrontmatter(junk);
        assert.equal(typeof data, 'object', `seed ${SEED}, run ${run}`);
      } catch (err) {
        assert.ok(err instanceof FrontmatterError, `seed ${SEED}, run ${run}: ${JSON.stringify(junk)} threw ${err}`);
      }
    }
  });
});
