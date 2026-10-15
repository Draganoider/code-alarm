# Changelog

Notable changes to the `code-alarm` CLI and the Claude Code plugin. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-10-14

### Added

- The `code-alarm` CLI, Node 22+, with no runtime dependencies.
  - **Setup:** `init` creates a private ntfy topic; `test` rings the phone.
  - **Arming:** `arm`, `nap`, `disarm` and `status`. Only armed work ever rings.
  - **Explicit signals:** `done`, `needs-you` and `failed`, run by the agent.
  - **Hooks:** `hook claude` and `hook codex`. They print nothing, always exit 0, and send in a
    detached process.
  - **Codex:** `install codex` and `uninstall codex`, for user-level hooks and a personal skill.
    Existing hooks are kept, and the file is backed up first.
- The Claude Code plugin: `Stop`, `StopFailure`, `PermissionRequest` and `UserPromptSubmit` hooks,
  the `/code-alarm:alarm` skill, and `code-alarm` on the PATH.
- A Claude Code plugin marketplace at the repository root.
- The event protocol, version 1 ([docs/protocol.md](docs/protocol.md)), with tests proving that
  nothing but its fields leaves the computer.
- A `notify` level next to the alarm: `arm --notify`, `nap --notify`, `test --notify`, or "quiet"
  in the skill. It sends one normal notification that pops up with sound and vibration (ntfy
  priority 4) instead of the repeating alarm. Events carry `level`.
- code-alarm's own commands never need approval:
  - the Claude Code skill pre-approves them (`allowed-tools`);
  - `install codex` writes `~/.codex/rules/code-alarm.rules`.

  If an agent still asks to run `code-alarm done`, that request counts as the signal. Only a
  command that runs code-alarm itself counts, not text that mentions it.
- Codex approval requests ring "needs you" only if nobody answers them within 45 s. Codex's
  auto-review approves most requests in a second or two, so ringing at once woke you for nothing.
  `install codex` adds an async `PostToolUse` hook: when the command runs, its request was
  answered. The turn ending or a new prompt also clears it. The request is kept locally as hashes,
  never the command. Claude Code still rings at once.
- "Signalled this turn" is kept per agent session, and a project arming is claimed before its
  alert is sent: one session never silences another's alert, and two racing hooks send one alert.
- `install codex` backs up a rules file or skill it didn't write, and refuses a folder it can't
  quote safely; `uninstall codex` removes only its own files. The npm package includes the
  license and README. `status` never shows the topic.

[Unreleased]: https://github.com/Draganoider/code-alarm/compare/v0.1.0...test
[0.1.0]: https://github.com/Draganoider/code-alarm/releases/tag/v0.1.0
