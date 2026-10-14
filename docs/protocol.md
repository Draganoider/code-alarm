# Event protocol, version 1

What `code-alarm` sends when an armed session needs you. This is the **only** data that leaves your
computer: no prompts, code, file paths, transcripts or assistant messages. A test in
[`cli/test/privacy.test.ts`](../cli/test/privacy.test.ts) fails if anything else appears.

## The event

```json
{
  "v": 1,
  "id": "6f1c2a9e-4b7d-8e21-a0c3-5d9f1e2b7c44",
  "kind": "done",
  "label": "my-project",
  "agent": "claude-code",
  "sent_at": 1760400000000,
  "expires_at": 1760401800000
}
```

| Field | Meaning |
|---|---|
| `v` | Protocol version, `1` |
| `id` | Hook events: derived from the agent, session, turn and kind, so a hook that fires twice for the same turn produces the same ID. Explicit signals: random |
| `kind` | `done`, `needs_input`, `failed`, `stopped` or `test` |
| `label` | The armed project folder's **name**: plain characters only, at most 40, never a path |
| `agent` | `claude-code`, `codex` or `cli` |
| `sent_at`, `expires_at` | Milliseconds since the epoch. Events live 30 minutes; a receiver must ignore an expired one |

## When an event is sent

Nothing is sent unless the work is **armed**:
- `code-alarm arm` arms a folder and everything under it, until its first end-of-task alert, or
  12 hours at most by default.
- `code-alarm nap <duration>` arms every session until it expires.

The alarm skill runs `code-alarm arm` for you.

| Agent event | Kind | Ends the arming? |
|---|---|---|
| `code-alarm done` (run by the agent) | `done` | yes (not a nap) |
| `code-alarm needs-you` (run by the agent) | `needs_input` | no |
| `code-alarm failed` (run by the agent) | `failed` | yes |
| Claude Code `Notification` with type `permission_prompt` | `needs_input`, at most once per 2 minutes | no |
| Codex `PermissionRequest` (observed only, never decided) | `needs_input`, at most once per 2 minutes | no |
| Claude Code `StopFailure` | `failed` | yes |
| `Stop`, either agent, when no explicit signal came this turn | `stopped` | yes |
| `UserPromptSubmit`, either agent | none; clears "already signalled this turn" | no |

`Stop` fires after every turn, including when the agent stops to ask you something. That's why
it's only the fallback: if the agent ran `done`, `needs-you` or `failed` during the turn, the
`Stop` that follows sends nothing.

## Transports

**ntfy** (now). The event becomes a JSON publish to the configured server root, at priority 5
(`max`), with a title, a short message and an emoji tag
([format](https://docs.ntfy.sh/publish/#publish-as-json)). The ntfy topic and any access token
live only in your config file.

**Code Alarm app** (planned). The same event goes to a relay, which pushes it to the Code Alarm
Android app. The app rings like an alarm clock, through Do Not Disturb, until you press Stop.
The app rejects expired events and events whose `id` it has already seen.
