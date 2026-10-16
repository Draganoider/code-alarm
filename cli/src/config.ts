import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./fsutil.js";

export interface NtfyConfig {
  server: string;
  /** On a public ntfy server the topic name is the only lock, so it's long and random. */
  topic: string;
  /** Optional access token, for a protected topic or a self-hosted server. Never printed. */
  token?: string;
}

/** This computer's pairing with the Code Alarm app, through its relay (docs/protocol.md). */
export interface AppConfig {
  relay: string;
  deviceId: string;
  senderId: string;
  /** Rings the paired phone, and only that one. Never printed or logged. */
  token: string;
  /** How the phone lists this computer. */
  name: string;
  pairedAt: number;
}

export type Transport = "ntfy" | "app";

/** Both transports can be set up at once; `transport` says which one sends. Never both: that would ring twice. */
export interface Config {
  version: 1;
  transport: Transport;
  ntfy?: NtfyConfig;
  app?: AppConfig;
}

export class ConfigError extends Error {}

export const DEFAULT_NTFY_SERVER = "https://ntfy.sh";

export function configPath(home: string): string {
  return join(home, "config.json");
}

function readNtfy(value: unknown): NtfyConfig | undefined {
  const ntfy = value as Partial<NtfyConfig> | undefined;
  if (!ntfy || typeof ntfy.server !== "string" || typeof ntfy.topic !== "string") return undefined;
  return { server: ntfy.server, topic: ntfy.topic, ...(ntfy.token ? { token: ntfy.token } : {}) };
}

function readApp(value: unknown): AppConfig | undefined {
  const app = value as Partial<AppConfig> | undefined;
  if (!app) return undefined;
  for (const key of ["relay", "deviceId", "senderId", "token", "name"] as const) if (typeof app[key] !== "string") return undefined;
  return {
    relay: app.relay!,
    deviceId: app.deviceId!,
    senderId: app.senderId!,
    token: app.token!,
    name: app.name!,
    pairedAt: typeof app.pairedAt === "number" ? app.pairedAt : 0,
  };
}

export function loadConfig(home: string): Config | null {
  const path = configPath(home);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigError(`${path} isn't valid JSON. Fix it, or run \`code-alarm init --force\` to start over.`);
  }
  const config = raw as Partial<Config>;
  const ntfy = readNtfy(config.ntfy);
  const app = readApp(config.app);
  if (config.transport === "app" && app) return { version: 1, transport: "app", app, ...(ntfy ? { ntfy } : {}) };
  if (config.transport === "ntfy" && ntfy) return { version: 1, transport: "ntfy", ntfy, ...(app ? { app } : {}) };
  throw new ConfigError(`${path} is missing its ${config.transport === "app" ? "pairing" : "ntfy"} settings. Run \`code-alarm init --force\` or \`code-alarm pair\`.`);
}

export function saveConfig(home: string, config: Config): void {
  // Readable by the user only: the topic and the token are effectively passwords.
  writeFileAtomic(configPath(home), JSON.stringify(config, null, 2) + "\n", 0o600);
}

export function removeConfig(home: string): void {
  rmSync(configPath(home), { force: true });
}

/** e.g. "code-alarm-k3x9v0q2m8w4t7y1zr5b": 120 random bits, so nobody can guess it. */
export function newTopic(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(24);
  let suffix = "";
  for (let i = 0; i < 24; i++) suffix += alphabet[bytes[i]! % alphabet.length];
  return `code-alarm-${suffix}`;
}

export function isValidTopic(topic: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(topic);
}
