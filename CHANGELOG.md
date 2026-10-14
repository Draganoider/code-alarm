# Changelog

Notable changes to the `code-alarm` CLI and the Claude Code plugin. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The `code-alarm` CLI, Node 22+, with no runtime dependencies.
  - **Setup:** `init` creates a private ntfy topic; `test` rings the phone.
  - **Arming:** `arm`, `nap`, `disarm` and `status`. Only armed work ever rings.
  - **Explicit signals:** `done`, `needs-you` and `failed`, run by the agent.
  - **Hooks:** `hook claude` and `hook codex`. They print nothing, always exit 0, and send in a
    detached process.
  - **Codex:** `install codex` and `uninstall codex`, for user-level hooks and a personal skill.
    Existing hooks are kept, and the file is backed up first.
- The Claude Code plugin: `Stop`, `StopFailure`, `Notification` (permission prompts) and
  `UserPromptSubmit` hooks, the `/code-alarm:alarm` skill, and `code-alarm` on the PATH.
- A Claude Code plugin marketplace at the repository root.
- The event protocol, version 1 ([docs/protocol.md](docs/protocol.md)), with tests proving that
  nothing but its fields leaves the computer.
