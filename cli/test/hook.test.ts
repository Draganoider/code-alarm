import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HOUR } from "../src/duration.js";
import { NEEDS_INPUT_WINDOW_MS, PENDING_WAIT_MS, firePending, ownCommand, runHook, runSignal, sessionFromEnv } from "../src/hook.js";
import { armNap, armProject, claim, disarmProject, findArming } from "../src/state.js";
import { payload, setup } from "./helpers.js";

const own = (command?: string) => ownCommand(command, process.cwd())?.sub ?? null;

test("an unarmed session never sends anything (DR-003)", async () => {
  const { project, sent, waiters, deps } = setup();
  for (const event of ["Stop", "StopFailure", "PermissionRequest", "UserPromptSubmit"]) {
    await runHook("claude", payload(event, { cwd: project }), deps());
  }
  await runHook("codex", payload("PermissionRequest", { cwd: project, tool_input: { command: "rm -rf build" } }), deps());
  assert.equal(sent.length, 0);
  assert.equal(waiters.length, 0, "nothing to wait for either");
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

test("Claude Code permission prompts ring needs_input at once, at most once per window, without using up the arming", async () => {
  const { home, project, sent, waiters, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  const ask = () => runHook("claude", payload("PermissionRequest", { cwd: project, tool_input: { command: "rm -rf build" } }), deps());
  await ask();
  await ask();
  assert.deepEqual(sent.map((e) => e.kind), ["needs_input"]);
  clock.now += NEEDS_INPUT_WINDOW_MS + 1;
  await ask();
  assert.deepEqual(sent.map((e) => e.kind), ["needs_input", "needs_input"]);
  assert.equal(waiters.length, 0, "Claude Code asks the user when it fires, so there's nothing to wait for");
  assert.ok(findArming(home, project, clock.now), "still armed");
});

/** A Codex session asking to run `command`, then what the waiter does PENDING_WAIT_MS later. */
function codexSession(s: ReturnType<typeof setup>, session = "codex-1") {
  const request = (command: string, extra: Record<string, unknown> = {}) =>
    runHook("codex", payload("PermissionRequest", { cwd: s.project, session_id: session, turn_id: "t1", tool_input: { command, ...extra } }), s.deps());
  const ran = (command: string) =>
    runHook("codex", payload("PostToolUse", { cwd: s.project, session_id: session, turn_id: "t1", tool_input: { command }, tool_response: "ok" }), s.deps());
  const fire = async (waiter = s.waiters.at(-1)!) => {
    s.clock.now = Math.max(s.clock.now, waiter.at + PENDING_WAIT_MS);
    return firePending(waiter.id, waiter.at, s.deps());
  };
  return { request, ran, fire };
}

test("Codex: a request auto-review approved (the tool ran) rings nothing", async () => {
  const s = setup();
  armProject(s.home, s.project, s.clock.now + HOUR, s.clock.now);
  const codex = codexSession(s);
  // The request carries the reason for the escalation; the tool run carries only the command.
  await codex.request("npm install", { description: "network access to install dependencies" });
  assert.equal(s.sent.length, 0, "nothing at once");
  assert.equal(s.waiters.length, 1);
  s.clock.now += 1500;
  assert.match(await codex.ran("npm install"), /answered/);
  assert.equal(await codex.fire(), "");
  assert.equal(s.sent.length, 0);
  assert.ok(findArming(s.home, s.project, s.clock.now), "still armed");
});

test("Codex: a request still unanswered after the wait rings needs_input once", async () => {
  const s = setup();
  armProject(s.home, s.project, s.clock.now + HOUR, s.clock.now);
  const codex = codexSession(s);
  await codex.request("git push");
  assert.match(await codex.fire(), /needs_input queued/);
  assert.deepEqual(s.sent.map((e) => [e.kind, e.agent]), [["needs_input", "codex"]]);
  assert.equal(await codex.fire(), "", "the same waiter twice sends once");
  // The user approves later and the tool runs: that's not another alert.
  await codex.ran("git push");
  assert.equal(s.sent.length, 1);
  assert.ok(findArming(s.home, s.project, s.clock.now), "needs_input doesn't use up the arming");
});

test("Codex: another command's run, or another session's, doesn't answer a request", async () => {
  const s = setup();
  armProject(s.home, s.project, s.clock.now + HOUR, s.clock.now);
  const codex = codexSession(s);
  await codex.request("git push");
  await codex.ran("npm test"); // a parallel call finishing while the request waits
  await codexSession(s, "codex-2").ran("git push");
  await codex.fire();
  assert.deepEqual(s.sent.map((e) => e.kind), ["needs_input"]);
});

test("Codex: the turn ending, or a new prompt, ends the wait", async () => {
  for (const event of ["Stop", "UserPromptSubmit"]) {
    const s = setup();
    armNap(s.home, s.clock.now + HOUR, s.clock.now);
    const codex = codexSession(s);
    await codex.request("git push");
    await runHook("codex", payload(event, { cwd: s.project, session_id: "codex-1", turn_id: "t1" }), s.deps());
    await codex.fire();
    assert.ok(!s.sent.some((e) => e.kind === "needs_input"), event);
  }
});

test("Codex: a request asked again waits afresh; only the newest waiter decides", async () => {
  const s = setup();
  armProject(s.home, s.project, s.clock.now + HOUR, s.clock.now);
  const codex = codexSession(s);
  await codex.request("git push");
  s.clock.now += 10_000;
  await codex.request("git push");
  const [first, second] = s.waiters;
  assert.equal(await codex.fire(first), "", "the first waiter leaves it to the second");
  assert.equal(s.sent.length, 0);
  await codex.fire(second);
  assert.deepEqual(s.sent.map((e) => e.kind), ["needs_input"]);
});

test("Codex: unanswered requests share Claude Code's limit of one needs_input per window", async () => {
  const s = setup();
  armProject(s.home, s.project, s.clock.now + HOUR, s.clock.now);
  const codex = codexSession(s);
  await codex.request("git push");
  await codex.request("git push --tags");
  for (const waiter of [...s.waiters]) await codex.fire(waiter);
  assert.deepEqual(s.sent.map((e) => e.kind), ["needs_input"]);
});

test("Codex: disarmed while the request waits, nothing is sent", async () => {
  const s = setup();
  armProject(s.home, s.project, s.clock.now + HOUR, s.clock.now);
  const codex = codexSession(s);
  await codex.request("git push");
  disarmProject(s.home, s.project);
  await codex.fire();
  assert.equal(s.sent.length, 0);
});

test("Codex: if the request can't be recorded, needs_input is sent at once", async () => {
  const s = setup();
  armProject(s.home, s.project, s.clock.now + HOUR, s.clock.now);
  writeFileSync(join(s.home, "pending"), "a file where the folder should be");
  await codexSession(s).request("git push");
  assert.deepEqual(s.sent.map((e) => e.kind), ["needs_input"]);
  assert.equal(s.waiters.length, 0);
});

test("a tool run with no request waiting logs nothing, and Claude Code's PostToolUse does nothing", async () => {
  const s = setup();
  armProject(s.home, s.project, s.clock.now + HOUR, s.clock.now);
  assert.equal(await codexSession(s).ran("ls"), "");
  assert.equal(await runHook("claude", payload("PostToolUse", { cwd: s.project, tool_input: { command: "ls" } }), s.deps()), "");
  assert.equal(s.sent.length, 0);
});

test("Notification events ring nothing (permission prompts come from PermissionRequest)", async () => {
  const { home, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  for (const type of ["permission_prompt", "idle_prompt"]) {
    await runHook("claude", payload("Notification", { cwd: project, notification_type: type }), deps());
  }
  assert.equal(sent.length, 0);
});

test("approving code-alarm's own done IS the done signal; the command itself then adds nothing", async () => {
  const { home, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  const cli = 'node "C:/Users/me/AppData/Roaming/code-alarm/bin/code-alarm.mjs"';
  await runHook("codex", payload("PermissionRequest", { cwd: project, tool_input: { command: `${cli} done` } }), deps());
  assert.deepEqual(sent.map((e) => e.kind), ["done"], "done, not needs_input");
  const later = await runSignal("done", "codex", deps());
  assert.equal(later.sent, false);
  await runHook("codex", payload("Stop", { cwd: project }), deps());
  assert.equal(sent.length, 1);
});

test("approving code-alarm's own arm or status rings nothing", async () => {
  const { home, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  for (const command of ["code-alarm arm --notify", "code-alarm status", "cd x && code-alarm disarm"]) {
    await runHook("claude", payload("PermissionRequest", { cwd: project, tool_input: { command } }), deps());
  }
  assert.equal(sent.length, 0);
});

test("needs-you twice in a turn rings once", async () => {
  const { home, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  await runSignal("needs_input", "claude-code", deps());
  const again = await runSignal("needs_input", "claude-code", deps());
  assert.equal(again.sent, false);
  assert.equal(sent.length, 1);
});

test("a notify arming sends notify-level events", async () => {
  const { home, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now, "notify");
  await runHook("claude", payload("Stop", { cwd: project }), deps());
  assert.deepEqual(sent.map((e) => [e.kind, e.level]), [["stopped", "notify"]]);
});

test("recognising code-alarm's own commands", () => {
  assert.equal(own("code-alarm done"), "done");
  assert.equal(own('node "C:/Users/a b/AppData/Roaming/code-alarm/bin/code-alarm.mjs" needs-you'), "needs-you");
  assert.equal(own("C:\\x\\code-alarm.cmd failed"), "failed");
  assert.equal(own("cd /work && code-alarm arm --for 2h"), "arm");
  assert.equal(own("npm install code-alarm"), null);
  assert.equal(own("rm -rf /code-alarm/done"), null);
  assert.equal(own("my-code-alarm done"), null);
  assert.equal(own(undefined), null);
  // Codex on Windows runs everything through PowerShell; the hook may see the wrapper.
  const wrapped = String.raw`"C:\Users\me\.cache\codex-runtimes\pwsh.exe" -Command "node \"C:/Users/me/AppData/Roaming/code-alarm/bin/code-alarm.mjs\" done"`;
  assert.equal(own(wrapped), "done");
  assert.equal(own(`bash -lc 'code-alarm needs-you'`), "needs-you");
  assert.equal(own("code-alarm done;"), "done");
  assert.equal(own("code-alarm done 2>&1"), "done");
  assert.equal(own(`& "C:\\Users\\me\\code-alarm.cmd" failed`), "failed");
  assert.equal(own("npx -y code-alarm status"), "status");
});

test("text that only mentions code-alarm isn't code-alarm's own command", () => {
  assert.equal(own("echo code-alarm done"), null);
  assert.equal(own(`git commit -m "make code-alarm done faster"`), null);
  assert.equal(own(`echo 'a; code-alarm done now'`), null);
  assert.equal(own(`pwsh -Command "Write-Output 'code-alarm done'"`), null);
  // Our command chained with something else: the approval is about the other command too.
  assert.equal(own("npm test && code-alarm done"), null);
  assert.equal(own("cd /work"), null);
  // Code run inside an argument, which the parser can't follow.
  assert.equal(own(`Set-Location "$(python prepare.py)"; code-alarm status`), null);
  assert.equal(own("cd `make-dir`; code-alarm done"), null);
  assert.equal(own("cd $HOME && code-alarm done"), null);
  // A cd inside a subshell doesn't move the next command; brackets aren't followed at all.
  assert.equal(own("(cd ../b); code-alarm done"), null);
});

test("a signal wins over a silent code-alarm command next to it", () => {
  assert.equal(own("code-alarm status; code-alarm done"), "done");
  assert.equal(own("code-alarm needs-you && code-alarm status"), "needs-you");
});

test("a cd before code-alarm's own command is followed", () => {
  const { root } = setup();
  assert.deepEqual(ownCommand(`cd ${JSON.stringify(join(root, "b"))} && code-alarm done`, join(root, "a")), { sub: "done", cwd: join(root, "b") });
  assert.deepEqual(ownCommand("cd sub; code-alarm done", join(root, "a")), { sub: "done", cwd: join(root, "a", "sub") });
  assert.deepEqual(ownCommand("cd RUNNER~1 && code-alarm done", root)?.cwd, join(root, "RUNNER~1"));
  assert.equal(ownCommand("cd ~/b && code-alarm done", root), null);
});

test("an approved `cd B && code-alarm done` signals B, not the folder the agent started in", async () => {
  const { home, root, sent, clock, deps } = setup();
  const a = join(root, "a");
  const b = join(root, "b");
  armProject(home, a, clock.now + HOUR, clock.now);
  armProject(home, b, clock.now + HOUR, clock.now);
  const command = `cd ${JSON.stringify(b)} && code-alarm done`;
  await runHook("claude", payload("PermissionRequest", { cwd: a, tool_input: { command } }), deps(a));
  assert.deepEqual(sent.map((e) => [e.kind, e.label]), [["done", "b"]]);
  assert.ok(findArming(home, a, clock.now)?.dir === a, "A is still armed");
});

test("approving a command that only mentions code-alarm is a normal needs_input", async () => {
  const { home, project, sent, waiters, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  const command = `git commit -m "code-alarm done: tidy up"`;
  await runHook("claude", payload("PermissionRequest", { cwd: project, tool_input: { command } }), deps());
  assert.deepEqual(sent.map((e) => e.kind), ["needs_input"]);
  // In Codex too, once the request has gone unanswered.
  await runHook("codex", payload("PermissionRequest", { cwd: project, session_id: "codex-1", tool_input: { command } }), deps());
  clock.now += NEEDS_INPUT_WINDOW_MS + 1;
  await firePending(waiters[0]!.id, waiters[0]!.at, deps());
  assert.deepEqual(sent.map((e) => [e.kind, e.agent]), [["needs_input", "claude-code"], ["needs_input", "codex"]]);
  assert.ok(findArming(home, project, clock.now), "still armed");
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

test("one session's signal never silences another session's Stop (nap mode)", async () => {
  const { home, root, sent, clock, deps } = setup();
  armNap(home, clock.now + HOUR, clock.now);
  const a = join(root, "a");
  const b = join(root, "b");
  await runSignal("needs_input", "codex", deps(a), "session-a");
  await runHook("codex", payload("Stop", { cwd: b, session_id: "session-b", turn_id: "t1" }), deps(b));
  assert.deepEqual(sent.map((e) => e.kind), ["needs_input", "stopped"]);
  // B's next prompt doesn't clear A's signal either: A's Stop is still skipped.
  await runHook("codex", payload("UserPromptSubmit", { cwd: b, session_id: "session-b" }), deps(b));
  await runHook("codex", payload("Stop", { cwd: a, session_id: "session-a", turn_id: "t2" }), deps(a));
  assert.equal(sent.length, 2);
});

test("done ends the turn's alerts even when a nap also covers the folder", async () => {
  const { home, project, sent, clock, deps } = setup();
  armNap(home, clock.now + HOUR, clock.now);
  armProject(home, project, clock.now + HOUR, clock.now);
  await runSignal("done", "claude-code", deps(), "sess-1");
  await runHook("claude", payload("Stop", { cwd: project, session_id: "sess-1" }), deps());
  assert.deepEqual(sent.map((e) => e.kind), ["done"]);
});

test("a Stop that fires twice for one turn adds nothing the second time", async () => {
  const { home, project, sent, clock, deps } = setup();
  armNap(home, clock.now + HOUR, clock.now);
  armProject(home, project, clock.now + HOUR, clock.now);
  await runSignal("done", "claude-code", deps(), "sess-1");
  await runHook("claude", payload("Stop", { cwd: project, session_id: "sess-1" }), deps());
  await runHook("claude", payload("Stop", { cwd: project, session_id: "sess-1" }), deps());
  assert.deepEqual(sent.map((e) => e.kind), ["done"]);
  // Without an explicit signal, a repeated Stop also rings once.
  await runHook("claude", payload("Stop", { cwd: project, session_id: "sess-1", prompt_id: "p2" }), deps());
  await runHook("claude", payload("Stop", { cwd: project, session_id: "sess-1", prompt_id: "p2" }), deps());
  assert.deepEqual(sent.map((e) => e.kind), ["done", "stopped"]);
});

test("if the signal can't be recorded, the alert is still sent", async () => {
  const { home, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  writeFileSync(join(home, "signaled"), "a file where the folder should be");
  const result = await runSignal("done", "claude-code", deps(), "sess-1");
  assert.equal(result.sent, true);
  assert.deepEqual(sent.map((e) => e.kind), ["done"]);
});

test("a hook that saw an older arming can't use up a newer one", () => {
  const { home, project, clock } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  const seen = findArming(home, project, clock.now)!;
  armProject(home, project, clock.now + 2 * HOUR, clock.now + 1, "notify");
  assert.equal(claim(home, seen), false);
  assert.equal(findArming(home, project, clock.now + 1)?.level, "notify", "the new arming is untouched");
});

test("two alerts racing for one project arming: only the first claim sends", async () => {
  const { home, project, sent, clock, deps } = setup();
  armProject(home, project, clock.now + HOUR, clock.now);
  // Both hooks run concurrently; each finds the arming before either uses it up.
  await Promise.all([
    runHook("claude", payload("Stop", { cwd: project, session_id: "s1" }), deps()),
    runSignal("done", "claude-code", deps(), "s2"),
  ]);
  assert.equal(sent.length, 1);
});

test("arming again resets the needs_input rate limit", async () => {
  const { home, project, sent, clock, deps } = setup();
  const ask = () => runHook("claude", payload("PermissionRequest", { cwd: project, tool_input: { command: "rm -rf build" } }), deps());
  armProject(home, project, clock.now + HOUR, clock.now);
  await ask();
  clock.now += 1000;
  armProject(home, project, clock.now + HOUR, clock.now);
  await ask();
  assert.deepEqual(sent.map((e) => e.kind), ["needs_input", "needs_input"]);
});

test("the session for a signal comes from the agent's environment", () => {
  assert.equal(sessionFromEnv("claude-code", { CLAUDE_CODE_SESSION_ID: "c1" }), "c1");
  assert.equal(sessionFromEnv("codex", { CODEX_THREAD_ID: "t1", CODEX_SESSION_ID: "t1" }), "t1");
  assert.equal(sessionFromEnv("cli", { CLAUDE_CODE_SESSION_ID: "c1" }), undefined);
});

test("garbage input never throws", async () => {
  const { deps } = setup();
  for (const raw of ["", "not json", "[]", "null", '{"hook_event_name": 42}', '{"cwd": "/x"}']) {
    assert.equal(typeof (await runHook("claude", raw, deps())), "string");
  }
});
