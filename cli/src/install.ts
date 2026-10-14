import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./fsutil.js";
import { skillMarkdown } from "./skill.js";

/**
 * Codex: user-level hooks in ~/.codex/hooks.json and a personal skill. Codex plugin hooks only
 * work for some installs (docs/agents.md), so this is the reliable route.
 */
export interface CodexPaths {
  hooksFile: string;
  skillDir: string;
  cli: string;
}

export function codexPaths(alarmHome: string, userHome: string): CodexPaths {
  return {
    hooksFile: join(userHome, ".codex", "hooks.json"),
    skillDir: join(userHome, ".agents", "skills", "code-alarm"),
    // A fixed path: Codex trusts a hook by its exact command, so updating code-alarm must not change it.
    cli: join(alarmHome, "bin", "code-alarm.mjs"),
  };
}

export const CODEX_EVENTS = ["Stop", "PermissionRequest", "UserPromptSubmit"] as const;

export function codexCommand(cli: string): string {
  return `node "${cli.replace(/\\/g, "/")}" hook codex`;
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

export function installCodex(args: { alarmHome: string; userHome: string; bundle: string; now: number }): string[] {
  const paths = codexPaths(args.alarmHome, args.userHome);
  const notes: string[] = [];
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

  writeFileAtomic(join(paths.skillDir, "SKILL.md"), skillMarkdown(`node "${paths.cli.replace(/\\/g, "/")}"`, "code-alarm"));
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
  if (existsSync(paths.skillDir)) {
    rmSync(paths.skillDir, { recursive: true, force: true });
    notes.push(`Removed the skill from ${paths.skillDir}`);
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
