import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_NTFY_SERVER, ConfigError, isValidTopic, loadConfig, newTopic, saveConfig } from "./config.js";
import { decodeEvent, logLine, recentLog, sendDetached, sendNow } from "./deliver.js";
import { HOUR, MAX_ARM_MS, formatDuration, parseDuration } from "./duration.js";
import { type Agent, buildEvent, labelFor } from "./events.js";
import { type HookAgent, type SignalKind, runHook, runSignal } from "./hook.js";
import { codexInstalled, installCodex, uninstallCodex } from "./install.js";
import { alarmHome } from "./paths.js";
import { skillMarkdown } from "./skill.js";
import { armNap, armProject, disarmAll, disarmProject, listArmings } from "./state.js";

declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";
const DEFAULT_ARM_MS = 12 * HOUR;

const HELP = `code-alarm ${VERSION}: a real alarm on your phone when Claude Code or Codex finishes or needs you.

Setup
  code-alarm init [--server URL] [--topic NAME] [--token TOKEN] [--force]
                                 Create a private ntfy topic and show how to subscribe on the phone
  code-alarm test [--notify]     Ring the phone now (or send a plain notification)
  code-alarm install codex       Add Code Alarm's hooks and skill to Codex (uninstall codex removes them)

Arming (only armed work rings)
  code-alarm arm [--for 12h] [--notify]
                                 Ring when the agent in this folder next finishes, stops or needs you
  code-alarm nap <2h> [--notify] Ring for every session until the time is up
                                 --notify: one ordinary notification instead of the alarm
  code-alarm disarm [--all]      Cancel arming for this folder (or everything)
  code-alarm status              What's set up, what's armed, the last alerts

Run by the agent (its skill says when)
  code-alarm done | needs-you | failed

Run by agent hooks
  code-alarm hook claude|codex   Reads the hook's JSON on stdin; prints nothing, always exits 0

Claude Code users install the plugin instead of running anything here by hand:
  claude plugin marketplace add Draganoider/code-alarm
  claude plugin install code-alarm@code-alarm

https://github.com/Draganoider/code-alarm`;

async function readStdin(timeoutMs = 3000): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((done) => {
    let data = "";
    const timer = setTimeout(() => done(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      done(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      done(data);
    });
  });
}

