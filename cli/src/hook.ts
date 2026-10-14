import { type Agent, type AlarmEvent, type Kind, buildEvent, labelFor } from "./events.js";
import { claim, clearSignaled, findArming, isSignaled, markSignaled, rateLimited, signalKey, signaledKind } from "./state.js";

/**
 * The fields we read from an agent's hook payload. Everything else in it (prompts, transcripts,
 * assistant messages) is ignored. `command` is read only to recognise code-alarm's own commands
 * locally: it is never sent anywhere.
 */
export interface HookInput {
  event: string;
  sessionId?: string;
  cwd?: string;
  turnId?: string;
  promptId?: string;
  command?: string;
}

export type HookAgent = "claude" | "codex";
export type SignalKind = "done" | "needs_input" | "failed";

export type Action =
  | { type: "send"; kind: Kind; fallback: boolean; consume: boolean; rateLimitMs?: number }
  | { type: "signal"; kind: SignalKind }
  | { type: "clear-signal" }
  | { type: "none" };

/** Permission prompts can come one after another; one alert per two minutes is enough to get you there. */
export const NEEDS_INPUT_WINDOW_MS = 2 * 60_000;

export interface Deps {
  home: string;
  now: () => number;
  send: (event: AlarmEvent) => void | Promise<void>;
  cwd: () => string;
}

const str = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

export function parseHookInput(raw: string): HookInput | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const event = str(data.hook_event_name);
    if (!event) return null;
    const toolInput = data.tool_input && typeof data.tool_input === "object" ? (data.tool_input as Record<string, unknown>) : {};
    return {
      event,
      sessionId: str(data.session_id),
      cwd: str(data.cwd),
      turnId: str(data.turn_id),
      promptId: str(data.prompt_id),
      command: str(toolInput.command),
    };
  } catch {
    return null;
  }
}

const SUBCOMMANDS = new Set(["arm", "disarm", "nap", "status", "test", "init", "install", "uninstall", "done", "needs-you", "failed", "help", "version"]);
const SHELL = /^(?:pwsh|powershell|bash|sh|zsh|cmd)(?:\.exe)?$/;
const SCRIPT_FLAG = /^[-/](?:c|lc|command)$/i;
const HARMLESS = /^(?:cd|pushd|set-location|sl)$/;

const basename = (word: string) => (word.split(/[\\/]/).pop() ?? "").toLowerCase();

/**
 * Splits a command line into simple commands (on `;`, `&`, `|`, newlines and brackets outside
 * quotes), each a list of words with their quotes removed. Close enough to the shells agents use
 * to find which programs a command runs, which is all it's for.
 */
function simpleCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  const endWord = () => {
    if (inWord && !/^\d*[<>]/.test(word)) words.push(word); // drop redirections like 2>&1
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && (line[i + 1] === '"' || line[i + 1] === "\\")) word += line[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === "&" && word.endsWith(">")) {
      word += c;
    } else if (";&|\n\r()".includes(c)) {
      endCommand();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/** The subcommand if `words` runs code-alarm; "" for a harmless command like cd; null for anything else. */
function ownInWords(words: string[], depth: number): string | null {
  const first = basename(words[0]!);
  if (SHELL.test(first)) {
    // A shell wrapper, such as Codex's `pwsh -Command "<script>"` on Windows: look at the script.
    const flag = words.findIndex((word, i) => i > 0 && SCRIPT_FLAG.test(word));
    const script = words.slice(flag + 1).map((word) => (/\s/.test(word) && words.length - flag > 2 ? `"${word}"` : word));
    return flag > 0 && script.length > 0 ? ownInLine(script.join(" "), depth + 1) : null;
  }
  if (HARMLESS.test(first)) return "";
  let i = 0;
  if (/^npx(?:\.cmd)?$/.test(first)) {
    i++;
    while (words[i]?.startsWith("-")) i++;
  } else if (/^node(?:\.exe)?$/.test(first)) {
    i++;
  }
  if (!words[i] || !/^code-alarm(?:\.mjs|\.cmd|\.ps1)?$/.test(basename(words[i]!))) return null;
  const sub = words[i + 1];
  return sub && SUBCOMMANDS.has(sub) ? sub : null;
}

function ownInLine(line: string, depth: number): string | null {
  if (depth > 3) return null;
  let own: string | null = null;
  for (const words of simpleCommands(line)) {
    const found = ownInWords(words, depth);
    if (found === null) return null; // something else runs too, so the approval is about more than us
    if (found && own === null) own = found;
  }
  return own;
}

/**
 * If `command` only runs code-alarm itself (plus harmless steps like `cd`), its subcommand ("done",
 * "arm"...); otherwise null. Text that merely mentions code-alarm, like `echo code-alarm done` or a
 * commit message, isn't ours.
 */
export function ownSubcommand(command: string | undefined): string | null {
  return command ? ownInLine(command, 0) : null;
}

/** Which alert, if any, an agent event means (docs/protocol.md, "When an event is sent"). */
export function actionFor(_agent: HookAgent, input: HookInput): Action {
  switch (input.event) {
    case "Stop":
      // Fires after every turn. Only a fallback: an explicit signal this turn takes precedence.
      return { type: "send", kind: "stopped", fallback: true, consume: true };
    case "StopFailure":
      return { type: "send", kind: "failed", fallback: false, consume: true };
    case "PermissionRequest": {
      // Observe only: the hook prints nothing, so the normal approval prompt still appears.
      const own = ownSubcommand(input.command);
      if (own === "done") return { type: "signal", kind: "done" };
      if (own === "needs-you") return { type: "signal", kind: "needs_input" };
      if (own === "failed") return { type: "signal", kind: "failed" };
      // Approving our own arm, status and the like isn't "the agent needs you".
      if (own) return { type: "none" };
      return { type: "send", kind: "needs_input", fallback: false, consume: false, rateLimitMs: NEEDS_INPUT_WINDOW_MS };
    }
    case "UserPromptSubmit":
      return { type: "clear-signal" };
    default:
      return { type: "none" };
  }
}

const agentOf = (agent: HookAgent): Agent => (agent === "claude" ? "claude-code" : "codex");

/**
 * Handles one hook call. Never throws: a hook must never break or stall the agent (hard rule 3).
 * Returns a short line for the local log, or "" when there's nothing worth logging.
 */
export async function runHook(agent: HookAgent, raw: string, deps: Deps): Promise<string> {
  try {
    const input = parseHookInput(raw);
    if (!input) return "";
    const action = actionFor(agent, input);
    if (action.type === "none") return "";
    const cwd = input.cwd ?? deps.cwd();
    if (action.type === "signal") {
      // The agent is waiting for approval to run `code-alarm <signal>`: that wait is the signal.
      const result = await sendSignal(action.kind, agentOf(agent), cwd, deps, input.sessionId);
      return result.sent ? `hook ${agent} ${input.event}: ${action.kind} signal sent while awaiting approval` : "";
    }
    const now = deps.now();
    if (action.type === "clear-signal") {
      // A new prompt starts a new turn: forget this session's signal.
      if (input.sessionId) clearSignaled(deps.home, signalKey("", input.sessionId));
      const arming = findArming(deps.home, cwd, now);
      if (arming) clearSignaled(deps.home, arming.key);
      return "";
    }
    const arming = findArming(deps.home, cwd, now);
    if (!arming) return ""; // Not armed: send nothing.
    if (action.fallback) {
      // The session's own signal, or one sent without a session ID (e.g. from a terminal).
      const keys = [signalKey(arming.key, input.sessionId), arming.key];
      if (keys.some((key) => isSignaled(deps.home, key))) {
        for (const key of keys) clearSignaled(deps.home, key);
        return `hook ${agent} ${input.event}: skipped, the agent already signalled this turn`;
      }
    }
    if (action.rateLimitMs && rateLimited(deps.home, arming.key, action.kind, now, action.rateLimitMs)) {
      return `hook ${agent} ${input.event}: skipped, ${action.kind} sent less than ${action.rateLimitMs / 1000}s ago`;
    }
    if (action.consume && !claim(deps.home, arming)) {
      return `hook ${agent} ${input.event}: skipped, another alert already ended this arming`;
    }
    const event = buildEvent({
      kind: action.kind,
      level: arming.level ?? "alarm",
      label: labelFor(arming.dir ?? cwd),
      agent: agentOf(agent),
      now,
      idParts: [agent, input.sessionId, input.turnId ?? input.promptId, action.kind],
    });
    await deps.send(event);
    return `hook ${agent} ${input.event}: ${action.kind} queued`;
  } catch (e) {
    return `hook ${agent}: error ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function sendSignal(
  kind: SignalKind,
  agent: Agent,
  cwd: string,
  deps: Deps,
  sessionId: string | undefined,
): Promise<{ sent: boolean; message: string }> {
  const now = deps.now();
  const arming = findArming(deps.home, cwd, now);
  if (!arming) return { sent: false, message: "Not armed here, so nothing was sent." };
  const key = signalKey(arming.key, sessionId);
  const already = { sent: false, message: "That alert was already sent." };
  if (signaledKind(deps.home, key) === kind) return already;
  if (kind !== "needs_input" && !claim(deps.home, arming)) return already;
  markSignaled(deps.home, key, now, kind);
  const event = buildEvent({ kind, level: arming.level ?? "alarm", label: labelFor(arming.dir ?? cwd), agent, now });
  await deps.send(event);
  const what = kind === "needs_input" ? "needs you" : kind;
  return { sent: true, message: `${arming.level === "notify" ? "Notification" : "Alarm"} sent: ${what} (${event.label}).` };
}

/**
 * `code-alarm done | needs-you | failed`, run by the agent itself when its skill tells it to.
 * `sessionId` is the agent session it runs in, when the agent says (sessionFromEnv).
 */
export async function runSignal(kind: SignalKind, agent: Agent, deps: Deps, sessionId?: string): Promise<{ sent: boolean; message: string }> {
  return sendSignal(kind, agent, deps.cwd(), deps, sessionId);
}

/**
 * The session a command run by an agent belongs to: the same ID its hooks get as session_id.
 * Claude Code sets CLAUDE_CODE_SESSION_ID for its tools; Codex sets CODEX_THREAD_ID.
 */
export function sessionFromEnv(agent: Agent, env: NodeJS.ProcessEnv): string | undefined {
  if (agent === "claude-code") return env.CLAUDE_CODE_SESSION_ID || undefined;
  if (agent === "codex") return env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || undefined;
  return undefined;
}
