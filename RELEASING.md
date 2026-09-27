# Releasing a skill: lessons checklist

Things learned while releasing skills from this template. Add each lesson when it happens, not at the end.

## Before the first release

- [ ] **Test the install path in every host** (Claude Code, Codex, Antigravity, Gemini CLI). Where SKILL.md must sit for all of them to work from one repo is not yet verified.
- [ ] **Keep SKILL.md at `skills/<name>/SKILL.md`, never at the repo root.** Tested 2026-09-26 on Claude Code 2.1.283 and Codex 0.144.1. The root layout works everywhere except a Codex marketplace install, which reports "installed, enabled" and then loads nothing. `skills/<name>/` works in every Claude and Codex install path. It also lets a user copy just that one folder, where the root layout forces them to copy the whole repo, `src/`, `.github/` and tests included.
- [ ] **Verify what actually loaded; install messages can't be trusted.**
  - Claude: `claude plugin details <plugin>@<marketplace>` lists a plugin's skills without calling the model.
  - Codex: `codex debug prompt-input`, run in a neutral folder, shows whether `plugin:skill` reached the prompt.
- [ ] **Codex reads `.claude-plugin/marketplace.json`** (`codex plugin marketplace add <path>`), so no separate Codex marketplace file is needed. `.codex-plugin/plugin.json` still decides where the skills come from.
- [ ] **The name users type depends on how the skill was installed.** Document both forms in the README:
  - As a plugin, it's `plugin:skill` (e.g. `docket:docket`). Claude also treats any skills-folder entry containing `.claude-plugin/plugin.json` as a plugin (`<name>@skills-dir`).
  - As a bare skill folder, it's just `skill`.
  - Codex adds the prefix from the nearest plugin manifest in any parent folder, so test fixtures must live outside any plugin repo.
- [ ] **`claude plugin validate <dir>` checks only `marketplace.json` when both manifests exist.** Pass `.claude-plugin/plugin.json` as a file path to validate it too.
- [ ] **Clean up by hand after local install tests.** Uninstalling and removing the marketplace leaves `~/.claude/plugins/cache/<marketplace>/` behind, and Codex leaves empty cache folders.
- [ ] **Headless test runs:**
  - Claude: pass `--setting-sources project,local`, or user stop hooks overwrite the final output. Read `--output-format stream-json --verbose`.
  - Codex: pin `-m <model>`, because `exec` fails when the configured model is newer than the CLI.
- [ ] **Codex also loads user skills from `~/.codex/skills/`,** not only the documented `~/.agents/skills/`.
- [ ] **Antigravity can't be tested headlessly.** There's no `agy` on Windows, and `language_server.exe agentapi` needs a running IDE (`ANTIGRAVITY_LS_ADDRESS`). Check it by hand: open a workspace containing `.agents/skills/<name>/` and trigger the skill.
- [ ] **Antigravity is not Gemini CLI.** They're separate Google products with different folders and install mechanisms. Checked against https://antigravity.google/docs/skills and /docs/plugins on 2026-09-26:
  - Workspace skills live in `.agents/skills/<name>/`, the same folder Codex uses. The older `.agent/skills/` (singular) still works, and many blog posts still cite it.
  - Global skills live in `~/.gemini/config/skills/<name>/` for the IDE and 2.0. `~/.gemini/antigravity/skills/` is legacy. The Antigravity CLI uses `~/.gemini/antigravity-cli/skills/`.
  - Plugins are installed with `agy plugin install <local path>`, from local paths only (no git URL). A plugin has a bare `plugin.json` at its root (not in a dot-folder) and `skills/<name>/SKILL.md`.
- [ ] **Check the name for collisions.**
  - Search `anthropics/skills` and `anthropics/claude-plugins-official`'s `marketplace.json`.
  - Search every SKILL.md on GitHub with `gh search code "<name>" --filename SKILL.md`.
  - **Don't use the form `gh search code "name: <name>" --filename SKILL.md`.** It returns nothing even for skills that exist (tested 2026-09-26: `"name: pdf"` misses `anthropics/skills`'s pdf skill, while a bare `"pdf"` finds it). An empty result from that form proves nothing.
  - Always run one query that must hit, so you know an empty result means "none" and not "broken query".
