import assert from "node:assert/strict";
import { test } from "node:test";
import { HOUR } from "../src/duration.js";
import { EVENT_FIELDS, buildEvent, labelFor } from "../src/events.js";
import { runHook } from "../src/hook.js";
import { ntfyRequest } from "../src/ntfy.js";
import { armProject } from "../src/state.js";
import { payload, setup } from "./helpers.js";

/**
 * Hard rule 3: no agent content ever leaves the computer. The hook payload in these tests carries a
 * transcript path, the last assistant message and the prompt; none of it may reach an event or
 * the request that sends it.
 */
const SECRETS = ["transcript", "sk-live-123", "billing module", "C:/Users/someone", "secret"];

test("an event has exactly the protocol's fields", async () => {
  const { home, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  await runHook("claude", payload("Stop", { cwd: project }), deps());
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]!).sort(), [...EVENT_FIELDS].sort());
});

test("nothing from the hook payload reaches the event or the ntfy request", async () => {
  const { home, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  await runHook("claude", payload("Stop", { cwd: project }), deps());
  const event = JSON.stringify(sent[0]);
  const request = JSON.stringify(ntfyRequest(sent[0]!, { server: "https://ntfy.example", topic: "t" }));
  for (const secret of SECRETS) {
    assert.ok(!event.includes(secret), `event leaks ${secret}`);
    assert.ok(!request.includes(secret), `request leaks ${secret}`);
  }
});

test("the label is only the folder's name, never a path", () => {
  assert.equal(labelFor("C:\\Users\\someone\\secret-client\\billing"), "billing");
  assert.equal(labelFor("/home/someone/work/my-app/"), "my-app");
  assert.equal(labelFor("/"), "project");
  assert.equal(labelFor("/x/" + "a".repeat(100)).length, 40);
  assert.equal(labelFor("/x/naïve proj$ect (v2)"), "na-ve proj-ect -v2");
});

test("buildEvent keeps the label short even when given a long one", () => {
  const event = buildEvent({ kind: "done", label: "x".repeat(200), agent: "cli", now: 0 });
  assert.equal(event.label.length, 40);
  assert.equal(event.expires_at - event.sent_at, 30 * 60_000);
});
