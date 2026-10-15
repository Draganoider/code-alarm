import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { appRequest, defaultName, describeDelivery, fetchDelivery, pairWithPhone, relayUrl, sendApp, unpairFromPhone } from "../src/app.js";
import { type AppConfig, ConfigError, configPath, loadConfig, saveConfig } from "../src/config.js";
import { lastEvent, sendNow } from "../src/deliver.js";
import { buildEvent } from "../src/events.js";
import { tempDir } from "./helpers.js";

const APP: AppConfig = {
  relay: "https://relay.example",
  deviceId: "d_phone",
  senderId: "s_computer",
  token: "cas_secret-token",
  name: "Windows PC",
  pairedAt: 1,
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch that records each call and answers from a list, in order. A thrown Error stands for a network failure. */
function fakeFetch(...answers: (Response | Error)[]) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body === undefined ? undefined : String(init.body),
    });
    const answer = answers.shift() ?? new Response(null, { status: 500 });
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const event = () => buildEvent({ kind: "done", label: "my-project", agent: "claude-code", now: Date.now() });

test("the relay must be HTTPS, except on this computer", () => {
  assert.equal(relayUrl("https://relay.example/"), "https://relay.example");
  assert.equal(relayUrl("https://relay.example/base/"), "https://relay.example/base");
  assert.equal(relayUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(relayUrl(undefined, { CODE_ALARM_RELAY: "https://from-env.example" }), "https://from-env.example");
  for (const bad of ["http://relay.example", "ftp://relay.example", "https://relay.example/?x=1", "https://user:pw@relay.example", "nonsense"]) {
    assert.throws(() => relayUrl(bad), ConfigError, bad);
  }
  assert.equal(relayUrl(undefined, {}), "https://relay.codealarm.workers.dev");
  assert.equal(relayUrl(undefined, { CODE_ALARM_RELAY: "" }), "https://relay.codealarm.workers.dev");
});

test("the default computer name is generic, never the hostname", () => {
  assert.equal(defaultName("win32"), "Windows PC");
  assert.equal(defaultName("darwin"), "Mac");
  assert.equal(defaultName("linux"), "Linux computer");
  assert.equal(defaultName("aix"), "Computer");
});

test("pairing returns the pairing to save, or the relay's own message", async () => {
  const ok = fakeFetch(json(201, { sender_id: "s_1", token: "cas_t", device_id: "d_1", name: "Desk" }));
  const paired = await pairWithPhone("https://relay.example", "K7Q-4MZ", "Desk", 5, ok.impl);
  assert.deepEqual(paired, { ok: true, app: { relay: "https://relay.example", deviceId: "d_1", senderId: "s_1", token: "cas_t", name: "Desk", pairedAt: 5 } });
  assert.equal(ok.calls[0]!.url, "https://relay.example/v1/pair");
  assert.deepEqual(JSON.parse(ok.calls[0]!.body!), { code: "K7Q-4MZ", name: "Desk" });

  const wrong = fakeFetch(json(404, { error: "invalid_code", message: "That code is wrong or has expired." }));
  assert.deepEqual(await pairWithPhone("https://relay.example", "AAA-AAA", "Desk", 5, wrong.impl), { ok: false, message: "That code is wrong or has expired." });

  const offline = fakeFetch(new TypeError("fetch failed"));
  const result = await pairWithPhone("https://relay.example", "AAA-AAA", "Desk", 5, offline.impl);
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /couldn't reach the relay/);
});

test("the event request: the event as the body, the token only as a header", () => {
  const e = event();
  const { url, init } = appRequest(e, APP);
  assert.equal(url, "https://relay.example/v1/events");
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, { authorization: "Bearer cas_secret-token", "content-type": "application/json" });
  assert.deepEqual(JSON.parse(init.body!), e);
});

test("sendApp: sent, already sent, and rate-limited are all fine", async () => {
  const cases: [Response, string][] = [
    [json(200, { status: "sent", id: "x", level: "alarm" }), "app: sent"],
    [json(200, { status: "duplicate", id: "x" }), "app: already sent"],
    [json(200, { status: "sent", id: "x", level: "notify", limited: true }), "app: sent as a notification (rate limit)"],
  ];
  for (const [answer, detail] of cases) {
    const fake = fakeFetch(answer);
    assert.deepEqual(await sendApp(event(), APP, fake.impl, { retryDelayMs: 0 }), { ok: true, detail });
  }
});

