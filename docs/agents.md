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
- **Pre-approving our commands:**
  - A skill's `allowed-tools` frontmatter lets Claude use the listed tools without asking, for the
    turn that invokes the skill. Ours lists `Bash(code-alarm *) PowerShell(code-alarm *)`.
  - Arguments after `/code-alarm:alarm` reach the skill (`$ARGUMENTS`, or appended as
    `ARGUMENTS:`), which is how "quiet" selects a notification.
- **Events we use:**
  - `Stop`: every turn. The payload has `session_id`, `prompt_id` and `cwd`. The same
    `session_id` reaches the tools as `CLAUDE_CODE_SESSION_ID` (it's the transcript's name;
    checked in the desktop app, 14 Oct 2026), which is how `code-alarm done` knows its session.
  - `StopFailure`: the turn ended on an error.
  - `PermissionRequest`: a permission dialog is about to show. Its `tool_input.command` tells us
    when the waiting command is code-alarm's own. We use it instead of `Notification`
    (`permission_prompt`), which doesn't say what's waiting.
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
    for all four hooks.
  - A hook that exits normally may leave detached helpers running: on Windows, Codex runs each hook
    in a job object and lets the job's other processes go on when the hook completes
    (`hooks/src/engine/command_runner.rs`, checked 14 Oct 2026). That's how the hook's detached
    sender and approval waiter outlive it.
- **Events we use:**
  - `Stop`: the payload has `session_id`, `turn_id`, `cwd` and `last_assistant_message`. We ignore
    that last one. Commands get the session as `CODEX_THREAD_ID` (and `CODEX_SESSION_ID`, the
    same value: the thread ID; codex-cli 0.162.0-alpha.17.2, 14 Oct 2026). Codex's session logs
    record that thread ID as `session_id`; that hooks get the same value is assumed, not yet seen.
  - `PermissionRequest`: Codex is about to ask for approval. A hook that prints nothing leaves the
    normal prompt alone.
    - The owner's first test showed why it matters: the model's `code-alarm done` needed approval,
      because it writes outside the sandbox, and the hook rang "needs you" two seconds before "done".
    - Fixed with a rules file and by recognising our own commands.
    - **It fires before Codex decides who answers.** The order is: hooks, then the auto-review
      "guardian" if it's on, otherwise the user (`core/src/tools/approvals.rs`, checked 14 Oct
      2026). With auto-review on (the desktop app's setting; the thread shows
      `approvals_reviewer: "auto_review"`), the guardian approves or declines, often in a second
      or two, and the user isn't asked. Seen in the owner's logs, 14 Oct 2026: the hook fired
      0.2 s before the guardian allowed `done`.
    - **It also fires for a command the user already approved for the session.** That cache is
      checked after the hooks, so the request is answered at once.
    - **The payload can't tell these apart.** It has `turn_id`, `tool_name`, `tool_input`
      (`command`, and `description`, the reason for the request, when there is one) and
      `permission_mode`, but no reviewer and no `tool_use_id`. `permission_mode` comes from the
      approval policy alone (`default` for on-request, `bypassPermissions` for never), so
      auto-review doesn't change it.
    - So for Codex we don't ring at once: the request waits 45 s, and rings only if its tool
      hasn't run and the turn hasn't ended by then (docs/protocol.md). In the owner's logs, 53 of
      220 tool calls were escalated, and every one had finished within 28 s.
  - `PostToolUse`: after a tool call **finishes**, with `turn_id`, `tool_name`, `tool_use_id`,
    `tool_input` and `tool_response`. It fires for shell commands (as `Bash`, including ones that
    exit non-zero) and for `apply_patch`, but not for a call that was denied. The docs and the
    source say so for every platform; it hasn't been seen in a run on the owner's machine yet.
    - For a shell command or a patch, `tool_input.command` is the same string the
      `PermissionRequest` had. That's how we pair the two.
    - A long command that yields keeps running, and its `PostToolUse` comes from the later
      `write_stdin` poll that sees it finish. So an approved command that runs longer than the
      wait still rings.
    - It runs after every tool call, so our hook does almost nothing then: it only removes a
      matching pending request.
  - `UserPromptSubmit`.
  - There's no `Notification` event.
  - A hook added later must be trusted before it runs, like the first ones. Until the user trusts
    `PostToolUse`, every approval request rings after the wait: later, but never lost.
- **Plugins:**
  - The manifest is `plugin.json` at the plugin root (`.codex-plugin/plugin.json` still works).
    Hooks live in `hooks/hooks.json` and use `${PLUGIN_ROOT}`.
  - Plugin hooks apply only to **manually installed desktop plugins**, and plugins with hooks
    **aren't eligible for OpenAI's public plugin directory**.
  - So Code Alarm installs into Codex with `code-alarm install codex` (user-level hooks and a
    personal skill) rather than as a plugin.
- **Rules** ([docs](https://developers.openai.com/codex/rules)): Starlark `prefix_rule(...)` files
  in `~/.codex/rules/`, read at startup. `decision = "allow"` lets a matching command run outside
  the sandbox without asking; the strictest matching rule wins. Experimental.
  `code-alarm install codex` writes `code-alarm.rules`, allowing only `arm`, `disarm`, `nap`,
  `status`, `done`, `needs-you` and `failed`.
  - **Windows wraps every command in PowerShell** (`powershell.exe -Command "<script>"` from the
    CLI, the bundled `pwsh.exe -Command` in the desktop app). Codex unwraps a simple script before
    matching, so the rule's `["node", <cli>, …]` prefix matches; a rule written against the
    PowerShell wrapper never does. Verified with `codex exec`, codex-cli 0.162.0-alpha.17.2, 14 Oct
    2026. `codex execpolicy check` doesn't unwrap anything, so test the bare command with it.
  - **Rules load when Codex starts.** The owner's first test "after installing" ran in Codex
    processes started 26 minutes before the rules file existed, so the rule wasn't loaded and
    auto-review handled `done`. Closing the window may leave Codex running; quit it completely.
  - The `PermissionRequest` fallback sends the right `done` anyway, so the alarm doesn't depend on
    the rule.
- **Skills:** repositories use `.agents/skills`. For personal skills, both `~/.agents/skills` and
  `~/.codex/skills` are in use on the owner's machine. We install to `~/.agents/skills/code-alarm`.
  The desktop app picked it up in the owner's first test (14 October 2026).
