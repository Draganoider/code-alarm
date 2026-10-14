# Agent integration notes

Facts about Claude Code and Codex that this repository depends on. **Checked on 14 October 2026**
against the official docs and the owner's machine (Claude Code 2.1.295 on Windows, Codex desktop
app). Re-check after a major agent update, and correct this page when something changes.

## Claude Code

Docs: [hooks](https://code.claude.com/docs/en/hooks),
[plugin components](https://code.claude.com/docs/en/plugins/components),
[marketplaces](https://code.claude.com/docs/en/plugins/create-marketplace).

- **Plugin layout:** `.claude-plugin/plugin.json`, `hooks/hooks.json` (top-level `"hooks"` key,
  the same shape as in `settings.json`), `skills/<name>/SKILL.md`. Skills are invoked as
  `/<plugin>:<skill>`, so ours is `/code-alarm:alarm`.
- **`bin/` is on the PATH** of the Bash tool's shell while the plugin is enabled. That's how the
  skill can run `code-alarm` by name. We ship a POSIX shim (`bin/code-alarm`) and a Windows one
  (`bin/code-alarm.cmd`).
- **Hook commands** get `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`. In shell form, quote
  `"${CLAUDE_PLUGIN_ROOT}"` so a path with spaces stays one word.
- **Hook stdout matters:** a `UserPromptSubmit` hook's stdout is added to the prompt. Our hook
  never prints.
- **Events we use:**
  - `Stop`: every turn. The payload has `session_id`, `prompt_id` and `cwd`.
  - `StopFailure`: the turn ended on an error.
  - `Notification` with matcher `permission_prompt`.
  - `UserPromptSubmit`.
- **Built-in phone push** (Remote Control) exists, but Claude decides when to send it, and it's an
  ordinary notification.
- **Distribution:** `claude plugin marketplace add Draganoider/code-alarm`, then
  `claude plugin install code-alarm@code-alarm`. The marketplace is read from the repository's
  **default branch**, which is why `main` is our release branch. `claude plugin validate .` checks
  the manifest and the marketplace.

## Codex

Docs: [hooks](https://learn.chatgpt.com/docs/hooks),
[plugins](https://developers.openai.com/codex/plugins/build),
[skills](https://developers.openai.com/codex/skills).

- **Hooks:**
  - Read from `~/.codex/hooks.json` (and project `.codex/` folders), with the same three-level
    shape as Claude Code.
  - **On by default, but every hook must be trusted before it runs.** Trust is tied to the
    hook's exact command, so a changed command is skipped until it's trusted again. That's why
    `code-alarm install codex` points the hooks at a fixed copy of the CLI, which updates in place.
  - `async: true` runs a hook in the background, so it can't block or decide anything. We use it
    for all three hooks.
- **Events we use:**
  - `Stop`: the payload has `session_id`, `turn_id`, `cwd` and `last_assistant_message`. We ignore
    that last one.
  - `PermissionRequest`: Codex is about to ask for approval. A hook that prints nothing leaves the
    normal prompt alone.
  - `UserPromptSubmit`.
  - There's no `Notification` event.
- **Plugins:**
  - The manifest is `plugin.json` at the plugin root (`.codex-plugin/plugin.json` still works).
    Hooks live in `hooks/hooks.json` and use `${PLUGIN_ROOT}`.
  - Plugin hooks apply only to **manually installed desktop plugins**, and plugins with hooks
    **aren't eligible for OpenAI's public plugin directory**.
  - So Code Alarm installs into Codex with `code-alarm install codex` (user-level hooks and a
    personal skill) rather than as a plugin.
- **Skills:** repositories use `.agents/skills`. For personal skills, both `~/.agents/skills` and
  `~/.codex/skills` are in use on the owner's machine. We install to `~/.agents/skills/code-alarm`.
  Still to confirm with the desktop app: that it lists it.