- [ ] **Check for mistrigger risk.** Look for common words people say for other reasons, and for other domains' meaning of the name. `docket` means a court docket to legal plugins, e.g. `anthropics/claude-for-legal`.
- [ ] **Name each repo's Claude marketplace after its skill.** A user can hold only one marketplace per name, so if every skill repo shipped `"name": "stonecypher"`, the second one added would collide with the first. `npm run init-skill` sets this for you.
- [ ] **After `npm run init-skill`, search the repo for `skill-template`.** Any hit outside `src/scripts/` is a spot the rename missed.
- [ ] **The SKILL.md `description` has two hard limits:** at most 1024 characters, and no `<` or `>`. Claude rejects angle brackets, so placeholders like `<thing>` can't stay in a shipped description.
- [ ] **Trigger-test the description before shipping, one headless run at a time.** Parallel `claude -p` runs get killed together by Claude Code's memory reaper, leaving no output. Use `claude -p "<prompt>" --plugin-dir <repo> --setting-sources project,local --output-format stream-json --verbose > out.jsonl`. Look for `"name":"Skill"` with your skill in `out.jsonl`, and check the opening skill list for competing user-level skills. Test phrases that should fire and phrases that shouldn't, including the name's other meanings. docket passed 6 of 6 on 2026-09-26.
- [ ] **If the skill reads a user config file, SKILL.md must spell out every rule**: lookup order, no merging between files, unknown keys, invalid values, invalid JSON. The model reads the file itself, so nothing else enforces those rules.
- [ ] **Check that special characters survived.** Typed non-breaking spaces (U+00A0) can be saved as ordinary spaces. Grep for `\x{00A0}` if the skill depends on them.
- [ ] **Run `npm test` again after adding the first file under `references/`,** not only right after init. Tests can pass on the template and fail once references exist.
- [ ] **Write the guard sentence**: the `description` says what the skill is NOT for.
- [ ] **Strip personal preferences and provenance notes** before shipping.

## Changing the template itself

- [ ] **Run `npm test` on an initialized copy, not just on the template.** Tests that read `skills/skill-template/` pass on the template and break in every skill made from it (found 2026-09-26).
- [ ] **`node --test <folder>` changed meaning in Node 21.** It now treats the folder as a module and fails with MODULE_NOT_FOUND. Pass a glob such as `"src/scripts/**/*.test.mjs"`, and run CI on the Node versions users actually have.

## Right after creating the repo from the template

- [ ] **Apply the branch ruleset.** Rulesets aren't copied when a repo is created from a template: `gh api repos/<owner>/<repo>/rulesets --method POST --input .github/ruleset.json`.
- [ ] **Check the required-check names against a real PR's check list before relying on the ruleset.** Checks match by name, and a name nothing produces blocks every PR without any error message. The template requires `gate` (from `ci.yml`) and `Conventional Commits` (from `commits.yml`).
- [ ] **Create the `mistrigger` label**, which the mistrigger issue form applies: `gh label create mistrigger --description "Skill fired when it shouldn't, or didn't when it should"`.

## Every release

- [ ] **Bump every manifest version together.** Otherwise `/plugin update` silently does nothing. This happens in practice: on 2026-09-26, self-expression's Claude manifest said `0.6.1` while its Codex manifest said `0.1.0`. `npm run validate` fails CI on any mismatch.

- [ ] **Dry-run first.** `npm run release` only prints the planned version and changelog section; read them, then run `npm run release -- --write`.
- [ ] **Reword non-conventional commits before merging.** `lint-commits` catches them in the PR, and any commit the release script ignores never reaches the version or the changelog.
- [ ] **The release commit goes through a PR, because main is protected.** Tag only the merged commit on main, never the release branch.
- [ ] **Pushing the tag is the moment you ship.** Treat it as its own step that needs a deliberate yes.
- [ ] **Going to 1.0.0 is a choice, never an accident.** Before 1.0 a breaking change bumps minor, so only `npm run release -- --version 1.0.0 --write` gets you there.
- [ ] **Put hand-written release notes under `## [Unreleased]`** in CHANGELOG.md; the release moves them into the new section.

## After publishing

- [ ] **Delete the local dev copy after installing the published one,** so the two don't load as duplicates.
