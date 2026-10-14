import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { type Agent, type AlarmEvent, type Kind, buildEvent, labelFor } from "./events.js";
import {
  claim,
  claimEvent,
  clearPending,
  clearSessionPending,
  clearSignaled,
  findArming,
  isSignaled,
  markSignaled,
  pendingId,
  rateLimited,
  recordPending,
  signalKey,
  signaledKind,
  takePending,
} from "./state.js";

/**
 * The fields we read from an agent's hook payload. Everything else in it (prompts, transcripts,
 * assistant messages, tool output) is ignored. `command` is read only to recognise code-alarm's own
 * commands, and `requestHash` (a hash of the tool's input) only to pair a Codex approval request
 * with the tool run that answers it. Neither is ever sent; only the hash is kept, locally.
 */
export interface HookInput {
  event: string;
  sessionId?: string;
  cwd?: string;
  turnId?: string;
  promptId?: string;
  command?: string;
  requestHash?: string;
}

export type HookAgent = "claude" | "codex";
export type SignalKind = "done" | "needs_input" | "failed";

type SendAction = { type: "send"; kind: Kind; fallback: boolean; consume: boolean; rateLimitMs?: number };

export type Action =
  | SendAction
  | { type: "signal"; kind: SignalKind; cwd: string }
  | { type: "await-answer" }
  | { type: "tool-ran" }
  | { type: "clear-signal" }
  | { type: "none" };

/** Permission prompts can come one after another; one alert per two minutes is enough to get you there. */
export const NEEDS_INPUT_WINDOW_MS = 2 * 60_000;

/**
 * How long a Codex approval request may go unanswered before it counts as "needs you". Codex's
 * auto-review answers most in a second or two, and in the owner's logs every escalated command had
 * finished within 28 s (docs/agents.md).
 */
export const PENDING_WAIT_MS = 45_000;

const NEEDS_INPUT: SendAction = { type: "send", kind: "needs_input", fallback: false, consume: false, rateLimitMs: NEEDS_INPUT_WINDOW_MS };

/** Events after which none of the session's approval requests can still be waiting. */
const ENDS_WAITING = new Set(["Stop", "StopFailure", "UserPromptSubmit"]);

export interface Deps {
  home: string;
  now: () => number;
  send: (event: AlarmEvent) => void | Promise<void>;
  /** Starts a detached waiter that runs firePending(id, at) after PENDING_WAIT_MS. */
  wait: (id: string, at: number) => void;
  cwd: () => string;
}

const str = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

export function parseHookInput(raw: string): HookInput | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const event = str(data.hook_event_name);
    if (!event) return null;
    const toolInput = data.tool_input && typeof data.tool_input === "object" ? (data.tool_input as Record<string, unknown>) : {};
    const command = str(toolInput.command);
    // Codex gives an approval request and the tool run that follows it the same command (shell,
    // apply_patch); a request's description isn't part of it. Other tools (MCP) compare their input whole.
    const request = command ?? (data.tool_input === undefined ? undefined : JSON.stringify(data.tool_input));
    return {
      event,
      sessionId: str(data.session_id),
      cwd: str(data.cwd),
      turnId: str(data.turn_id),
      promptId: str(data.prompt_id),
      command,
      requestHash: request === undefined ? undefined : createHash("sha256").update(request).digest("hex").slice(0, 16),
    };
  } catch {
    return null;
  }
}

