import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CODEX_EVENTS, codexInstalled, codexPaths, installCodex, uninstallCodex } from "../src/install.js";
import { tempDir } from "./helpers.js";

function fixture(existing?: unknown) {
  const root = tempDir();
  const alarmHome = join(root, "alarm");
  const userHome = join(root, "user");
  const bundle = join(root, "code-alarm.mjs");
  writeFileSync(bundle, "// bundle");
  if (existing !== undefined) {
    mkdirSync(join(userHome, ".codex"), { recursive: true });
    writeFileSync(join(userHome, ".codex", "hooks.json"), typeof existing === "string" ? existing : JSON.stringify(existing));
  }
  return { root, alarmHome, userHome, bundle, paths: codexPaths(alarmHome, userHome) };
}

const theirs = { hooks: { Stop: [{ hooks: [{ type: "command", command: "python3 ~/mine.py" }] }] }, other: true };

test("install keeps the user's own hooks, adds ours, and backs the file up", () => {
  const f = fixture(theirs);
  installCodex({ alarmHome: f.alarmHome, userHome: f.userHome, bundle: f.bundle, now: 1 });
  const file = JSON.parse(readFileSync(f.paths.hooksFile, "utf8"));
  assert.equal(file.other, true);
  assert.equal(file.hooks.Stop.length, 2);
  assert.equal(file.hooks.Stop[0].hooks[0].command, "python3 ~/mine.py");
  for (const event of CODEX_EVENTS) {
    const ours = file.hooks[event].at(-1).hooks[0];
    assert.match(ours.command, /code-alarm\.mjs" hook codex$/);
    assert.equal(ours.async, true);
  }
  assert.ok(readdirSync(join(f.userHome, ".codex")).some((name) => name.startsWith("hooks.json.code-alarm-backup-")));
  assert.ok(existsSync(f.paths.cli));
  const rules = readFileSync(f.paths.rulesFile, "utf8");
  assert.match(rules, /decision = "allow"/);
  assert.match(rules, /\["arm", "disarm", "nap", "status", "done", "needs-you", "failed"\]/);
  const pattern = rules.split("pattern =")[1]!.split("\n")[0]!;
  assert.ok(!/"install"|"init"|"test"/.test(pattern), "install, init and test still ask");
  assert.match(readFileSync(join(f.paths.skillDir, "SKILL.md"), "utf8"), /^---\nname: code-alarm\n/);
  assert.ok(codexInstalled(f.alarmHome, f.userHome));
});

test("installing twice adds our hooks once", () => {
  const f = fixture(theirs);
  installCodex({ alarmHome: f.alarmHome, userHome: f.userHome, bundle: f.bundle, now: 1 });
  installCodex({ alarmHome: f.alarmHome, userHome: f.userHome, bundle: f.bundle, now: 2 });
  const file = JSON.parse(readFileSync(f.paths.hooksFile, "utf8"));
  assert.equal(file.hooks.Stop.length, 2);
  assert.equal(file.hooks.PermissionRequest.length, 1);
});

test("uninstall removes only ours", () => {
  const f = fixture(theirs);
  installCodex({ alarmHome: f.alarmHome, userHome: f.userHome, bundle: f.bundle, now: 1 });
  uninstallCodex({ alarmHome: f.alarmHome, userHome: f.userHome });
  const file = JSON.parse(readFileSync(f.paths.hooksFile, "utf8"));
  assert.deepEqual(file, theirs);
  assert.ok(!existsSync(f.paths.skillDir));
  assert.ok(!existsSync(f.paths.rulesFile));
  assert.ok(!codexInstalled(f.alarmHome, f.userHome));
});

test("install works with no hooks file yet", () => {
  const f = fixture();
  installCodex({ alarmHome: f.alarmHome, userHome: f.userHome, bundle: f.bundle, now: 1 });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f.paths.hooksFile, "utf8")).hooks).sort(), [...CODEX_EVENTS].sort());
});

test("an invalid hooks file is never overwritten", () => {
  const f = fixture("{ this is not json");
  assert.throws(() => installCodex({ alarmHome: f.alarmHome, userHome: f.userHome, bundle: f.bundle, now: 1 }), /isn't valid JSON/);
  assert.equal(readFileSync(f.paths.hooksFile, "utf8"), "{ this is not json");
});
