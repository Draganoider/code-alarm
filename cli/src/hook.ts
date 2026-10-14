import { type Agent, type AlarmEvent, type Kind, buildEvent, labelFor } from "./events.js";
import { clearSignaled, consume, findArming, isSignaled, markSignaled, rateLimited } from "./state.js";

/** The fields we read from an agent's hook payload. Everything else in it (prompts, transcripts) is ignored. */
export interface HookInput {
  event: string;
  sessionId?: string;
  cwd?: string;
  turnId?: string;
  promptId?: string;
  notificationType?: string;
}

export type HookAgent = "claude" | "codex";

export type Action =
  | { type: "send"; kind: Kind; fallback: boolean; consume: boolean; rateLimitMs?: number }
  | { type: "clear-signal" }
  | { type: "none" };

/** Permission prompts can come one after another; one alarm per two minutes is enough to get you there. */
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
    return {
      event,
      sessionId: str(data.session_id),
      cwd: str(data.cwd),
      turnId: str(data.turn_id),
      promptId: str(data.prompt_id),
      notificationType: str(data.notification_type),
    };
  } catch {
    return null;
  }
}

/** Which alert, if any, an agent event means (docs/protocol.md, "Hook mapping"). */
export function actionFor(agent: HookAgent, input: HookInput): Action {
  switch (input.event) {
    case "Stop":
      // Fires after every turn. Only a fallback: an explicit signal this turn takes precedence.
      return { type: "send", kind: "stopped", fallback: true, consume: true };
    case "StopFailure":
      return agent === "claude" ? { type: "send", kind: "failed", fallback: false, consume: true } : { type: "none" };
    case "Notification":
      if (agent !== "claude") return { type: "none" };
      if (input.notificationType && input.notificationType !== "permission_prompt") return { type: "none" };
      return { type: "send", kind: "needs_input", fallback: false, consume: false, rateLimitMs: NEEDS_INPUT_WINDOW_MS };
    case "PermissionRequest":
      // Codex. Observe only: the hook prints nothing, so the normal approval prompt still appears.
      return agent === "codex"
        ? { type: "send", kind: "needs_input", fallback: false, consume: false, rateLimitMs: NEEDS_INPUT_WINDOW_MS }
        : { type: "none" };
    case "UserPromptSubmit":
      return { type: "clear-signal" };
    default:
      return { type: "none" };
  }
}

const agentOf = (agent: HookAgent): Agent => (agent === "claude" ? "claude-code" : "codex");

/**
 * Handles one hook call. Never throws: a hook must never break or stall the agent (hard rule 6).
 * Returns a short line for the local log, or "" when there's nothing worth logging.
 */
export async function runHook(agent: HookAgent, raw: string, deps: Deps): Promise<string> {
  try {
    const input = parseHookInput(raw);
    if (!input) return "";
    const action = actionFor(agent, input);
    if (action.type === "none") return "";
    const cwd = input.cwd ?? deps.cwd();
    const now = deps.now();
    const arming = findArming(deps.home, cwd, now);
    if (!arming) return ""; // Not armed: send nothing (DR-003).
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

export type SignalKind = "done" | "needs_input" | "failed";

/** `code-alarm done | needs-you | failed`, run by the agent itself when its skill tells it to. */
export async function runSignal(kind: SignalKind, agent: Agent, deps: Deps): Promise<{ sent: boolean; message: string }> {
  const cwd = deps.cwd();
  const now = deps.now();
  const arming = findArming(deps.home, cwd, now);
  if (!arming) return { sent: false, message: "Not armed here, so nothing was sent." };
  const event = buildEvent({ kind, label: labelFor(arming.dir ?? cwd), agent, now });
  await deps.send(event);
  markSignaled(deps.home, arming.key, now);
  if (kind !== "needs_input") consume(deps.home, arming);
  const what = kind === "needs_input" ? "needs you" : kind;
  return { sent: true, message: `Alarm sent: ${what} (${event.label}).` };
}
