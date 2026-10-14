import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.js";

const MAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.js");

function run(args: string[], input = "", home = tempDir()) {
  return spawnSync(process.execPath, [MAIN, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, CODE_ALARM_HOME: home },
    timeout: 20_000,
  });
}

test("hooks print nothing and exit 0, whatever they're given", () => {
  // Claude Code adds a UserPromptSubmit hook's stdout to the prompt, and Codex reads a
  // PermissionRequest hook's stdout as a decision: a hook must never print.
  for (const agent of ["claude", "codex", "nobody"]) {
    for (const input of ["", "garbage", JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: "/" }), JSON.stringify({ hook_event_name: "PermissionRequest" })]) {
      const result = run(["hook", agent], input);
      assert.equal(result.status, 0, `${agent} ${input}`);
      assert.equal(result.stdout, "", `${agent} ${input}`);
    }
  }
});

test("signals without arming say so and exit 0", () => {
  const result = run(["done"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Not armed here/);
});

test("arm and test refuse politely before init", () => {
  for (const command of ["arm", "test"]) {
    const result = run([command]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /code-alarm init/);
  }
});

test("init, then arm, status and disarm", () => {
  const home = tempDir();
  assert.equal(run(["init", "--topic", "code-alarm-test-topic"], "", home).status, 0);
  assert.match(run(["arm", "--for", "2h"], "", home).stdout, /^Armed /);
  const status = run(["status"], "", home).stdout;
  assert.match(status, /Transport: ntfy, https:\/\/ntfy\.sh, topic set/);
  assert.doesNotMatch(status, /code-alarm-te/, "no part of the topic: people paste status into bug reports");
  assert.match(status, /Armed:/);
  assert.match(run(["disarm"], "", home).stdout, /Disarmed this folder/);
  assert.match(run(["arm", "--notify"], "", home).stdout, /one notification/);
  assert.match(run(["status"], "", home).stdout, /notification only/);
  run(["disarm"], "", home);
  assert.match(run(["status"], "", home).stdout, /Nothing is armed/);
});

test("init --force recovers from a broken config", () => {
  const home = tempDir();
  writeFileSync(join(home, "config.json"), "{ not json");
  assert.notEqual(run(["status"], "", home).status, 0);
  assert.equal(run(["init", "--force", "--topic", "code-alarm-fresh-topic"], "", home).status, 0);
  assert.match(run(["status"], "", home).stdout, /topic set/);
});

test("bad durations are refused", () => {
  const home = tempDir();
  run(["init"], "", home);
  for (const args of [["arm", "--for", "2 days"], ["arm", "--for", "25h"], ["nap"], ["nap", "soon"]]) {
    const result = run(args, "", home);
    assert.equal(result.status, 1, args.join(" "));
  }
});
