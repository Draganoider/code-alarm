import { createHash, randomUUID } from "node:crypto";

/**
 * The only data that ever leaves the computer (docs/protocol.md). No prompts, code, file paths,
 * transcripts or assistant messages: a test fails if any other field appears.
 */
export interface AlarmEvent {
  v: 1;
  id: string;
  kind: Kind;
  /** "alarm": loud, repeating, through Do Not Disturb. "notify": one ordinary notification. */
  level: Level;
  label: string;
  agent: Agent;
  sent_at: number;
  expires_at: number;
}

export const EVENT_FIELDS = ["v", "id", "kind", "level", "label", "agent", "sent_at", "expires_at"] as const;
export const KINDS = ["done", "needs_input", "failed", "stopped", "test"] as const;
export type Kind = (typeof KINDS)[number];
export const LEVELS = ["alarm", "notify"] as const;
export type Level = (typeof LEVELS)[number];
export type Agent = "claude-code" | "codex" | "cli";

export const DEFAULT_TTL_MS = 30 * 60_000;
export const MAX_LABEL = 40;

/** The label is the project folder's name, reduced to plain characters: never a full path. */
export function labelFor(dir: string): string {
  // Split on both separators, so a Windows path is handled the same way on any platform.
  const name = (dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "")
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "")
    .slice(0, MAX_LABEL)
    .trim();
  return name || "project";
}

/**
 * The same agent, session, turn and kind always give the same ID, so a hook that fires twice for
 * one turn is one event to the phone. Without those parts, a random ID.
 */
export function eventId(parts?: readonly (string | undefined)[]): string {
  if (!parts || parts.some((part) => !part)) return randomUUID();
  const hex = createHash("sha256").update(parts.join("|")).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function buildEvent(args: {
  kind: Kind;
  level?: Level;
  label: string;
  agent: Agent;
  now: number;
  ttlMs?: number;
  idParts?: readonly (string | undefined)[];
}): AlarmEvent {
  return {
    v: 1,
    id: eventId(args.idParts),
    kind: args.kind,
    level: args.level ?? "alarm",
    label: args.label.slice(0, MAX_LABEL),
    agent: args.agent,
    sent_at: args.now,
    expires_at: args.now + (args.ttlMs ?? DEFAULT_TTL_MS),
  };
}

export function agentName(agent: Agent): string {
  return agent === "claude-code" ? "Claude Code" : agent === "codex" ? "Codex" : "Your task";
}
