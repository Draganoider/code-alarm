import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type PairingAsk, askToPair, defaultName, describeDelivery, fetchDelivery, pairWithPhone, phoneUnreachableAdvice, pollPairing, relayUrl, unpairFromPhone } from "./app.js";
import { type AppConfig, type Config, DEFAULT_NTFY_SERVER, ConfigError, isValidTopic, loadConfig, newTopic, removeConfig, saveConfig } from "./config.js";
import { decodeEvent, lastEvent, lastSend, logLine, recentLog, sendDetached, sendNow, waitDetached } from "./deliver.js";
import { HOUR, MAX_ARM_MS, formatDuration, parseDuration } from "./duration.js";
import { type Agent, buildEvent, labelFor } from "./events.js";
import { type Deps, type HookAgent, PENDING_WAIT_MS, type SignalKind, firePending, runHook, runSignal, sessionFromEnv } from "./hook.js";
import { codexCopy, codexInstalled, describeCodexCopy, installCodex, refreshCodexCopy, uninstallCodex } from "./install.js";
import { alarmHome } from "./paths.js";
import { qrForTerminal } from "./qr.js";
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

The Code Alarm app (in testing)
  code-alarm pair [<code>] [--name NAME] [--relay URL]
                                 Pair with your phone: shows a QR to scan in the app, or takes the
                                 code the app shows. Alerts then go through the app
  code-alarm unpair              Remove this computer from the phone
  code-alarm use ntfy|app        Switch between ntfy and the app when both are set up

Arming (only armed work rings)
  code-alarm arm [--for 12h] [--notify]
                                 Ring when the agent in this folder next finishes, stops or needs you
  code-alarm nap <2h> [--notify] Ring for every session until the time is up
                                 --notify: one ordinary notification instead of the alarm
  code-alarm disarm [--all]      Cancel arming for this folder (or everything)
  code-alarm status [--last]     What's set up, what's armed, the last alerts
                                 --last: what the phone did with the last alert (app only)

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
    const timer = setTimeout(() => {
      // An agent that never closes stdin mustn't keep the hook alive (and the agent waiting).
      process.stdin.destroy();
      done(data);
    }, timeoutMs);
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

/** The script running now: what `install codex` copies, and what Codex's copy is compared with. */
const runningScript = () => (process.argv[1] ? resolve(process.argv[1]) : undefined);

/** After saving settings: Codex's hooks run their own copy of the CLI, which must be able to read them. */
function refreshCodex(home: string): void {
  const note = refreshCodexCopy(home, homedir(), runningScript());
  if (note) console.log(note);
}

function setupHint(): string {
  return "Code Alarm isn't set up on this computer yet. Run `code-alarm init` in a terminal.";
}

/** How often QR pairing asks the relay whether the phone said yes. CODE_ALARM_POLL_MS is for tests. */
const POLL_MS = Number(process.env.CODE_ALARM_POLL_MS) || 2500;