test("sendApp retries a failed push or a network error once, with the same event", async () => {
  const e = event();
  const pushFailed = fakeFetch(json(502, { status: "failed", error: "push_failed" }), json(200, { status: "sent" }));
  assert.deepEqual(await sendApp(e, APP, pushFailed.impl, { retryDelayMs: 0 }), { ok: true, detail: "app: sent" });
  assert.equal(pushFailed.calls.length, 2);
  assert.equal(pushFailed.calls[0]!.body, pushFailed.calls[1]!.body);

  const offline = fakeFetch(new TypeError("fetch failed"), new TypeError("fetch failed"));
  const result = await sendApp(e, APP, offline.impl, { retryDelayMs: 0 });
  assert.equal(result.ok, false);
  assert.match(result.detail, /relay unreachable/);
  assert.equal(offline.calls.length, 2);
});

test("sendApp doesn't retry what a retry can't fix", async () => {
  for (const [answer, detail] of [
    [json(401, { error: "unauthorized" }), /isn't paired any more/],
    [json(410, { error: "expired" }), /app: expired/],
    [json(400, { error: "invalid_event" }), /app: invalid_event/],
    [json(429, { error: "rate_limited" }), /app: rate_limited/],
    [json(503, { error: "phone_unreachable" }), /app: phone_unreachable/],
  ] as const) {
    const fake = fakeFetch(answer);
    const result = await sendApp(event(), APP, fake.impl, { retryDelayMs: 0 });
    assert.equal(result.ok, false);
    assert.match(result.detail, detail);
    assert.equal(fake.calls.length, 1);
    assert.ok(!result.detail.includes(APP.token));
  }
});

test("unpairing: removed, already gone, or couldn't tell the relay", async () => {
  const removed = fakeFetch(new Response(null, { status: 204 }));
  assert.deepEqual(await unpairFromPhone(APP, removed.impl), { ok: true, detail: "removed" });
  assert.equal(removed.calls[0]!.method, "DELETE");
  assert.equal(removed.calls[0]!.url, "https://relay.example/v1/senders/s_computer");
  assert.equal((await unpairFromPhone(APP, fakeFetch(json(401, {})).impl)).ok, true);
  assert.equal((await unpairFromPhone(APP, fakeFetch(json(500, {})).impl)).ok, false);
});

test("delivery status, in words", async () => {
  const fake = fakeFetch(json(200, { status: "stopped", sent_at: 1000, ringing_at: 1400, ended_at: 13_400 }));
  const result = await fetchDelivery(APP, "evt-1", fake.impl);
  assert.equal(fake.calls[0]!.url, "https://relay.example/v1/events/evt-1");
  assert.ok(result.ok);
  assert.equal(describeDelivery(result.delivery), "rang 0.4 s after the alert was sent, stopped after 12.0 s");
  assert.match(describeDelivery({ status: "sent", sent_at: 0 }), /hasn't answered yet/);
  assert.match(describeDelivery({ status: "failed", sent_at: 0, detail: "FCM 503" }), /not delivered: FCM 503/);
  assert.match(describeDelivery({ status: "expired", sent_at: 0 }), /stayed silent/);
  assert.match(describeDelivery({ status: "notified", sent_at: 0, ringing_at: 2000 }), /notification, 2.0 s after/);
  const missing = await fetchDelivery(APP, "evt-2", fakeFetch(json(404, { error: "not_found" })).impl);
  assert.deepEqual(missing, { ok: false, message: "the relay has no record of it (it keeps a week)" });
});

test("sendNow uses the app when paired, never ntfy as well, and remembers the event", async () => {
  const home = tempDir();
  saveConfig(home, { version: 1, transport: "app", app: APP, ntfy: { server: "https://ntfy.example", topic: "t" } });
  const fake = fakeFetch(json(200, { status: "sent" }));
  const e = event();
  assert.deepEqual(await sendNow(home, e, fake.impl), { ok: true, detail: "app: sent" });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.url, "https://relay.example/v1/events");
  assert.deepEqual(lastEvent(home), { id: e.id, kind: "done", level: "alarm", label: "my-project", sentAt: e.sent_at });
  const log = readFileSync(join(home, "log.txt"), "utf8");
  assert.match(log, /done\/alarm claude-code "my-project" sent \(app: sent\)/);
  assert.ok(!log.includes(APP.token));
});

test("config: an app pairing round-trips next to ntfy, and a half-written one is refused", () => {
  const home = tempDir();
  saveConfig(home, { version: 1, transport: "app", app: APP });
  assert.deepEqual(loadConfig(home), { version: 1, transport: "app", app: APP });
  saveConfig(home, { version: 1, transport: "ntfy", ntfy: { server: "https://ntfy.sh", topic: "t" }, app: APP });
  assert.deepEqual(loadConfig(home)?.app, APP);
  saveConfig(home, { version: 1, transport: "app" } as never);
  assert.throws(() => loadConfig(home), /missing its pairing settings/);
  assert.ok(existsSync(configPath(home)));
});
