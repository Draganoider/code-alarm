import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultName } from "../src/app.js";
import { tempDir } from "./helpers.js";

const MAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.js");
const TOKEN = "cas_fake-relay-token";

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

/** A stand-in for the relay: just enough of its API (docs/protocol.md) to drive the commands. */
const seen: Seen[] = [];
let relay = "";
const server = createServer(async (req: IncomingMessage, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  seen.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, body });
  const reply = (status: number, data?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(data === undefined ? "" : JSON.stringify(data));
  };
  const authed = req.headers.authorization === `Bearer ${TOKEN}`;
  if (req.method === "POST" && req.url === "/v1/pair") {
    if (body.code !== "K7Q-4MZ") return reply(404, { error: "invalid_code", message: "That code is wrong or has expired." });
    return reply(201, { sender_id: "s_1", token: TOKEN, device_id: "d_1", name: body.name });
  }
  if (req.method === "POST" && req.url === "/v1/events" && authed) return reply(200, { status: "sent", id: body.id, level: body.level });
  if (req.method === "GET" && req.url?.startsWith("/v1/events/") && authed) {
    return reply(200, { status: "stopped", sent_at: 1000, ringing_at: 1500, ended_at: 4500 });
  }
  if (req.method === "DELETE" && req.url === "/v1/senders/s_1" && authed) return reply(204);
  reply(401, { error: "unauthorized" });
});

before(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  relay = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
});

/** Runs the CLI without blocking, so the fake relay in this process can answer it. */
function run(args: string[], home: string, env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env: { ...process.env, CODE_ALARM_HOME: home, CODE_ALARM_RELAY: "", ...env } });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stdout += chunk));
    child.on("close", (status) => done({ status, stdout }));
  });
}

test("pair, test, status --last, use and unpair against a relay", async () => {
  const home = tempDir();
  assert.equal((await run(["init", "--topic", "code-alarm-test-topic"], home)).status, 0);

  const paired = await run(["pair", "K7Q-4MZ", "--relay", relay], home);
  assert.equal(paired.status, 0, paired.stdout);
  assert.match(paired.stdout, new RegExp(`lists this computer as "${defaultName()}"`));
  assert.match(paired.stdout, /ntfy settings are kept/);
  assert.deepEqual(seen.at(-1)?.body, { code: "K7Q-4MZ", name: defaultName() });
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(config.transport, "app");
  assert.equal(config.ntfy.topic, "code-alarm-test-topic");

  const status = await run(["status"], home);
  assert.match(status.stdout, /Transport: Code Alarm app, paired as ".+" through http:\/\/127\.0\.0\.1:\d+ \(ntfy is set up too\)/);
  assert.ok(!status.stdout.includes(TOKEN), "status never shows the token");

  const sent = await run(["test"], home);
  assert.equal(sent.status, 0, sent.stdout);
  const post = seen.at(-1)!;
  assert.equal(post.path, "/v1/events");
  assert.equal(post.auth, `Bearer ${TOKEN}`);
  assert.deepEqual(Object.keys(post.body as object).sort(), ["agent", "expires_at", "id", "kind", "label", "level", "sent_at", "v"]);

  const last = await run(["status", "--last"], home);
  assert.match(last.stdout, /Last alert: test\/alarm "test" at \d\d:\d\d: rang 0\.5 s after the alert was sent, stopped after 3\.0 s/);
  assert.equal(seen.at(-1)?.path, `/v1/events/${(post.body as { id: string }).id}`);

  assert.match((await run(["use", "ntfy"], home)).stdout, /through ntfy/);
  assert.match((await run(["status", "--last"], home)).stdout, /--last needs the Code Alarm app/);
  assert.match((await run(["use", "app"], home)).stdout, /through the Code Alarm app/);

  const unpaired = await run(["unpair"], home);
  assert.match(unpaired.stdout, /Unpaired: the phone no longer lists this computer/);
  assert.equal(seen.at(-1)?.method, "DELETE");
  const after = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(after.transport, "ntfy");
  assert.equal(after.app, undefined);
});

test("pair refuses a wrong code, and needs a relay address while the relay isn't public", async () => {
  const home = tempDir();
  const wrong = await run(["pair", "AAA-AAA", "--relay", relay], home);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /Couldn't pair: That code is wrong or has expired/);
  const noRelay = await run(["pair", "K7Q-4MZ"], home);
  assert.equal(noRelay.status, 1);
  assert.match(noRelay.stdout, /isn't public yet/);
  assert.equal((await run(["pair", "K7Q-4MZ", "--relay", "http://relay.example"], home)).status, 1);
});
