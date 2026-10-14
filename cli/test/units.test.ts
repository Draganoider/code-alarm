import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { configPath, isValidTopic, loadConfig, newTopic, saveConfig } from "../src/config.js";
import { decodeEvent } from "../src/deliver.js";
import { HOUR, MINUTE, formatDuration, parseDuration } from "../src/duration.js";
import { buildEvent } from "../src/events.js";
import { ntfyRequest, sendNtfy } from "../src/ntfy.js";
import { tempDir } from "./helpers.js";

test("durations", () => {
  assert.equal(parseDuration("2h"), 2 * HOUR);
  assert.equal(parseDuration("90m"), 90 * MINUTE);
  assert.equal(parseDuration("1h30m"), 90 * MINUTE);
  assert.equal(parseDuration("45s"), 45_000);
  for (const bad of ["", "h", "2", "2 h", "-1h", "0m", "1d"]) assert.equal(parseDuration(bad), null, bad);
  assert.equal(formatDuration(90 * MINUTE), "1h 30m");
  assert.equal(formatDuration(2 * HOUR), "2h");
  assert.equal(formatDuration(45_000), "45s");
});

test("config round-trips, and a new topic is long, random and valid", () => {
  const home = tempDir();
  const topic = newTopic();
  assert.match(topic, /^code-alarm-[a-z0-9]{24}$/);
  assert.notEqual(topic, newTopic());
  assert.ok(isValidTopic(topic));
  assert.ok(!isValidTopic("has space"));
  saveConfig(home, { version: 1, transport: "ntfy", ntfy: { server: "https://ntfy.sh", topic, token: "tk" } });
  assert.deepEqual(loadConfig(home), { version: 1, transport: "ntfy", ntfy: { server: "https://ntfy.sh", topic, token: "tk" } });
  if (process.platform !== "win32") assert.equal(statSync(configPath(home)).mode & 0o777, 0o600);
  assert.equal(loadConfig(join(home, "missing")), null);
});

test("the ntfy request: JSON to the server root, max priority, token only as a header", () => {
  const event = buildEvent({ kind: "needs_input", label: "my-app", agent: "codex", now: 0 });
  const { url, init } = ntfyRequest(event, { server: "https://ntfy.sh/", topic: "t1", token: "secret-token" });
  assert.equal(url, "https://ntfy.sh/");
  assert.equal(init.headers.authorization, "Bearer secret-token");
  const body = JSON.parse(init.body) as Record<string, unknown>;
  assert.equal(body.topic, "t1");
  assert.equal(body.priority, 5);
  assert.equal(body.title, "Needs you: my-app");
  assert.match(String(body.message), /^Codex /);
  assert.ok(!init.body.includes("secret-token"));
});

test("notify level is ntfy's default priority; alarm is max", () => {
  const cfg = { server: "https://ntfy.sh", topic: "t" };
  const priority = (level: "alarm" | "notify") =>
    (JSON.parse(ntfyRequest(buildEvent({ kind: "done", level, label: "a", agent: "cli", now: 0 }), cfg).init.body) as { priority: number }).priority;
  assert.equal(priority("alarm"), 5);
  assert.equal(priority("notify"), 3);
  assert.equal(buildEvent({ kind: "done", label: "a", agent: "cli", now: 0 }).level, "alarm");
});

test("sendNtfy reports failures instead of throwing", async () => {
  const event = buildEvent({ kind: "done", label: "a", agent: "cli", now: 0 });
  const cfg = { server: "https://ntfy.example", topic: "t" };
  const ok = await sendNtfy(event, cfg, (async () => new Response("", { status: 200 })) as typeof fetch);
  assert.deepEqual(ok, { ok: true, detail: "HTTP 200" });
  const refused = await sendNtfy(event, cfg, (async () => new Response("", { status: 403 })) as typeof fetch);
  assert.deepEqual(refused, { ok: false, detail: "HTTP 403" });
  const down = await sendNtfy(event, cfg, (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch);
  assert.equal(down.ok, false);
});

test("the detached sender only accepts a well-formed event with no extra fields", () => {
  const event = buildEvent({ kind: "done", label: "a", agent: "cli", now: 0 });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  assert.deepEqual(decodeEvent(encode(event)), event);
  assert.equal(decodeEvent(encode({ ...event, transcript: "x" })), null);
  assert.equal(decodeEvent(encode({ ...event, kind: "other" })), null);
  assert.equal(decodeEvent("not base64 json"), null);
});
