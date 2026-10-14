import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
  if (!config) return { ok: false, detail: "not set up: run `code-alarm init`" };
  const result = await sendNtfy(event, config.ntfy, fetchImpl);
  logLine(home, `${event.kind} ${event.agent} "${event.label}" ${result.ok ? "sent" : "FAILED"} (${result.detail})`);
  return result;
}

/**
 * Hands the send to a detached copy of this script and returns at once, so a slow or missing
 * network can never hold up the agent (hard rule 6).
 */
export function sendDetached(event: AlarmEvent, script: string | undefined = process.argv[1]): void {
  if (!script) return;
  const payload = Buffer.from(JSON.stringify(event)).toString("base64url");
  const child = spawn(process.execPath, [script, "__send", payload], { detached: true, stdio: "ignore", windowsHide: true });
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
