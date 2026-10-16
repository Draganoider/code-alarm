import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./fsutil.js";
import { skillMarkdown } from "./skill.js";

/**
 * Codex: user-level hooks in ~/.codex/hooks.json and a personal skill. Codex plugin hooks only
 * work for some installs (docs/agents.md), so this is the reliable route.
 */
export interface CodexPaths {
  hooksFile: string;
  rulesFile: string;
  skillDir: string;
  cli: string;
}

export function codexPaths(alarmHome: string, userHome: string): CodexPaths {
  return {
    hooksFile: join(userHome, ".codex", "hooks.json"),
    rulesFile: join(userHome, ".codex", "rules", "code-alarm.rules"),
    skillDir: join(userHome, ".agents", "skills", "code-alarm"),
    // A fixed path: Codex trusts a hook by its exact command, so updating code-alarm must not change it.
    cli: join(alarmHome, "bin", "code-alarm.mjs"),
  };
}

/** PostToolUse runs after every tool call; it's only used to see that an approval request was answered. */
export const CODEX_EVENTS = ["Stop", "PermissionRequest", "PostToolUse", "UserPromptSubmit"] as const;

const slashes = (path: string) => path.replace(/\\/g, "/");

export function codexCommand(cli: string): string {
  return `node "${slashes(cli)}" hook codex`;
}