/** Shows the QR and waits for the phone to approve it, up to the request's 10 minutes. */
async function waitForPhone(ask: PairingAsk): Promise<AppConfig | null> {
  console.log("Open Code Alarm on your phone, tap Pair a computer, then Scan QR code:\n");
  // Upper case fits QR's compact alphanumeric mode: a smaller code that scans more easily. The
  // relay's /pair/ page and the app both read it in any case.
  console.log(qrForTerminal(ask.url.toUpperCase()));
  console.log(`\n(code ${ask.code}, works once, until ${clock(ask.expiresAt)})`);
  console.log('No camera? In the app, choose "Show a code instead" and run: code-alarm pair <that code>');
  console.log("Waiting for your phone… Ctrl-C stops.");
  let warned = false;
  while (Date.now() < ask.expiresAt) {
    await new Promise((done) => setTimeout(done, POLL_MS));
    const result = await pollPairing(ask, Date.now());
    if (result.status === "approved") return result.app;
    if (result.status === "expired") break;
    if (result.status === "error" && !warned) {
      console.log(`Still waiting (${result.message}).`);
      warned = true;
    }
  }
  console.log("The code ran out before a phone approved it. Run `code-alarm pair` again.");
  return null;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const home = alarmHome();
  const deps: Deps = {
    home,
    now: Date.now,
    send: (event) => sendDetached(event),
    wait: (id, at) => waitDetached(id, at),
    cwd: () => process.cwd(),
  };

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

    case "__wait": {
      // The detached waiter behind a Codex approval request (hook.ts, firePending).
      const [id = "", at = ""] = rest;
      if (!/^[\w-]+$/.test(id) || !/^\d+$/.test(at)) return 0;
      await new Promise((done) => setTimeout(done, PENDING_WAIT_MS));
      const note = await firePending(id, Number(at), deps);
      if (note) logLine(home, note);
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
      // --force starts over even when the old config can't be read, which may be the broken thing.
      // A pairing with the app is kept when it can be read.
      let existing: Config | null = null;
      try {
        existing = loadConfig(home);
      } catch (e) {
        if (!values.force) throw e;
      }
      if (existing?.ntfy && !values.force) {
        console.log(`Already set up: ntfy topic ${existing.ntfy.topic} on ${existing.ntfy.server}.`);
        console.log("Run `code-alarm init --force` to start over with a new topic.");
        return 0;
      }
      const topic = values.topic ?? newTopic();
      if (!isValidTopic(topic)) throw new ConfigError("A topic can only use letters, digits, - and _ (at most 64).");
      const server = (values.server ?? DEFAULT_NTFY_SERVER).replace(/\/+$/, "");
      const ntfy = { server, topic, ...(values.token ? { token: values.token } : {}) };
      const app = existing?.app;
      saveConfig(home, app ? { version: 1, transport: "app", app, ntfy } : { version: 1, transport: "ntfy", ntfy });
      refreshCodex(home);
      if (app) console.log("This computer is paired with the Code Alarm app, which still sends: `code-alarm use ntfy` switches to ntfy.\n");
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
      const { values } = parseArgs({ args: rest, options: { last: { type: "boolean" } } });
      const config = loadConfig(home);
      // Never any part of the topic or the token: people paste this output into bug reports.
      if (!config) console.log("Not set up: run `code-alarm init`.");
      else if (config.transport === "app" && config.app) {
        console.log(`Transport: Code Alarm app, paired as "${config.app.name}" through ${config.app.relay}${config.ntfy ? " (ntfy is set up too)" : ""}`);
      } else if (config.ntfy) {
        console.log(`Transport: ntfy, ${config.ntfy.server}, topic set${config.ntfy.token ? ", with a token" : ""}${config.app ? " (paired with the app too)" : ""}`);
      }
      const now = Date.now();
      const armings = listArmings(home, now);
      console.log(armings.length ? "Armed:" : "Nothing is armed.");
      for (const arming of armings) {
        const what = arming.kind === "nap" ? "nap mode, every session" : `${arming.dir}`;
        const level = arming.level === "notify" ? ", notification only" : "";
        console.log(`  - ${what} until ${clock(arming.until)} (${formatDuration(arming.until - now)} left${level})`);
      }
      const copy = describeCodexCopy(codexCopy(home, homedir(), runningScript()));
      console.log(`Codex hooks: ${codexInstalled(home, homedir()) ? `installed${copy ? `, ${copy}` : ""}` : "not installed"}`);
      const log = recentLog(home, 5);
      if (log.length) console.log(`Last activity:\n${log.map((line) => `  ${line}`).join("\n")}`);
      if (config?.transport === "app" && config.app) {
        // A hook can only log a failed send, so this is where a lost alert gets explained. Only a
        // send since the current pairing counts: pairing again is the fix.
        const send = lastSend(home);
        if (send && !send.ok && send.at >= config.app.pairedAt && send.detail.includes("phone_unreachable")) {
          console.log(`The last alert didn't reach the phone. ${phoneUnreachableAdvice(config.app.name)}.`);
        }
      }
      if (values.last) {
        const last = lastEvent(home);
        if (config?.transport !== "app" || !config.app) console.log("Last alert: --last needs the Code Alarm app; ntfy doesn't report back.");
        else if (!last) console.log("Last alert: none sent through the app yet.");
        else {
          const result = await fetchDelivery(config.app, last.id);
          const what = `${last.kind}/${last.level} "${last.label}" at ${clock(last.sentAt)}`;
          console.log(`Last alert: ${what}: ${result.ok ? describeDelivery(result.delivery) : `unknown, ${result.message}`}`);
        }
      }
      return 0;
    }

    case "done":
    case "needs-you":
    case "failed": {
      const kind: SignalKind = command === "needs-you" ? "needs_input" : command;
      const agent = detectAgent(process.env);
      const result = await runSignal(kind, agent, deps, sessionFromEnv(agent, process.env));
      console.log(result.message);
      return 0;
    }

    case "pair": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { name: { type: "string" }, relay: { type: "string" } },
      });
      const code = positionals[0];
      const relay = relayUrl(values.relay);
      const name = values.name?.trim() || defaultName();
      let existing: Config | null = null;
      try {
        existing = loadConfig(home);
      } catch {
        // A config that can't be read is replaced by the new pairing.
      }
      let app: AppConfig;
      if (code) {
        // The phone shows a code, and it's typed here.
        const result = await pairWithPhone(relay, code, name, Date.now());
        if (!result.ok) {
          console.log(`Couldn't pair: ${result.message}`);
          return 1;
        }
        app = result.app;
      } else {
        // This computer shows a QR, and the phone scans it and approves.
        const asked = await askToPair(relay, name);
        if (!asked.ok) {
          console.log(`Couldn't start pairing: ${asked.message}`);
          return 1;
        }
        const approved = await waitForPhone(asked.ask);
        if (!approved) return 1;
        app = approved;
      }
      // Pairing again replaces the old pairing, so the phone doesn't keep listing a dead entry.
      if (existing?.app && existing.app.senderId !== app.senderId) await unpairFromPhone(existing.app);
      saveConfig(home, { version: 1, transport: "app", app, ...(existing?.ntfy ? { ntfy: existing.ntfy } : {}) });
      console.log(`Paired. Your phone lists this computer as "${app.name}", and alerts now go through the Code Alarm app.`);
      refreshCodex(home);
      if (existing?.ntfy) console.log("Your ntfy settings are kept: `code-alarm use ntfy` switches back.");
      console.log("Check it with: code-alarm test");
      return 0;
    }

    case "unpair": {
      const config = loadConfig(home);
      if (!config?.app) {
        console.log("This computer isn't paired with the Code Alarm app.");
        return 0;
      }
      const result = await unpairFromPhone(config.app);
      if (config.ntfy) saveConfig(home, { version: 1, transport: "ntfy", ntfy: config.ntfy });
      else removeConfig(home);
      refreshCodex(home);
      console.log(
        result.ok
          ? "Unpaired: the phone no longer lists this computer."
          : `Unpaired here, but the relay didn't hear it (${result.detail}). Remove this computer in the app too.`,
      );
      console.log(config.ntfy ? "Alerts go through ntfy again." : "Nothing is set up now: `code-alarm pair <code>` or `code-alarm init` sets it up again.");
      return 0;
    }

    case "use": {
      const target = rest[0];
      if (target !== "ntfy" && target !== "app") throw new ConfigError("Usage: code-alarm use ntfy|app");
      const config = loadConfig(home);
      if (!config?.[target]) {
        console.log(target === "app" ? "Not paired with the app: run `code-alarm pair <code>`." : "ntfy isn't set up: run `code-alarm init`.");
        return 1;
      }
      saveConfig(home, { ...config, transport: target });
      console.log(`Alerts now go through ${target === "app" ? "the Code Alarm app" : "ntfy"}.`);
      refreshCodex(home);
      return 0;
    }

    case "install":
    case "uninstall": {
      if (rest[0] !== "codex") throw new ConfigError(`Usage: code-alarm ${command} codex`);
      const script = runningScript();
      if (command === "install") {
        if (!script) throw new ConfigError("Can't tell where this code-alarm script is.");
        for (const note of installCodex({ alarmHome: home, userHome: homedir(), bundle: script, now: Date.now() })) console.log(note);
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

const quiet = ["hook", "__send", "__wait"].includes(process.argv[2] ?? "");
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
