import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sendApp } from "./app.js";
import { loadConfig } from "./config.js";
import { type AlarmEvent, EVENT_FIELDS, KINDS } from "./events.js";
import { writeFileAtomic } from "./fsutil.js";
import { type SendResult, sendNtfy } from "./ntfy.js";

export const logPath = (home: string) => join(home, "log.txt");

/** A short local log for `code-alarm status`. Kinds, agents and labels only; never the topic or a token. */
export function logLine(home: string, line: string): void {
  try {
    mkdirSync(home, { recursive: true });
    const path = logPath(home);
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
    if (statSync(path).size > 64_000) {
      const lines = readFileSync(path, "utf8").trimEnd().split("\n");
      writeFileAtomic(path, lines.slice(-200).join("\n") + "\n");
    }
  } catch {
    // Logging must never break a hook.
  }
}

export function recentLog(home: string, count: number): string[] {
  try {
    return readFileSync(logPath(home), "utf8").trimEnd().split("\n").slice(-count);
  } catch {
    return [];
  }
}

/** Sends and waits for the answer: for `code-alarm test`, and inside the detached sender. */
export async function sendNow(home: string, event: AlarmEvent, fetchImpl?: typeof fetch): Promise<SendResult> {
  const config = loadConfig(home);
  if (!config) return { ok: false, detail: "not set up: run `code-alarm init` or `code-alarm pair`" };
  // One transport, never both: two would ring twice.
  const result =
    config.transport === "app" && config.app ? await sendApp(event, config.app, fetchImpl) : await sendNtfy(event, config.ntfy!, fetchImpl);
  logLine(home, `${event.kind}/${event.level} ${event.agent} "${event.label}" ${result.ok ? "sent" : "FAILED"} (${result.detail})`);
  if (result.ok && config.transport === "app") rememberLast(home, event);
  return result;
}

export interface LastEvent {
  id: string;
  kind: string;
  level: string;
  label: string;
  sentAt: number;
}

const lastPath = (home: string) => join(home, "last-event.json");

/** The last event sent through the app, for `status --last`. It stays on this computer. */
function rememberLast(home: string, event: AlarmEvent): void {
  try {
    const last: LastEvent = { id: event.id, kind: event.kind, level: event.level, label: event.label, sentAt: event.sent_at };
    writeFileAtomic(lastPath(home), JSON.stringify(last));
  } catch {
    // Only status --last needs it.
  }
}

export function lastEvent(home: string): LastEvent | null {
  try {
    const last = JSON.parse(readFileSync(lastPath(home), "utf8")) as Partial<LastEvent>;
    return typeof last.id === "string" && typeof last.sentAt === "number" ? (last as LastEvent) : null;
  } catch {
    return null;
  }
}

/**
 * Hands the send to a detached copy of this script and returns at once, so a slow or missing
 * network can never hold up the agent (hard rule 6).
 */
export function sendDetached(event: AlarmEvent, script: string | undefined = process.argv[1]): void {
  const payload = Buffer.from(JSON.stringify(event)).toString("base64url");
  runDetached(script, ["__send", payload]);
}

/**
 * Starts the waiter for a Codex approval request (hook.ts, firePending), detached the same way.
 * Codex lets a hook's detached helpers outlive it when the hook exits normally (docs/agents.md).
 */
export function waitDetached(id: string, at: number, script: string | undefined = process.argv[1]): void {
  runDetached(script, ["__wait", id, String(at)]);
}

function runDetached(script: string | undefined, args: string[]): void {
  if (!script) return;
  const child = spawn(process.execPath, [script, ...args], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

export function decodeEvent(arg: string): AlarmEvent | null {
  try {
    const event = JSON.parse(Buffer.from(arg, "base64url").toString("utf8")) as Record<string, unknown>;
    const keys = Object.keys(event);
    const allowed = new Set<string>(EVENT_FIELDS);
    if (keys.some((key) => !allowed.has(key))) return null;
    if (event.v !== 1 || typeof event.id !== "string" || typeof event.label !== "string") return null;
    if (!KINDS.includes(event.kind as AlarmEvent["kind"])) return null;
    if (typeof event.sent_at !== "number" || typeof event.expires_at !== "number") return null;
    return event as unknown as AlarmEvent;
  } catch {
    return null;
  }
}