function detectAgent(env: NodeJS.ProcessEnv): Agent {
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (Object.keys(env).some((key) => key.startsWith("CODEX_"))) return "codex";
  return "cli";
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

function setupHint(): string {
  return "Code Alarm isn't set up on this computer yet. Run `code-alarm init` in a terminal.";
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const home = alarmHome();
  const deps = { home, now: Date.now, send: (event: Parameters<typeof sendDetached>[0]) => sendDetached(event), cwd: () => process.cwd() };

  switch (command) {
    case "hook": {
      const agent = rest[0];
      if (agent !== "claude" && agent !== "codex") return 0;
      const note = await runHook(agent as HookAgent, await readStdin(), deps);
      if (note) logLine(home, note);
      return 0;
    }

    case "__send": {
      const event = decodeEvent(rest[0] ?? "");
      if (event) await sendNow(home, event);
      return 0;
    }

    case "__skill":
      // Used by cli/build.mjs to write the Claude Code plugin's SKILL.md from the same source.
      process.stdout.write(skillMarkdown(rest[0] ?? "code-alarm", rest[1] ?? "alarm", rest[2]));
      return 0;

    case "init": {
      const { values } = parseArgs({
        args: rest,
        options: { server: { type: "string" }, topic: { type: "string" }, token: { type: "string" }, force: { type: "boolean" } },
      });
      const existing = loadConfig(home);
      if (existing && !values.force) {
        console.log(`Already set up: ntfy topic ${existing.ntfy.topic} on ${existing.ntfy.server}.`);
        console.log("Run `code-alarm init --force` to start over with a new topic.");
        return 0;
      }
      const topic = values.topic ?? newTopic();
      if (!isValidTopic(topic)) throw new ConfigError("A topic can only use letters, digits, - and _ (at most 64).");
      const server = (values.server ?? DEFAULT_NTFY_SERVER).replace(/\/+$/, "");
      saveConfig(home, { version: 1, transport: "ntfy", ntfy: { server, topic, ...(values.token ? { token: values.token } : {}) } });
      console.log(`Code Alarm is set up.

  Server: ${server}
  Topic:  ${topic}
  Treat the topic like a password: anyone who knows it can ring your phone.

On your phone:
  1. Install the ntfy app (Google Play, F-Droid or the App Store).
  2. Subscribe to the topic above${server === DEFAULT_NTFY_SERVER ? "" : `, on the server ${server}`}.
  3. In that subscription's settings, turn on the option that keeps alerting for highest-priority
     messages, and the one that lets it through Do Not Disturb. (Names vary a little between app
     versions.)
  4. Back here, run: code-alarm test

Then connect your agent:
  Claude Code:  claude plugin marketplace add Draganoider/code-alarm
                claude plugin install code-alarm@code-alarm
  Codex:        code-alarm install codex`);
      return 0;
    }

    case "test": {
      const { values } = parseArgs({ args: rest, options: { notify: { type: "boolean" } } });
      if (!loadConfig(home)) {
        console.log(setupHint());
        return 1;
      }
      const event = buildEvent({ kind: "test", level: values.notify ? "notify" : "alarm", label: "test", agent: "cli", now: Date.now() });
      const result = await sendNow(home, event);
      const expected = values.notify
        ? "You should get one notification now, with sound and vibration."
        : "Your phone should be ringing now, until you dismiss it.";
      console.log(result.ok ? `Sent. ${expected}` : `Couldn't send the test: ${result.detail}.`);
      return result.ok ? 0 : 1;
    }

    case "arm": {
      const { values } = parseArgs({ args: rest, options: { for: { type: "string" }, notify: { type: "boolean" } } });
      if (!loadConfig(home)) {
        console.log(setupHint());
        return 1;
      }
      const ms = values.for ? parseDuration(values.for) : DEFAULT_ARM_MS;
      if (!ms || ms > MAX_ARM_MS) throw new ConfigError(`--for takes a duration like 2h, 90m or 1h30m, at most 24h.`);
      const now = Date.now();
      const level = values.notify ? "notify" : "alarm";
      const arming = armProject(home, process.cwd(), now + ms, now, level);
      console.log(
        `Armed "${labelFor(arming.dir ?? process.cwd())}" until ${clock(arming.until)} (${formatDuration(ms)}). ` +
          (level === "notify"
            ? "The phone gets one notification the next time the agent here finishes, stops or needs you."
            : "The phone rings the next time the agent here finishes, stops or needs you."),
      );
      return 0;
    }

    case "nap": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { notify: { type: "boolean" } } });
      const ms = positionals[0] ? parseDuration(positionals[0]) : null;
      if (!ms || ms > MAX_ARM_MS) throw new ConfigError("Usage: code-alarm nap <duration>, like 2h or 45m (at most 24h).");
      if (!loadConfig(home)) {
        console.log(setupHint());
        return 1;
      }
      const now = Date.now();
      armNap(home, now + ms, now, values.notify ? "notify" : "alarm");
      console.log(
        `Nap mode until ${clock(now + ms)}: every session that finishes, stops or needs you ` +
          (values.notify ? "sends a notification." : "rings the phone."),
      );
      return 0;
    }

    case "disarm": {
      const { values } = parseArgs({ args: rest, options: { all: { type: "boolean" } } });
      if (values.all) {
        console.log(`Disarmed ${disarmAll(home)} arming(s).`);
      } else {
        console.log(disarmProject(home, process.cwd()) ? "Disarmed this folder." : "This folder wasn't armed.");
      }
      return 0;
    }

    case "status": {
      const config = loadConfig(home);
      console.log(
        config
          ? `Transport: ntfy, ${config.ntfy.server}, topic ${config.ntfy.topic.slice(0, 14)}…${config.ntfy.token ? " (with token)" : ""}`
          : "Not set up: run `code-alarm init`.",
      );
      const now = Date.now();
      const armings = listArmings(home, now);
      console.log(armings.length ? "Armed:" : "Nothing is armed.");
      for (const arming of armings) {
        const what = arming.kind === "nap" ? "nap mode, every session" : `${arming.dir}`;
        const level = arming.level === "notify" ? ", notification only" : "";
        console.log(`  - ${what} until ${clock(arming.until)} (${formatDuration(arming.until - now)} left${level})`);
      }
      console.log(`Codex hooks: ${codexInstalled(home, homedir()) ? "installed" : "not installed"}`);
      const log = recentLog(home, 5);
      if (log.length) console.log(`Last activity:\n${log.map((line) => `  ${line}`).join("\n")}`);
      return 0;
    }

    case "done":
    case "needs-you":
    case "failed": {
      const kind: SignalKind = command === "needs-you" ? "needs_input" : command;
      const result = await runSignal(kind, detectAgent(process.env), deps);
      console.log(result.message);
      return 0;
    }

    case "install":
    case "uninstall": {
      if (rest[0] !== "codex") throw new ConfigError(`Usage: code-alarm ${command} codex`);
      const script = process.argv[1];
      if (command === "install") {
        if (!script) throw new ConfigError("Can't tell where this code-alarm script is.");
        for (const note of installCodex({ alarmHome: home, userHome: homedir(), bundle: resolve(script), now: Date.now() })) console.log(note);
        console.log(
          "\nNext: quit Codex completely and start it again. It reads rules only at startup, and closing\n" +
            "its window may leave it running in the background. Then approve (trust) the new hooks when it\n" +
            "asks; Codex skips hooks until you do.\n" +
            "Then, before a long task, ask Codex to use the code-alarm skill (or say \"wake me when it's done\").",
        );
      } else {
        for (const note of uninstallCodex({ alarmHome: home, userHome: homedir() })) console.log(note);
      }
      return 0;
    }

    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;

    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;

    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}

const quiet = process.argv[2] === "hook" || process.argv[2] === "__send";
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = quiet ? 0 : code;
  },
  (e: unknown) => {
    // Hooks never fail, whatever happened (hard rule 6).
    if (quiet) {
      process.exitCode = 0;
      return;
    }
    console.error(`code-alarm: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
