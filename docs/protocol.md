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
  "level": "alarm",
  "label": "my-project",
  "agent": "claude-code",
  "sent_at": 1760400000000,
  "expires_at": 1760401800000
}
```

| Field | Meaning |
|---|---|
| `v` | Protocol version, `1` |
| `id` | 8 to 64 letters, digits and dashes; the CLI sends a UUID. Hook events: derived from the agent, session, turn and kind, so a hook that fires twice for the same turn produces the same ID. Explicit signals: random |
| `kind` | `done`, `needs_input`, `failed`, `stopped` or `test` |
| `level` | `alarm`: loud, repeating, through Do Not Disturb (the default). `notify`: one normal notification that pops up with sound and vibration, following the phone's sound settings. It comes from how the work was armed (`--notify`) |
| `label` | The armed project folder's **name**, never a path: at most 40 of `A–Z a–z 0–9 . _ -` and spaces |
| `agent` | `claude-code`, `codex` or `cli` |
| `sent_at`, `expires_at` | Milliseconds since the epoch. Events live 30 minutes, and never more than an hour; a receiver must ignore an expired one, and the relay refuses a `sent_at` more than 5 minutes ahead of its clock |

Every field is required, and no other field is allowed. [`protocol-examples.json`](protocol-examples.json)
has valid and invalid examples. The CLI's tests check its events against them, and so do the relay's.

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
| Claude Code `PermissionRequest` (observed only, never decided) | `needs_input` at once, at most once per 2 minutes | no |
| Codex `PermissionRequest` (observed only, never decided) | `needs_input` after 45 s if the request is still unanswered, within the same limit | no |
| …either agent, for code-alarm's own `done`, `needs-you` or `failed` | that signal itself, at once: the agent is waiting to send it | as that signal |
| …either agent, for code-alarm's own `arm`, `status` and the like | none | no |
| Codex `PostToolUse` | none; the tool ran, so its approval request was answered | no |
| Claude Code `StopFailure` | `failed` | yes |
| `Stop`, either agent, when no explicit signal came this turn | `stopped` | yes |
| `UserPromptSubmit`, either agent | none; clears "already signalled this turn" | no |

**Why Codex waits.** Codex runs its `PermissionRequest` hooks before it decides who answers. With
auto-review on, a model answers most requests in a second or two, and nobody is needed. A command
already approved for the session is answered at once too. The hook can't tell these from a request
that waits for you. So it records the request locally: hashes of the session and the command, never
the command itself. A detached waiter checks again 45 s later, and sends `needs_input` only if
nothing has answered the request:
- the command's `PostToolUse` (it ran) removes it;
- so do the session's `Stop`, `StopFailure` or `UserPromptSubmit` (the turn ended, or you're there).

What it can't see, so these still ring after 45 s: an approved command that runs for longer than
that, and a request that was denied while the agent went on working.

`Stop` fires after every turn, including when the agent stops to ask you something. That's why
it's only the fallback: if the agent ran `done`, `needs-you` or `failed` during the turn, the
`Stop` that follows sends nothing. The same signal twice in a turn is sent once. "This turn" belongs
to one agent session (the agents give their tools the session ID), so one session's signal never
silences another's `Stop`. A project arming is claimed before its end-of-task alert is sent, so two
hooks racing for it send one alert.

The installers pre-approve code-alarm's own commands, so an agent normally never has to ask:
- Claude Code: the skill's `allowed-tools`.
- Codex: `~/.codex/rules/code-alarm.rules`.

When one still asks to run `code-alarm done`, that request counts as the signal. You get the
right alert even when nobody is there to approve. Only a command that runs code-alarm itself counts
(after plain `cd`s, which set the folder it signals for, or inside a shell wrapper such as
`pwsh -Command`). Text that merely mentions it, like a commit message, and anything the hook can't
follow, like `$(…)`, is an ordinary approval. An end-of-turn hook that fires twice for one turn
sends once.

## Transports

**ntfy** (now). The event becomes a JSON publish to the configured server root, with a title, a
short message and an emoji tag. The priority is 5 (`max`) for `alarm`, which the ntfy app
keeps alerting until dismissed, and 4 (`high`) for `notify`, which pops up once with sound and
vibration
([format](https://docs.ntfy.sh/publish/#publish-as-json)). The ntfy topic and any access token
live only in your config file.

**Code Alarm app** (in testing; the app isn't public yet). The same event goes to the Code Alarm
relay (`https://relay.codealarm.workers.dev`), which pushes it to the paired Android phone. The app rings like an alarm clock, through Do
Not Disturb, until you press Stop. It rejects expired events and events whose `id` it has already
seen.

*Pairing, with a QR.* `code-alarm pair` makes a new 256-bit token on this computer and sends the
relay exactly two things: the name, and the token's SHA-256. The token itself never leaves the
computer.

```json
{ "name": "Windows PC", "token_hash": "3f1c…64 hex characters" }
```

The relay answers with a code. The CLI shows it as a QR of
`https://relay.codealarm.workers.dev/pair/<code>`, which works once for 10 minutes. The app scans
it, shows the computer's name, and pairs only when you tap Pair. Meanwhile the CLI asks the relay
every few seconds, with the token, whether a phone said yes.

*Pairing, with a typed code.* The app can show a six-character code instead, valid for 10 minutes
and usable once. `code-alarm pair <code>` sends the relay exactly two things:

```json
{ "code": "K7Q-4MZ", "name": "Windows PC" }
```

The relay answers with a token. Either way:
- the name is how the phone lists this computer: `--name`, or a generic one for the operating
  system, never the hostname;
- the token can ring that one phone and nothing else;
- it lives in your config file (readable only by you), and is never printed or logged. Pairing
switches the transport to the app and keeps any ntfy settings (`code-alarm use ntfy` switches
back). Code Alarm sends through one transport at a time, never both, which would ring twice.

*Sending.* `POST <relay>/v1/events` with `Authorization: Bearer <token>`; the body is the event,
byte for byte. The relay checks it against this page too: it refuses any other field, a label that
isn't plain characters, and an event that lives longer than an hour or has expired. It answers:

| Answer | The CLI |
|---|---|
| 200 `{"status": "sent"}` | Done. `"limited": true` means it went out as a notification: over 12 events an hour from this computer, or 3 a minute to the phone |
| 200 `{"status": "duplicate"}` | Done: the phone already has that `id`, so it won't ring again |
| 502 `push_failed` | Tries once more, with the same event |
| 401 | This computer was removed on the phone: pair again |
| 400, 410, 429, 503 | Logs it. 429 means over 60 events in an hour; 503 means the phone needs to open the app once |

*Status.* `code-alarm status --last` asks `GET <relay>/v1/events/<id>` what the phone did with the
last alert: whether it rang, how long after it was sent, and when it was stopped. The relay keeps
that, without the label, for a week.

*Unpairing.* `code-alarm unpair` (`DELETE <relay>/v1/senders/<id>`), or remove the computer in the
app. After that the token can't ring anything.
