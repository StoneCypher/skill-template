# Contributing

This project is MIT licensed. Contributions are welcome.

The skill is `plugin/skills/<name>/SKILL.md` plus any optional reference files beside it in `plugin/skills/<name>/references/`, along with the manifests that let each host install it and a few zero-dependency Node scripts that check it. There is nothing to build and nothing to `npm install`.

**Nothing a user doesn't need goes under `plugin/`.** Hosts copy that whole folder into every user's plugin cache, so scripts, tests, `package.json` and other development files stay at the repo root. `npm run validate` warns about any it finds there.

## Table of contents

- [How do I set up?](#how-do-i-set-up)
- [How do I change the skill?](#how-do-i-change-the-skill)
- [How do I check my change?](#how-do-i-check-my-change)
- [How do I add or update a reference file?](#how-do-i-add-or-update-a-reference-file)
- [How do I write a commit message?](#how-do-i-write-a-commit-message)
- [How do I submit a pull request?](#how-do-i-submit-a-pull-request)
- [How is a release made?](#how-is-a-release-made)

---

## How do I set up?

Clone the repo. You need Node 22 or later. There are no dependencies to install.

To try your changes in Claude Code without installing anything, run `claude --plugin-dir ./plugin` from the repo root.

---

## How do I change the skill?

Edit `plugin/skills/<name>/SKILL.md`.

- **The frontmatter `description` decides when the skill loads.** Hosts read it to choose which skill to use, so a change to it changes when the skill fires, not just how it reads. Name the phrases that should trigger it.
- **Keep `<` and `>` out of the `description`.** Claude Code rejects a skill whose description contains angle brackets; `npm run validate` reports it as an error.
- **Keep the "Not for…" guard sentence.** The `description` ends with a sentence saying what the skill is *not* for. It is what stops the skill firing on requests that merely share a word with it. If you change what the skill covers, update that sentence too; don't delete it.
- **Keep the body concise.** Long reference material goes in `plugin/skills/<name>/references/`, and the body says when to load each file.

If your change is meant to fix a mistrigger, put the prompt that misfired in the PR description.

---

## How do I check my change?

```bash
npm test
npm run validate
```

`npm test` runs the scripts' own tests. `npm run validate` checks the skill and its manifests: frontmatter, names, matching versions across every manifest, reference checksums, that the marketplace points at `plugin/`, and that `plugin/LICENSE` matches `LICENSE`. CI runs both, so run them before you push.

---

## How do I add or update a reference file?

Every file in `plugin/skills/<name>/references/` is pinned by checksum, so an accidental edit is caught and every change is deliberate. After adding, changing or removing one, regenerate the checksums:

```bash
npm run checksums
```

Commit the updated checksum file along with the reference file. `npm run validate` fails if they don't match.

---

## How do I write a commit message?

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/). CI checks every commit in a pull request. This matters beyond style: the release script works out the next version and the changelog from commit headers, so a commit whose header doesn't parse never reaches either.

**Format:** `type(scope): description`

The scope is optional. The description should be lowercase, imperative mood, no trailing period.

**Common types:**

| Type | Use for |
|---|---|
| `feat` | New skill behavior |
| `fix` | A bug fix, including a mistrigger fix |
| `docs` | Documentation-only changes (README, CONTRIBUTING) |
| `test` | Adding or updating tests |
| `refactor` | Changes that don't fix a bug or add behavior |
| `ci` | CI configuration |
| `chore` | Maintenance tasks |

**Examples:**

```text
feat: handle multi-file input
fix: stop triggering on "review my calendar"
docs: explain install for Gemini CLI
ci: run validate on node 22
```

---

## How do I submit a pull request?

1. Create a branch from `main`.
2. Make your changes.
3. Run `npm test` and `npm run validate` and make sure both pass.
4. Push your branch and open a PR against `main`.

All required CI checks must pass before merge.

---

## How is a release made?

Every manifest carries the skill's version, and they must all match, or hosts can silently skip an update. Don't edit version numbers by hand. The release script works out the next version from the commits since the last release and bumps every manifest together:

```bash
npm run release              # dry run: print the plan
npm run release -- --write   # bump every manifest and update CHANGELOG.md
```

Contributors don't need to do this. Maintainers do it when cutting a release.