const SUBCOMMANDS = new Set(["arm", "disarm", "nap", "status", "test", "init", "install", "uninstall", "done", "needs-you", "failed", "help", "version"]);
const SIGNALS = new Set(["done", "needs-you", "failed"]);
const SHELL = /^(?:pwsh|powershell|bash|sh|zsh|cmd)(?:\.exe)?$/;
const SCRIPT_FLAG = /^[-/](?:c|lc|command)$/i;
const CHANGE_DIR = /^(?:cd|chdir|pushd|set-location|sl)$/;
/** Code run inside an argument (`$(…)`, backticks, `<(…)`), which this parser can't follow. */
const EXPANSION = /\$\(|`|[<>]\(/;

const basename = (word: string) => (word.split(/[\\/]/).pop() ?? "").toLowerCase();

/** A command line that runs code-alarm itself: the subcommand, and the folder it runs in. */
export interface OwnCommand {
  sub: string;
  cwd: string;
}

/**
 * Splits a command line into simple commands (on `;`, `&`, `|` and newlines outside quotes), each
 * a list of words with their quotes removed. Close enough to the shells agents use to find which
 * programs a command runs, which is all it's for. Null for brackets (subshells, groups), whose
 * scoping it doesn't follow.
 */
function simpleCommands(line: string): string[][] | null {
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
    } else if (c === "(" || c === ")") {
      return null;
    } else if (";&|\n\r".includes(c)) {
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

/** `code-alarm <sub>`, `node <path>/code-alarm.mjs <sub>` or `npx code-alarm <sub>`; otherwise null. */
function ownInWords(words: string[], cwd: string): OwnCommand | null {
  const first = basename(words[0]!);
  let i = 0;
  if (/^npx(?:\.cmd)?$/.test(first)) {
    i++;
    while (words[i]?.startsWith("-")) i++;
  } else if (/^node(?:\.exe)?$/.test(first)) {
    i++;
  }
  if (!words[i] || !/^code-alarm(?:\.mjs|\.cmd|\.ps1)?$/.test(basename(words[i]!))) return null;
  const sub = words[i + 1];
  return sub && SUBCOMMANDS.has(sub) ? { sub, cwd } : null;
}

function ownInLine(line: string, cwd: string, depth: number): OwnCommand | null {
  const commands = depth > 3 || EXPANSION.test(line) ? null : simpleCommands(line);
  if (!commands) return null;
  let own: OwnCommand | null = null;
  let dir = cwd;
  for (const words of commands) {
    const first = basename(words[0]!);
    if (CHANGE_DIR.test(first)) {
      // Follow a plain `cd <folder>`, so a signal is for the folder it runs in.
      const args = words.slice(1).filter((word) => !/^-(?:path|literalpath)$/i.test(word));
      // Not followed: variables, wildcards, `~` (home) at the start, and `cd -`. A `~` inside, as
      // in a Windows short name like RUNNER~1, is just a character.
      if (args.length !== 1 || /[$%*?]|^~/.test(args[0]!) || args[0] === "-") return null;
      dir = resolve(dir, args[0]!);
      continue;
    }
    let found: OwnCommand | null;
    if (SHELL.test(first)) {
      // A shell wrapper, such as Codex's `pwsh -Command "<script>"` on Windows: look at the script.
      const flag = words.findIndex((word, i) => i > 0 && SCRIPT_FLAG.test(word));
      const script = flag > 0 ? words.slice(flag + 1) : [];
      const inner = script.length === 1 ? script[0]! : script.map((word) => (/\s/.test(word) ? `"${word}"` : word)).join(" ");
      found = script.length > 0 ? ownInLine(inner, dir, depth + 1) : null;
    } else {
      found = ownInWords(words, dir);
    }
    if (!found) return null; // something else runs too, so the approval is about more than us
    // A signal (done, needs-you, failed) wins over a silent command like status next to it.
    if (!own || (!SIGNALS.has(own.sub) && SIGNALS.has(found.sub))) own = found;
  }
  return own;
}

/**
 * If `command` only runs code-alarm itself (after plain `cd`s, or inside a shell wrapper), its
 * subcommand and the folder it runs in; otherwise null. Text that merely mentions code-alarm, like
 * `echo code-alarm done` or a commit message, isn't ours, and neither is anything this can't follow.
 */
export function ownCommand(command: string | undefined, cwd: string): OwnCommand | null {
  return command ? ownInLine(command, resolve(cwd), 0) : null;
}

/** Which alert, if any, an agent event means (docs/protocol.md, "When an event is sent"). */
export function actionFor(agent: HookAgent, input: HookInput, cwd: string): Action {
  switch (input.event) {
    case "Stop":
      // Fires after every turn. Only a fallback: an explicit signal this turn takes precedence.
      return { type: "send", kind: "stopped", fallback: true, consume: true };
    case "StopFailure":
      return { type: "send", kind: "failed", fallback: false, consume: true };
    case "PermissionRequest": {
      // Observe only: the hook prints nothing, so the normal approval prompt still appears.
      const own = ownCommand(input.command, cwd);
      if (own?.sub === "done") return { type: "signal", kind: "done", cwd: own.cwd };
      if (own?.sub === "needs-you") return { type: "signal", kind: "needs_input", cwd: own.cwd };
      if (own?.sub === "failed") return { type: "signal", kind: "failed", cwd: own.cwd };
      // Approving our own arm, status and the like isn't "the agent needs you".
      if (own) return { type: "none" };
      // Codex fires this before it decides who answers, and its auto-review often approves within a
      // second or two without asking anyone. So wait, and ring only if the request goes unanswered.
      return agent === "codex" ? { type: "await-answer" } : NEEDS_INPUT;
    }
    case "PostToolUse":
      return agent === "codex" ? { type: "tool-ran" } : { type: "none" };
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
    const cwd = input.cwd ?? deps.cwd();
    if (input.sessionId && ENDS_WAITING.has(input.event)) {
      try {
        clearSessionPending(deps.home, input.sessionId);
      } catch {
        // At worst a needless "needs you" later; the alert this event may send matters more.
      }
    }
    const action = actionFor(agent, input, cwd);
    if (action.type === "none") return "";
    if (action.type === "signal") {
      // The agent is waiting for approval to run `code-alarm <signal>`: that wait is the signal.
      const result = await sendSignal(action.kind, agentOf(agent), action.cwd, deps, input.sessionId);
      return result.sent ? `hook ${agent} ${input.event}: ${action.kind} signal sent while awaiting approval` : "";
    }
    if (action.type === "tool-ran") {
      // The tool ran, so its approval request was answered, by the user or by auto-review.
      if (!input.sessionId || !input.requestHash) return "";
      const answered = clearPending(deps.home, pendingId(input.sessionId, input.requestHash));
      return answered ? `hook ${agent} ${input.event}: the approval request was answered, no needs_input` : "";
    }
    const now = deps.now();
    if (action.type === "clear-signal") {
      // A new prompt starts a new turn: forget this session's signal.
      if (input.sessionId) clearSignaled(deps.home, signalKey("", input.sessionId));
      const arming = findArming(deps.home, cwd, now);
      if (arming) clearSignaled(deps.home, arming.key);
      return "";
    }
    if (action.type === "await-answer") {
      if (!findArming(deps.home, cwd, now)) return ""; // Not armed: send nothing, and don't wait.
      if (input.sessionId && input.requestHash) {
        const id = pendingId(input.sessionId, input.requestHash);
        try {
          recordPending(deps.home, id, { at: now, cwd, sessionId: input.sessionId, turnId: input.turnId });
          deps.wait(id, now);
          return `hook ${agent} ${input.event}: needs_input in ${PENDING_WAIT_MS / 1000}s unless answered`;
        } catch {
          // Can't wait for the answer, so say it now: a needless alert is better than a lost one.
        }
      }
      return await sendAction(agent, NEEDS_INPUT, input, cwd, deps);
    }
    return await sendAction(agent, action, input, cwd, deps);
  } catch (e) {
    return `hook ${agent}: error ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Runs in the detached waiter, PENDING_WAIT_MS after a Codex approval request: sends needs_input
 * if nothing has answered the request since (its tool hasn't run and the turn hasn't ended).
 * Never throws.
 */
export async function firePending(id: string, at: number, deps: Deps): Promise<string> {
  try {
    const pending = takePending(deps.home, id, at);
    if (!pending) return "";
    const input: HookInput = { event: "PermissionRequest", sessionId: pending.sessionId, turnId: pending.turnId };
    const note = await sendAction("codex", NEEDS_INPUT, input, pending.cwd, deps);
    return note && `${note}, unanswered for ${PENDING_WAIT_MS / 1000}s`;
  } catch (e) {
    return `hook codex: error ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function sendAction(agent: HookAgent, action: SendAction, input: HookInput, cwd: string, deps: Deps): Promise<string> {
  const now = deps.now();
  const arming = findArming(deps.home, cwd, now);
  if (!arming) return ""; // Not armed: send nothing.
  const event = buildEvent({
    kind: action.kind,
    level: arming.level ?? "alarm",
    label: labelFor(arming.dir ?? cwd),
    agent: agentOf(agent),
    now,
    idParts: [agent, input.sessionId, input.turnId ?? input.promptId, action.kind],
  });
  // End-of-turn hooks can fire twice for one turn (another plugin's Stop hook can make the agent
  // go on). Both get the same event ID, so only the first one counts.
  if (action.consume && !claimEvent(deps.home, event.id, now)) {
    return `hook ${agent} ${input.event}: skipped, already handled for this turn`;
  }
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
  await deps.send(event);
  return `hook ${agent} ${input.event}: ${action.kind} queued`;
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
  // Recorded before the claim, so this session's Stop can't slip a "stopped" in meanwhile. If it
  // can't be recorded, send anyway: a duplicate is better than a lost alert.
  try {
    markSignaled(deps.home, key, now, kind);
  } catch {
    // Carry on.
  }
  if (kind !== "needs_input" && !claim(deps.home, arming)) return already;
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