/** The hook and the skill put the path in double quotes, where these characters would break or expand. */
const UNSAFE_IN_QUOTES = /["$`]/;

/** Marks a rules file or skill as ours, so we never overwrite or delete someone else's. */
const RULES_MARK = "Written by `code-alarm install codex`";
const SKILL_MARK = "<!-- Written by `code-alarm install codex`";

/**
 * A Codex rules file (https://developers.openai.com/codex/rules) that lets the agent run Code
 * Alarm's own commands outside the sandbox without asking. Otherwise `done` would wait for an
 * approval nobody is there to give. `install`, `init` and `test` still ask.
 */
export function codexRules(cli: string): string {
  // A JSON string is a valid Starlark string, whatever the path contains. The examples are token
  // lists, so no shell quoting is involved; Codex checks them when it loads the file.
  const path = JSON.stringify(slashes(cli));
  return `# ${RULES_MARK}; removed by \`code-alarm uninstall codex\`.
# Lets Codex run Code Alarm's own commands without asking: they only change its arming state
# and send an alarm.
prefix_rule(
    pattern = ["node", ${path}, ["arm", "disarm", "nap", "status", "done", "needs-you", "failed"]],
    decision = "allow",
    justification = "Code Alarm's own commands: arming state and alarms only.",
    match = [["node", ${path}, "done"], ["node", ${path}, "arm", "--notify"]],
    not_match = [["node", ${path}, "install", "codex"]],
)
`;
}

interface HookHandler {
  type?: string;
  command?: string;
  [key: string]: unknown;
}
interface MatcherGroup {
  matcher?: string;
  hooks?: HookHandler[];
  [key: string]: unknown;
}
export interface HooksFile {
  hooks?: Record<string, MatcherGroup[]>;
  [key: string]: unknown;
}

const isOurs = (handler: HookHandler) => typeof handler.command === "string" && /code-alarm\.mjs"? hook codex/.test(handler.command);

/** The file without any code-alarm handlers; everything else is left exactly as it was. */
export function withoutCodeAlarm(file: HooksFile): HooksFile {
  if (!file.hooks) return { ...file };
  const hooks: Record<string, MatcherGroup[]> = {};
  for (const [event, groups] of Object.entries(file.hooks)) {
    const kept = groups
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((handler) => !isOurs(handler)) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  return { ...file, hooks };
}

export function withCodeAlarm(file: HooksFile, cli: string): HooksFile {
  const result = withoutCodeAlarm(file);
  const hooks = { ...(result.hooks ?? {}) };
  for (const event of CODEX_EVENTS) {
    // async: Codex runs it in the background, so it can't hold anything up or decide a permission.
    const group: MatcherGroup = { hooks: [{ type: "command", command: codexCommand(cli), timeout: 10, async: true }] };
    hooks[event] = [...(hooks[event] ?? []), group];
  }
  return { ...result, hooks };
}

function readHooksFile(path: string): HooksFile {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as HooksFile;
  } catch {
    // Fall through to the error below.
  }
  throw new Error(`${path} isn't valid JSON, so code-alarm won't touch it. Fix or move it, then run this again.`);
}

/** Through a temporary file and a rename, so a hook starting at that moment never runs half a file. */
function copyAtomic(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  const temp = `${to}.${process.pid}.tmp`;
  copyFileSync(from, temp);
  renameSync(temp, to);
}

const isOurFile = (path: string, mark: string) => readFileSync(path, "utf8").includes(mark);

/** Backs up a file that isn't ours before we write over it. */
function setAside(path: string, mark: string, now: number, notes: string[]): void {
  if (!existsSync(path) || isOurFile(path, mark)) return;
  const backup = `${path}.code-alarm-backup-${now}`;
  copyFileSync(path, backup);
  notes.push(`Backed up ${path} to ${backup}`);
}

/** Deletes a file only if it's ours. */
function removeOurs(path: string, mark: string, notes: string[]): void {
  if (!existsSync(path)) return;
  if (!isOurFile(path, mark)) {
    notes.push(`Left ${path} alone: code-alarm didn't write it`);
    return;
  }
  rmSync(path, { force: true });
  notes.push(`Removed ${path}`);
}

export function installCodex(args: { alarmHome: string; userHome: string; bundle: string; now: number }): string[] {
  const paths = codexPaths(args.alarmHome, args.userHome);
  const notes: string[] = [];
  if (UNSAFE_IN_QUOTES.test(paths.cli)) {
    throw new Error(`${paths.cli} contains " $ or \`, which can't be quoted safely in a hook command. Set CODE_ALARM_HOME to another folder and run this again.`);
  }
  const current = readHooksFile(paths.hooksFile);

  copyAtomic(args.bundle, paths.cli);
  notes.push(`Copied the CLI to ${paths.cli}`);

  if (existsSync(paths.hooksFile)) {
    const backup = `${paths.hooksFile}.code-alarm-backup-${args.now}`;
    copyFileSync(paths.hooksFile, backup);
    notes.push(`Backed up ${paths.hooksFile} to ${backup}`);
  }
  writeFileAtomic(paths.hooksFile, JSON.stringify(withCodeAlarm(current, paths.cli), null, 2) + "\n");
  notes.push(`Added hooks for ${CODEX_EVENTS.join(", ")} to ${paths.hooksFile}`);

  setAside(paths.rulesFile, RULES_MARK, args.now, notes);
  writeFileAtomic(paths.rulesFile, codexRules(paths.cli));
  notes.push(`Allowed Code Alarm's own commands in ${paths.rulesFile}`);

  const skillFile = join(paths.skillDir, "SKILL.md");
  setAside(skillFile, SKILL_MARK, args.now, notes);
  const skill = skillMarkdown(`node "${slashes(paths.cli)}"`, "code-alarm");
  writeFileAtomic(skillFile, `${skill}\n${SKILL_MARK}; removed by \`code-alarm uninstall codex\`. -->\n`);
  notes.push(`Installed the skill in ${paths.skillDir}`);
  return notes;
}

export function uninstallCodex(args: { alarmHome: string; userHome: string }): string[] {
  const paths = codexPaths(args.alarmHome, args.userHome);
  const notes: string[] = [];
  if (existsSync(paths.hooksFile)) {
    writeFileAtomic(paths.hooksFile, JSON.stringify(withoutCodeAlarm(readHooksFile(paths.hooksFile)), null, 2) + "\n");
    notes.push(`Removed code-alarm's hooks from ${paths.hooksFile}`);
  }
  removeOurs(paths.rulesFile, RULES_MARK, notes);
  removeOurs(join(paths.skillDir, "SKILL.md"), SKILL_MARK, notes);
  try {
    rmdirSync(paths.skillDir); // only when nothing else is left in it
  } catch {
    // Missing, or it holds someone else's files: leave it.
  }
  rmSync(paths.cli, { force: true });
  return notes;
}

/** cli/build.mjs puts this in every bundle's banner, with the version. */
const BUNDLE_MARK = "Generated by cli/build.mjs";

/** The version in a bundle's banner. Copies made by 0.1.0 have none. */
export function bundleVersion(text: string): string | null {
  return /^\/\/ code-alarm (\d+\.\d+\.\d+[^\s,]*), MIT License/m.exec(text.slice(0, 1000))?.[1] ?? null;
}

/** -1, 0 or 1. Only the numbers count: a pre-release tag compares equal to its release. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0]!.split(".").map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

/**
 * Whether Codex's hooks run the same code-alarm as `running` (the script running now). An old copy
 * can't read settings a newer version wrote, and because hooks always exit 0 it fails silently.
 * - none: Codex's hooks don't point at this alarm home's copy, or `running` isn't a bundle (a dev run)
 * - stale: missing, older, or a different build of the same version
 * - newer: the copy's version is newer than this one, so it's left alone
 */
export type CodexCopy =
  | { state: "none" | "current" }
  | { state: "stale"; path: string; copyVersion: string | null; version: string | null; missing: boolean }
  | { state: "newer"; path: string; copyVersion: string; version: string | null };

export function codexCopy(alarmHome: string, userHome: string, running: string | undefined): CodexCopy {
  const paths = codexPaths(alarmHome, userHome);
  let bundle: Buffer;
  try {
    if (!running || !hooksRun(paths)) return { state: "none" };
    bundle = readFileSync(running);
  } catch {
    return { state: "none" };
  }
  const text = bundle.toString("utf8", 0, 1000);
  if (!text.includes(BUNDLE_MARK)) return { state: "none" };
  const version = bundleVersion(text);
  if (!existsSync(paths.cli)) return { state: "stale", path: paths.cli, copyVersion: null, version, missing: true };
  const copy = readFileSync(paths.cli);
  if (copy.equals(bundle)) return { state: "current" };
  const copyVersion = bundleVersion(copy.toString("utf8", 0, 1000));
  if (copyVersion && version && compareVersions(copyVersion, version) > 0) return { state: "newer", path: paths.cli, copyVersion, version };
  return { state: "stale", path: paths.cli, copyVersion, version, missing: false };
}

/** Our exact hook command is in Codex's hooks file, pointing at this alarm home's copy. */
function hooksRun(paths: CodexPaths): boolean {
  const command = codexCommand(paths.cli);
  const file = readHooksFile(paths.hooksFile);
  return Object.values(file.hooks ?? {}).some((groups) => groups.some((group) => (group.hooks ?? []).some((h) => h.command === command)));
}

/** How `status` describes the copy, or null when there's nothing to say. */
export function describeCodexCopy(copy: CodexCopy): string | null {
  if (copy.state === "stale") {
    const which = copy.missing
      ? "but the copy of code-alarm they run is missing"
      : copy.copyVersion && copy.copyVersion !== copy.version
        ? `but they run an older code-alarm (${copy.copyVersion}; this is ${copy.version ?? "unknown"})`
        : "but they run a different build of code-alarm than this one";
    return `${which}, so they may send nothing. \`code-alarm install codex\` updates it; the hooks stay the same, so Codex won't ask to trust them again`;
  }
  if (copy.state === "newer") return `running a newer code-alarm (${copy.copyVersion}) than this one (${copy.version ?? "unknown"})`;
  return null;
}

/**
 * Brings Codex's copy up to date with `running`, after a command that wrote settings an old copy
 * might not read. Only the copy changes, never the hook commands. Returns what to tell the user.
 */
export function refreshCodexCopy(alarmHome: string, userHome: string, running: string | undefined): string | null {
  const copy = codexCopy(alarmHome, userHome, running);
  if (copy.state === "newer") {
    return `Codex runs a newer code-alarm (${copy.copyVersion}) than this one, so its copy was left alone. If its alerts stop, update this code-alarm.`;
  }
  if (copy.state !== "stale") return null;
  try {
    copyAtomic(running!, copy.path);
  } catch (e) {
    return `Couldn't update the copy of code-alarm that Codex's hooks run (${e instanceof Error ? e.message : String(e)}), so they may send nothing. Run \`code-alarm install codex\` to update it.`;
  }
  return `Updated the copy of code-alarm that Codex's hooks run, so they can read the new settings.`;
}

export function codexInstalled(alarmHome: string, userHome: string): boolean {
  try {
    const file = readHooksFile(codexPaths(alarmHome, userHome).hooksFile);
    return Object.values(file.hooks ?? {}).some((groups) => groups.some((group) => (group.hooks ?? []).some(isOurs)));
  } catch {
    return false;
  }
}
