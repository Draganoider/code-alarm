import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CODEX_EVENTS,
  bundleVersion,
  codexCopy,
  codexInstalled,
  codexPaths,
  codexRules,
  describeCodexCopy,
  installCodex,
  refreshCodexCopy,
  uninstallCodex,
} from "../src/install.js";
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

test("someone else's rules file or skill is backed up, and uninstall leaves their files alone", () => {
  const f = fixture();
  mkdirSync(join(f.userHome, ".codex", "rules"), { recursive: true });
  writeFileSync(f.paths.rulesFile, "# my own rules\n");
  mkdirSync(f.paths.skillDir, { recursive: true });
  // Its own "# Code Alarm" heading doesn't make it ours.
  writeFileSync(join(f.paths.skillDir, "SKILL.md"), "# Code Alarm\nmy own skill\n");
  writeFileSync(join(f.paths.skillDir, "notes.md"), "keep me\n");
  installCodex({ alarmHome: f.alarmHome, userHome: f.userHome, bundle: f.bundle, now: 7 });
  assert.equal(readFileSync(`${f.paths.rulesFile}.code-alarm-backup-7`, "utf8"), "# my own rules\n");
  assert.equal(readFileSync(join(f.paths.skillDir, "SKILL.md.code-alarm-backup-7"), "utf8"), "# Code Alarm\nmy own skill\n");
  // Installing again overwrites only our own files, with no new backups.
  installCodex({ alarmHome: f.alarmHome, userHome: f.userHome, bundle: f.bundle, now: 8 });
  assert.ok(!existsSync(`${f.paths.rulesFile}.code-alarm-backup-8`));
  uninstallCodex({ alarmHome: f.alarmHome, userHome: f.userHome });
  assert.ok(!existsSync(f.paths.rulesFile));
  assert.ok(!existsSync(join(f.paths.skillDir, "SKILL.md")));
  assert.equal(readFileSync(join(f.paths.skillDir, "notes.md"), "utf8"), "keep me\n");
});

test("uninstall leaves a rules file it didn't write", () => {
  const f = fixture();
  mkdirSync(join(f.userHome, ".codex", "rules"), { recursive: true });
  writeFileSync(f.paths.rulesFile, "# my own rules\n");
  uninstallCodex({ alarmHome: f.alarmHome, userHome: f.userHome });
  assert.equal(readFileSync(f.paths.rulesFile, "utf8"), "# my own rules\n");
});

test("the rules file stays valid with quotes in the path", () => {
  const rules = codexRules(`C:\\Users\\O'Connor "x"\\AppData\\Roaming\\code-alarm\\bin\\code-alarm.mjs`);
  const path = JSON.stringify(`C:/Users/O'Connor "x"/AppData/Roaming/code-alarm/bin/code-alarm.mjs`);
  assert.ok(rules.includes(`pattern = ["node", ${path}, [`));
  assert.ok(rules.includes(`match = [["node", ${path}, "done"]`));
  assert.ok(!rules.includes("['node"), "no single-quoted examples for a path to break");
});

