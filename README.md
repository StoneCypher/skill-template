<!-- template-only:start -->
# skill-template

A GitHub template for one [Agent Skill](https://agentskills.io) that installs in Claude Code, Codex and Antigravity, and partly in Gemini CLI. Each skill gets its own repo made from this template.

## Using this template

1. Click **Use this template** on GitHub. Name the new repo after the skill.
2. Clone it and name the skill:

   ```sh
   git clone https://github.com/<you>/<repo>.git
   cd <repo>
   npm run init-skill -- <name> "<one-sentence description>"
   ```

   `init-skill` renames `skills/skill-template/` to `skills/<name>/`, then rewrites the name, description and GitHub URLs in SKILL.md, every manifest and `package.json`. It names the Claude marketplace after the skill, resets every version to `0.1.0`, resets `CHANGELOG.md` if there is one, and turns this README into the skill's README. It takes the repo from `git remote get-url origin`; pass `--repo owner/repo` to override that. It refuses to run a second time unless you pass `--force`.

   Names must be lowercase letters, digits and single hyphens, 1 to 64 characters, and must not contain `claude` or `anthropic`.
3. Edit `skills/<name>/SKILL.md`. Put the instructions in the body. In the `description`, name the phrases that should trigger the skill, and end it with a **guard sentence** ("Not for …") listing things people say that should *not* trigger it.
4. Check your work: `npm test` runs the repo's tests and `npm run validate` checks the skill and its manifests.
5. Run `npm run release` to cut a version, then work through [RELEASING.md](RELEASING.md).

There are no npm dependencies. You only need Node 20 or later.

### What each file is for

| File | Purpose |
|---|---|
| `skills/skill-template/SKILL.md` | The skill itself: frontmatter (`name`, `description`) and instructions. Put reference files beside it. |
| `.claude-plugin/plugin.json` | Claude Code plugin manifest. |
| `.claude-plugin/marketplace.json` | Claude Code marketplace, named after the skill, listing this repo as its one plugin. |
| `.codex-plugin/plugin.json` | Codex plugin manifest. |
| `plugin.json` | Antigravity plugin manifest. It has no version field. |
| `package.json` | Holds the repo's npm scripts, and a version that is kept in step with the manifests. It is never published to npm. |
| `src/scripts/init-skill.mjs` | Turns the template into your skill (step 2). |
| `src/scripts/validate.mjs` | `npm run validate`: checks SKILL.md and that all versions agree. |
| `src/scripts/checksums.mjs` | `npm run checksums`: writes checksums of the skill's files. |
| `src/scripts/release.mjs` | `npm run release`: bumps every manifest's version together. |
| `src/scripts/lint-commits.mjs` | Fails on commits without a Conventional Commits header, since `release` reads versions from those headers. |
| `src/scripts/lib/manifests.mjs` | The list of manifests and where each keeps its version. |
| `src/scripts/lib/rename.mjs` | The rename rules `init-skill` applies. |
| `src/scripts/lib/frontmatter.mjs` | Reads SKILL.md frontmatter. |
| `src/scripts/lib/conventional.mjs`, `semver.mjs` | Commit-header parsing and version arithmetic for `release`. |
| `src/scripts/**/*.test.mjs` | Tests, run with `node:test`. |
| `.github/workflows/commits.yml` | This repo's own CI: runs `lint-commits` on pull requests. |
| `.github/ruleset.json`, `.github/ISSUE_TEMPLATE/` | Branch rules to import, and issue forms (including one for reporting mistriggers). |
| `CHANGELOG.md` | Release notes; `init-skill` resets it to an empty Unreleased section. |
| `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` | Contributor guidance. |
| `RELEASING.md` | A release checklist. Add each lesson to it when you learn it. |
| `LICENSE` | MIT. |
| `.gitignore` | Keeps `build/`, `node_modules/` and OS clutter out of git. |

### Why there is no shared CI

Each skill repo stands on its own. It has no runtime or CI dependency on this template or on any other repo, and its workflows call no reusable workflow from elsewhere. If every skill called a shared workflow, a change to that one repo would run in all of them, and a compromise of it would spread to all of them too. Each repo carries its own copy of the scripts instead.

As a result, **changes to this template do not reach repos already made from it.** GitHub copies a template once and never syncs it. To bring a fix into an existing skill, copy it in by hand.

---

*Everything below this line becomes the skill's README.*
<!-- template-only:end -->
<!-- skill-only:start
# <name>

<description>

skill-only:end -->
## Install

### Claude Code

Install as a plugin:

```text
/plugin marketplace add <repo>
/plugin install <name>@<name>
```

Updates arrive through `/plugin update` when the version changes.

Or copy the skill folder into `~/.claude/skills/<name>/` for yourself, or into `.claude/skills/<name>/` for one project:

```sh
git clone https://github.com/<repo>.git <name>
cp -r <name>/skills/<name> ~/.claude/skills/
```

### Codex

Copy the skill folder into `~/.agents/skills/<name>/` for yourself, or into `.agents/skills/<name>/` for one project:

```sh
git clone https://github.com/<repo>.git <name>
cp -r <name>/skills/<name> ~/.agents/skills/
```

The repo also ships a Codex plugin manifest, `.codex-plugin/plugin.json`.

### Antigravity

Install as a plugin. `agy` installs from local paths only, so clone the repo first:

```sh
git clone https://github.com/<repo>.git <name>
agy plugin install ./<name>
```

Or copy the skill folder into `.agents/skills/<name>/` in a workspace, or into `~/.gemini/config/skills/<name>/` globally. Older installs use `~/.gemini/antigravity/skills/` instead.

### Gemini CLI (untested)

```sh
gemini skills install https://github.com/<repo> --consent
```

Or copy the skill folder into `~/.gemini/skills/<name>/` or `~/.agents/skills/<name>/`.

### Windows

In PowerShell, replace `cp -r` with `Copy-Item -Recurse`, and write `~` as `$HOME`:

```powershell
Copy-Item -Recurse <name>\skills\<name> $HOME\.claude\skills\
```

## License

MIT. See [LICENSE](LICENSE).
