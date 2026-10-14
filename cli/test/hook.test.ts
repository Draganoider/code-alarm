import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { HOUR } from "../src/duration.js";
import { NEEDS_INPUT_WINDOW_MS, runHook, runSignal } from "../src/hook.js";
import { armNap, armProject, findArming } from "../src/state.js";
import { payload, setup } from "./helpers.js";

test("an unarmed session never sends anything (DR-003)", async () => {
  const { project, sent, deps } = setup();
  for (const event of ["Stop", "StopFailure", "Notification", "UserPromptSubmit"]) {
    await runHook("claude", payload(event, { cwd: project }), deps());
  }
  await runHook("codex", payload("PermissionRequest", { cwd: project }), deps());
  assert.equal(sent.length, 0);
});

test("Stop in an armed project sends 'stopped' once, then the arming is used up", async () => {
  const { home, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  await runHook("claude", payload("Stop", { cwd: project }), deps());
  assert.deepEqual(sent.map((e) => e.kind), ["stopped"]);
  await runHook("claude", payload("Stop", { cwd: project }), deps());
  assert.equal(sent.length, 1, "a project arming is one-shot");
});

test("arming covers subfolders; a session elsewhere stays silent", async () => {
  const { home, root, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  await runHook("claude", payload("Stop", { cwd: join(root, "work", "other") }), deps());
  assert.equal(sent.length, 0);
  await runHook("claude", payload("Stop", { cwd: join(project, "src") }), deps());
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.label, "my-project");
});

test("an expired arming sends nothing", async () => {
  const { home, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + 1000, clock.now);
  clock.now += 2000;
  await runHook("claude", payload("Stop", { cwd: project }), deps());
  assert.equal(sent.length, 0);
});

test("explicit done: one alarm, and the Stop that follows adds nothing", async () => {
  const { home, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  const result = await runSignal("done", "claude-code", deps());
  assert.equal(result.sent, true);
  await runHook("claude", payload("Stop", { cwd: project }), deps());
  assert.deepEqual(sent.map((e) => e.kind), ["done"]);
});

test("explicit needs-you: the Stop right after it is skipped, but the arming stays for later", async () => {
  const { home, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  await runSignal("needs_input", "claude-code", deps());
  await runHook("claude", payload("Stop", { cwd: project }), deps());
  assert.deepEqual(sent.map((e) => e.kind), ["needs_input"]);
  // The user answers; the next turn ends without a signal, so the fallback rings.
  await runHook("claude", payload("UserPromptSubmit", { cwd: project }), deps());
  await runHook("claude", payload("Stop", { cwd: project, prompt_id: "prompt-2" }), deps());
  assert.deepEqual(sent.map((e) => e.kind), ["needs_input", "stopped"]);
});

test("a signal when nothing is armed sends nothing", async () => {
  const { sent, deps } = setup();
  const result = await runSignal("done", "codex", deps());
  assert.equal(result.sent, false);
  assert.equal(sent.length, 0);
});

test("permission prompts ring needs_input, at most once per window, without using up the arming", async () => {
  const { home, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  await runHook("claude", payload("Notification", { cwd: project, notification_type: "permission_prompt" }), deps());
  await runHook("claude", payload("Notification", { cwd: project, notification_type: "permission_prompt" }), deps());
  assert.deepEqual(sent.map((e) => e.kind), ["needs_input"]);
  clock.now += NEEDS_INPUT_WINDOW_MS + 1;
  await runHook("codex", payload("PermissionRequest", { cwd: project }), deps());
  assert.deepEqual(sent.map((e) => e.kind), ["needs_input", "needs_input"]);
  assert.ok(findArming(home, project, clock.now), "still armed");
});

test("other notification types (idle, auth...) ring nothing", async () => {
  const { home, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  await runHook("claude", payload("Notification", { cwd: project, notification_type: "idle_prompt" }), deps());
  assert.equal(sent.length, 0);
});

test("StopFailure rings failed", async () => {
  const { home, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  await runHook("claude", payload("StopFailure", { cwd: project }), deps());
  assert.deepEqual(sent.map((e) => e.kind), ["failed"]);
});

test("nap mode rings for any folder and isn't used up by a Stop", async () => {
  const { home, root, sent, clock, deps } = setup();
  armNap(home, clock.now + HOUR, clock.now);
  await runHook("codex", payload("Stop", { cwd: join(root, "anywhere"), turn_id: "t1" }), deps());
  await runHook("codex", payload("Stop", { cwd: join(root, "elsewhere"), turn_id: "t2" }), deps());
  assert.deepEqual(sent.map((e) => [e.kind, e.agent]), [["stopped", "codex"], ["stopped", "codex"]]);
});

test("the same session, turn and kind give the same event ID", async () => {
  const a = setup();
  const b = setup();
  armProject(a.home, a.project, a.clock.now + HOUR, a.clock.now);
  armProject(b.home, b.project, b.clock.now + HOUR, b.clock.now);
  await runHook("claude", payload("Stop", { cwd: a.project }), a.deps());
  await runHook("claude", payload("Stop", { cwd: b.project }), b.deps());
  assert.equal(a.sent[0]!.id, b.sent[0]!.id);
});

test("garbage input never throws", async () => {
  const { deps } = setup();
  for (const raw of ["", "not json", "[]", "null", '{"hook_event_name": 42}', '{"cwd": "/x"}']) {
    assert.equal(typeof (await runHook("claude", raw, deps())), "string");
  }
});