test("install refuses a path that can't be quoted safely in a hook command", () => {
  const f = fixture();
  const alarmHome = join(f.root, "a$b");
  assert.throws(() => installCodex({ alarmHome, userHome: f.userHome, bundle: f.bundle, now: 1 }), /can't be quoted safely/);
  assert.ok(!existsSync(join(f.userHome, ".codex")), "nothing written");
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

/** A file that looks like a bundle cli/build.mjs made, with or without the version (0.1.0 had none). */
function fakeBundle(path: string, version: string | null, body: string): string {
  const banner = `// code-alarm${version ? ` ${version}` : ""}, MIT License, https://github.com/Draganoider/code-alarm. Generated by cli/build.mjs: do not edit.`;
  writeFileSync(path, `#!/usr/bin/env node\n${banner}\n${body}\n`);
  return path;
}

/** Codex installed from one bundle; `newer` is the code-alarm running later, after an update. */
function installedFrom(version: string | null, body = "// old build") {
  const f = fixture(theirs);
  installCodex({ alarmHome: f.alarmHome, userHome: f.userHome, bundle: fakeBundle(join(f.root, "old.mjs"), version, body), now: 1 });
  const codexFiles = () => [f.paths.hooksFile, f.paths.rulesFile, join(f.paths.skillDir, "SKILL.md")].map((path) => readFileSync(path, "utf8"));
  return { ...f, codexFiles, newer: (v: string | null, b = "// new build") => fakeBundle(join(f.root, "new.mjs"), v, b) };
}

test("the built bundle's banner carries the package version", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const { version } = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8"));
  assert.equal(bundleVersion(readFileSync(join(here, "..", "..", "dist", "code-alarm.mjs"), "utf8")), version);
});

test("Codex's copy is current when it's the same file as the running CLI", () => {
  const f = installedFrom("0.2.0");
  assert.deepEqual(codexCopy(f.alarmHome, f.userHome, join(f.root, "old.mjs")), { state: "current" });
  assert.equal(refreshCodexCopy(f.alarmHome, f.userHome, join(f.root, "old.mjs")), null);
});

test("an older copy is reported, and refreshing it changes only the copy, not the hooks", () => {
  const f = installedFrom("0.1.0");
  const before = f.codexFiles();
  const running = f.newer("0.2.0");
  const copy = codexCopy(f.alarmHome, f.userHome, running);
  assert.equal(copy.state, "stale");
  assert.match(describeCodexCopy(copy)!, /older code-alarm \(0\.1\.0; this is 0\.2\.0\).*code-alarm install codex/);
  assert.match(refreshCodexCopy(f.alarmHome, f.userHome, running)!, /^Updated the copy/);
  assert.equal(readFileSync(f.paths.cli, "utf8"), readFileSync(running, "utf8"));
  assert.deepEqual(f.codexFiles(), before, "hook commands, rules and skill byte-identical: Codex needn't trust them again");
  assert.deepEqual(codexCopy(f.alarmHome, f.userHome, running), { state: "current" });
  assert.ok(!readdirSync(dirname(f.paths.cli)).some((name) => name.endsWith(".tmp")), "no temporary file left");
});

test("a different build of the same version, or a copy with no version, counts as stale", () => {
  for (const [old, now] of [["0.2.0", "0.2.0"], [null, "0.2.0"]] as const) {
    const f = installedFrom(old);
    const copy = codexCopy(f.alarmHome, f.userHome, f.newer(now));
    assert.equal(copy.state, "stale", `${old} -> ${now}`);
    assert.match(describeCodexCopy(copy)!, /different build/);
  }
});

test("a missing copy is put back", () => {
  const f = installedFrom("0.2.0");
  rmSync(f.paths.cli);
  const running = f.newer("0.2.0");
  assert.match(describeCodexCopy(codexCopy(f.alarmHome, f.userHome, running))!, /missing/);
  refreshCodexCopy(f.alarmHome, f.userHome, running);
  assert.equal(readFileSync(f.paths.cli, "utf8"), readFileSync(running, "utf8"));
});

test("a newer copy is left alone", () => {
  const f = installedFrom("0.3.0");
  const running = f.newer("0.2.0");
  assert.equal(codexCopy(f.alarmHome, f.userHome, running).state, "newer");
  assert.match(refreshCodexCopy(f.alarmHome, f.userHome, running)!, /newer code-alarm \(0\.3\.0\).*left alone/);
  assert.match(readFileSync(f.paths.cli, "utf8"), /code-alarm 0\.3\.0/);
});

test("nothing is copied without our hooks for this alarm home, or from a script that isn't a bundle", () => {
  const f = installedFrom("0.1.0");
  // A development run (node build/src/main.js) must never become Codex's copy.
  const dev = join(f.root, "main.js");
  writeFileSync(dev, 'import "./hook.js";\n');
  assert.equal(refreshCodexCopy(f.alarmHome, f.userHome, dev), null);
  // Hooks that point at another alarm home's copy.
  assert.equal(refreshCodexCopy(join(f.root, "other-home"), f.userHome, f.newer("0.2.0")), null);
  assert.ok(!existsSync(join(f.root, "other-home")));
  uninstallCodex({ alarmHome: f.alarmHome, userHome: f.userHome });
  assert.equal(refreshCodexCopy(f.alarmHome, f.userHome, f.newer("0.2.0")), null);
  assert.ok(!existsSync(f.paths.cli));
  assert.match(readFileSync(join(f.root, "old.mjs"), "utf8"), /0\.1\.0/);
});
