import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./fsutil.js";

export interface NtfyConfig {
  server: string;
  /** On a public ntfy server the topic name is the only lock, so it's long and random. */
  topic: string;
  /** Optional access token, for a protected topic or a self-hosted server. Never printed. */
  token?: string;
}

export interface Config {
  version: 1;
  transport: "ntfy";
  ntfy: NtfyConfig;
}

export class ConfigError extends Error {}

export const DEFAULT_NTFY_SERVER = "https://ntfy.sh";

export function configPath(home: string): string {
  return join(home, "config.json");
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
  const ntfy = config.ntfy;
  if (config.transport !== "ntfy" || !ntfy || typeof ntfy.server !== "string" || typeof ntfy.topic !== "string") {
    throw new ConfigError(`${path} is missing its ntfy settings. Run \`code-alarm init --force\`.`);
  }
  return { version: 1, transport: "ntfy", ntfy: { server: ntfy.server, topic: ntfy.topic, ...(ntfy.token ? { token: ntfy.token } : {}) } };
}

export function saveConfig(home: string, config: Config): void {
  // Readable by the user only: the topic is effectively a password on a public server.
  writeFileAtomic(configPath(home), JSON.stringify(config, null, 2) + "\n", 0o600);
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
