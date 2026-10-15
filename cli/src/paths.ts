import { homedir } from "node:os";
import { join } from "node:path";

/** Where code-alarm keeps its config and state. CODE_ALARM_HOME overrides it (tests, portable setups). */
export function alarmHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.CODE_ALARM_HOME) return env.CODE_ALARM_HOME;
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "code-alarm");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "code-alarm");
}
