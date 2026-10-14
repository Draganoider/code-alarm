import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config.js";
import type { AlarmEvent } from "../src/events.js";
import type { Deps } from "../src/hook.js";

export function tempDir(prefix = "code-alarm-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A configured code-alarm home, a project folder, and deps that record what would be sent. */
export function setup(now = 1_760_400_000_000) {
  const root = tempDir();
  const home = join(root, "home");
  const project = join(root, "work", "my-project");
  mkdirSync(join(project, "src"), { recursive: true });
  saveConfig(home, { version: 1, transport: "ntfy", ntfy: { server: "https://ntfy.example", topic: "code-alarm-testtopic" } });
  const sent: AlarmEvent[] = [];
  const clock = { now };
  const deps = (cwd: string = project): Deps => ({ home, now: () => clock.now, send: (event) => void sent.push(event), cwd: () => cwd });
  return { root, home, project, sent, clock, deps };
}

/** A hook payload the way the agents send it, including fields that must never leave the computer. */
export function payload(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: event,
    session_id: "sess-1",
    prompt_id: "prompt-1",
    transcript_path: "C:/Users/someone/.claude/projects/secret/transcript.jsonl",
    last_assistant_message: "Here is the API key you asked for: sk-live-123",
    prompt: "refactor the billing module",
    ...extra,
  });
}
