import { copyFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
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

export const CODEX_EVENTS = ["Stop", "PermissionRequest", "UserPromptSubmit"] as const;

const slashes = (path: string) => path.replace(/\\/g, "/");

export function codexCommand(cli: string): string {
  return `node "${slashes(cli)}" hook codex`;
}

/** The hook and the skill put the path in double quotes, where these characters would break or expand. */
const UNSAFE_IN_QUOTES = /["$`]/;

/** Marks a rules file or skill as ours, so we never overwrite or delete someone else's. */
const RULES_MARK = "Written by `code-alarm install codex`";
const SKILL_MARK = "# Code Alarm\n";

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

  mkdirSync(dirname(paths.cli), { recursive: true });
  copyFileSync(args.bundle, paths.cli);
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
  writeFileAtomic(skillFile, skillMarkdown(`node "${slashes(paths.cli)}"`, "code-alarm"));
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

export function codexInstalled(alarmHome: string, userHome: string): boolean {
  try {
    const file = readHooksFile(codexPaths(alarmHome, userHome).hooksFile);
    return Object.values(file.hooks ?? {}).some((groups) => groups.some((group) => (group.hooks ?? []).some(isOurs)));
  } catch {
    return false;
  }
}
