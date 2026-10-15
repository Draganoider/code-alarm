# Code Alarm CLI and plugins: instructions for AI coding agents

The `code-alarm` CLI and the Claude Code plugin. Agent hooks call the CLI, and the CLI rings the
user's phone when armed work finishes, stops or needs them. MIT licensed. Maintained by Yevhen
Mishchenko.

> **This file is the single source of truth for every AI agent working in this repository:**
> Claude Code, Codex, Cursor, Copilot and the rest. [`CLAUDE.md`](CLAUDE.md) only imports it.
> **Put rules here.** Humans should read it too.

## Read this first

- [`docs/protocol.md`](docs/protocol.md): the event format, when events are sent, and the hook
  mapping. The CLI implements it exactly.
- [`docs/agents.md`](docs/agents.md): verified facts about Claude Code and Codex hooks, plugins and
  skills, with dates. Trust it over your training data; when you find something newer, correct
  the page.

## Hard rules

1. **Nothing but the protocol's fields leaves the computer.** No prompts, code, file paths,
   transcripts or assistant messages. The label is only the folder's name.
   `cli/test/privacy.test.ts` must keep passing, and a new field needs a protocol version change.
2. **Only armed work rings.** A hook for an unarmed session sends nothing.
3. **A hook never breaks, stalls or talks back to the agent.** `code-alarm hook` always exits 0,
   **prints nothing to stdout**, and sends in a detached process. Claude Code feeds a
   `UserPromptSubmit` hook's stdout into the prompt, and Codex reads a `PermissionRequest` hook's
   stdout as a decision.
4. **Never decide a permission.** The Codex `PermissionRequest` hook only observes.
5. **Never commit secrets.** A user's config (ntfy topic, token) lives in their config folder, never
   in a repository. Never log the topic or a token.
6. **Never promise guaranteed delivery** in docs or output. Push is best-effort.
7. **No attribution trailers** in commits or pull requests: no `Co-Authored-By`, no "Generated
   with".

## Layout

| Path | Contents |
|---|---|
| `cli/src/` | The CLI: `main.ts` (commands), `hook.ts` (hook and signal logic), `state.ts` (arming), `events.ts` (protocol), `ntfy.ts`, `deliver.ts` (detached sending), `install.ts` (Codex), `skill.ts` (the alarm skill's text) |
| `cli/test/` | `node:test` suites; the privacy and hook tests are the important ones |
| `cli/dist/code-alarm.mjs` | The bundled CLI, **committed** and built by `cli/build.mjs`; also the npm package's entry |
| `plugins/claude-code/` | The Claude Code plugin: manifest, hooks, the skill (generated) and `bin/` (the bundle plus PATH shims) |
| `.claude-plugin/marketplace.json` | Makes this repository a Claude Code plugin marketplace |
| `docs/` | Protocol and agent notes |

## Working conventions

- **Branches.** `main` is the **default branch and the release branch**: plugin marketplaces install
  from it, so it only changes by a release pull request from `test`. Work is committed to `test`.
- **Generated files.** Never edit `cli/dist/`, `plugins/claude-code/bin/code-alarm.mjs` or
  `plugins/claude-code/skills/alarm/SKILL.md` by hand. Change `cli/src/` and run `npm run build`;
  CI fails if they're stale.
- **Before you push:** `cd cli && npm run check` (types, tests, build), then `git status` should show
  the rebuilt files committed too.
- **Changelog.** Every notable change adds a line under `## [Unreleased]` in
  [`CHANGELOG.md`](CHANGELOG.md), in the same commit.
- **Versions.** `cli/package.json`, `plugins/claude-code/.claude-plugin/plugin.json` and the
  changelog carry the same version.
- Code style: plain, readable TypeScript; comments only where the reason isn't obvious; zero
  runtime dependencies.
