# Changelog

Notable changes to the `code-alarm` CLI and the Claude Code plugin. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The alarm skill covers "wake me when my usage limit resets": the agent finds the reset time
  (or asks), schedules one `code-alarm test` for a minute after it with its own scheduler, and
  says that it only fires if the app or session is still open then.

## [0.2.2] — 2026-10-18

### Changed

- A new README: the logo, a picture of an agent finishing and the phone ringing, a diagram of
  what stays on your computer, both phone apps side by side, a commands table and
  troubleshooting. On npm its images and links now point at GitHub, so they show there too.

## [0.2.1] — 2026-10-18

### Changed

- When the phone can't be reached because Code Alarm on it was reinstalled or its data cleared
  (the relay's `phone_unreachable`), `code-alarm test` and the log now say so and how to fix it:
  pair again with `code-alarm pair`, and remove the old computer in the app. `code-alarm status`
  repeats it while the last alert since pairing failed that way, since a hook can only log it.

## [0.2.0] — 2026-10-16

### Added

- The Code Alarm app transport, for the Android app now in testing:
  - `pair <code>` pairs this computer with the phone through the Code Alarm relay. It sends only
    the code and a name (`--name`, or "Windows PC", "Mac" or "Linux computer"; never the hostname).
  - `unpair` removes this computer from the phone; `use ntfy|app` switches between the two.
  - `status --last` shows what the phone did with the last alert: whether it rang, how long after
    it was sent, and when it was stopped.
  - Events go to the relay as they are, with the token only in a header. A failed push is retried
    once with the same ID, which the relay dedupes.
  - `pair` uses the Code Alarm relay at `https://relay.codealarm.workers.dev`; `--relay` or
    `CODE_ALARM_RELAY` points it at another one, such as a local test relay.

- QR pairing: `code-alarm pair` with no code shows a QR in the terminal for the Code Alarm app to
  scan, and pairs once you tap Pair on the phone. The computer makes its own token and sends the
  relay only its hash. `pair <code>` still takes the code the app shows. The QR is drawn with
  Project Nayuki's QR Code generator (MIT), bundled with its notice.
- `docs/protocol-examples.json`: valid and invalid events, the contract the CLI and the Code Alarm
  relay both test against. `protocol.md` now states the rules exactly: the label's characters, the
  ID's form, the one-hour lifetime and the clock skew the relay allows.

### Fixed

- Codex's hooks run their own copy of the CLI, made by `install codex`, and an old copy can't read
  settings a newer version wrote: its alerts stopped silently. `status` now says when that copy is
  older than, or different from, the code-alarm you're running. `init`, `pair`, `unpair` and
  `use` update it, unless it's the newer one. Only the copy changes, so Codex doesn't ask to trust
  the hooks again. The bundle's banner now carries the version.

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

[Unreleased]: https://github.com/Draganoider/code-alarm/compare/v0.2.2...test
[0.2.2]: https://github.com/Draganoider/code-alarm/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Draganoider/code-alarm/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Draganoider/code-alarm/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Draganoider/code-alarm/releases/tag/v0.1.0
