import { type Agent, type AlarmEvent, type Kind, buildEvent, labelFor } from "./events.js";
import { clearSignaled, consume, findArming, isSignaled, markSignaled, rateLimited, signaledKind } from "./state.js";

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

const SUBCOMMANDS = "arm|disarm|nap|status|test|init|install|uninstall|done|needs-you|failed|help|version";

/** If `command` runs code-alarm itself, its subcommand ("done", "arm"...); otherwise null. */
export function ownSubcommand(command: string | undefined): string | null {
  if (!command) return null;
  const match = new RegExp(`(?:^|[\\s"'\\\\/;&|])code-alarm(?:\\.mjs|\\.cmd)?["']?\\s+(${SUBCOMMANDS})(?=$|\\s)`).exec(command);
  return match ? match[1]! : null;
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
      const result = await sendSignal(action.kind, agentOf(agent), cwd, deps);
      return result.sent ? `hook ${agent} ${input.event}: ${action.kind} signal sent while awaiting approval` : "";
    }
    const now = deps.now();
    const arming = findArming(deps.home, cwd, now);
    if (!arming) return ""; // Not armed: send nothing.
    if (action.type === "clear-signal") {
      clearSignaled(deps.home, arming.key);
      return "";
    }
    if (action.fallback && isSignaled(deps.home, arming.key)) {
      clearSignaled(deps.home, arming.key);
      return `hook ${agent} ${input.event}: skipped, the agent already signalled this turn`;
    }
    if (action.rateLimitMs && rateLimited(deps.home, arming.key, action.kind, now, action.rateLimitMs)) {
      return `hook ${agent} ${input.event}: skipped, ${action.kind} sent less than ${action.rateLimitMs / 1000}s ago`;
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
    if (action.consume) consume(deps.home, arming);
    return `hook ${agent} ${input.event}: ${action.kind} queued`;
  } catch (e) {
    return `hook ${agent}: error ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function sendSignal(kind: SignalKind, agent: Agent, cwd: string, deps: Deps): Promise<{ sent: boolean; message: string }> {
  const now = deps.now();
  const arming = findArming(deps.home, cwd, now);
  if (!arming) return { sent: false, message: "Not armed here, so nothing was sent." };
  if (signaledKind(deps.home, arming.key) === kind) return { sent: false, message: "That alert was already sent." };
  const event = buildEvent({ kind, level: arming.level ?? "alarm", label: labelFor(arming.dir ?? cwd), agent, now });
  await deps.send(event);
  markSignaled(deps.home, arming.key, now, kind);
  if (kind !== "needs_input") consume(deps.home, arming);
  const what = kind === "needs_input" ? "needs you" : kind;
  return { sent: true, message: `${arming.level === "notify" ? "Notification" : "Alarm"} sent: ${what} (${event.label}).` };
}

/** `code-alarm done | needs-you | failed`, run by the agent itself when its skill tells it to. */
export async function runSignal(kind: SignalKind, agent: Agent, deps: Deps): Promise<{ sent: boolean; message: string }> {
  return sendSignal(kind, agent, deps.cwd(), deps);
}
