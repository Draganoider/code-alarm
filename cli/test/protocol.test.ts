import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodeEvent } from "../src/deliver.js";
import { AGENTS, type AlarmEvent, EVENT_FIELDS, KINDS, LEVELS, buildEvent, labelFor } from "../src/events.js";

/**
 * The CLI's half of the contract in docs/protocol-examples.json. The relay checks the same file
 * from its side, so an event the CLI builds is one the relay accepts.
 */
interface Examples {
  now: number;
  valid: AlarmEvent[];
  invalid: { why: string; status: number; event: Record<string, unknown> }[];
}
const examples = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "protocol-examples.json"), "utf8"),
) as Examples;

// The protocol's rules, as docs/protocol.md states them.
const LABEL = /^[A-Za-z0-9._ -]{0,40}$/;
const ID = /^[A-Za-z0-9-]{8,64}$/;
const HOUR = 60 * 60_000;

function followsTheProtocol(event: Record<string, unknown>, now: number): boolean {
  const keys = Object.keys(event).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...EVENT_FIELDS].sort())) return false;
  const e = event as unknown as AlarmEvent;
  return (
    e.v === 1 &&
    typeof e.id === "string" && ID.test(e.id) &&
    KINDS.includes(e.kind) && LEVELS.includes(e.level) && AGENTS.includes(e.agent) &&
    typeof e.label === "string" && LABEL.test(e.label) &&
    Number.isSafeInteger(e.sent_at) && Number.isSafeInteger(e.expires_at) &&
    e.expires_at > e.sent_at && e.expires_at - e.sent_at <= HOUR &&
    e.sent_at <= now + 5 * 60_000 && e.expires_at > now
  );
}

test("the examples agree with the rules: every valid one passes, every invalid one fails", () => {
  assert.ok(examples.valid.length > 0 && examples.invalid.length > 0);
  for (const event of examples.valid) assert.ok(followsTheProtocol(event as unknown as Record<string, unknown>, examples.now), JSON.stringify(event));
  for (const { why, event } of examples.invalid) assert.ok(!followsTheProtocol(event, examples.now), why);
});

test("the detached sender accepts every valid example", () => {
  for (const event of examples.valid) {
    assert.ok(decodeEvent(Buffer.from(JSON.stringify(event)).toString("base64url")), JSON.stringify(event));
  }
});

test("every event the CLI builds follows the protocol, whatever the folder is called", () => {
  const folders = [
    "C:\Users\someone\secret-client\billing",
    "/home/someone/work/my-app/",
    "/x/naïve proj$ect (v2)",
    "/x/" + "a".repeat(100),
    "/",
    "C:\\",
    "/tmp/.hidden",
    "/x/日本語のプロジェクト",
    "/x/emoji 🚀 launch",
  ];
  const now = Date.now();
  for (const folder of folders) {
    for (const kind of KINDS) {
      for (const level of LEVELS) {
        for (const agent of AGENTS) {
          const event = buildEvent({ kind, level, label: labelFor(folder), agent, now, idParts: ["a", "s", "t", kind] });
          assert.ok(followsTheProtocol(event as unknown as Record<string, unknown>, now), `${folder} ${kind} ${level} ${agent}: ${JSON.stringify(event)}`);
        }
      }
    }
  }
  assert.ok(followsTheProtocol(buildEvent({ kind: "test", label: "test", agent: "cli", now }) as unknown as Record<string, unknown>, now));
});
