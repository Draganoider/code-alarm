import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Kind, Level } from "./events.js";
import { writeFileAtomic } from "./fsutil.js";

/**
 * Arming decides whether anything is sent at all: a session that isn't armed sends nothing
 * (DR-003). Each marker is its own small file, so hooks from parallel sessions never fight over
 * one shared file.
 */
export interface Arming {
  /** "project": one folder and everything under it, until its first end-of-task alert. "nap": every session, until it expires. */
  kind: "project" | "nap";
  /** How loud its alerts are. Older markers without it are "alarm". */
  level?: Level;
  dir?: string;
  armedAt: number;
  until: number;
}

export interface FoundArming extends Arming {
  key: string;
}

const NAP_KEY = "nap";

function normalize(dir: string, platform: NodeJS.Platform = process.platform): string {
  const full = resolve(dir);
  return platform === "win32" ? full.toLowerCase() : full;
}

function keyFor(dir: string): string {
  return createHash("sha256").update(normalize(dir)).digest("hex").slice(0, 16);
}

const armedDir = (home: string) => join(home, "armed");
const signalFile = (home: string, key: string) => join(home, "signaled", `${key}.json`);
const sentFile = (home: string, key: string, kind: string) => join(home, "sent", `${key}-${kind}.json`);

export function armProject(home: string, dir: string, until: number, now: number, level: Level = "alarm"): FoundArming {
  const arming: Arming = { kind: "project", level, dir: resolve(dir), armedAt: now, until };
  const key = keyFor(dir);
  writeFileAtomic(join(armedDir(home), `${key}.json`), JSON.stringify(arming));
  startFresh(home, key);
  return { ...arming, key };
}

export function armNap(home: string, until: number, now: number, level: Level = "alarm"): FoundArming {
  const arming: Arming = { kind: "nap", level, armedAt: now, until };
  writeFileAtomic(join(armedDir(home), `${NAP_KEY}.json`), JSON.stringify(arming));
  startFresh(home, NAP_KEY);
  return { ...arming, key: NAP_KEY };
}

/** A new arming starts clean: no signal and no rate limit carried over from the last one. */
function startFresh(home: string, key: string): void {
  clearSignaled(home, key);
  const dir = join(home, "sent");
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) if (file.startsWith(`${key}-`)) rmSync(join(dir, file), { force: true });
}

/** Every arming still in force, after deleting the expired ones. */
export function listArmings(home: string, now: number): FoundArming[] {
  const dir = armedDir(home);
  if (!existsSync(dir)) return [];
  const found: FoundArming[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    try {
      const arming = JSON.parse(readFileSync(path, "utf8")) as Arming;
      if (typeof arming.until !== "number" || arming.until <= now) {
        rmSync(path, { force: true });
        continue;
      }
      found.push({ ...arming, key: file.slice(0, -".json".length) });
    } catch {
      rmSync(path, { force: true });
    }
  }
  return found;
}

function contains(parent: string, child: string): boolean {
  const rel = relative(normalize(parent), normalize(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The arming that covers `cwd`: the closest armed folder at or above it, else a nap, else none. */
export function findArming(home: string, cwd: string, now: number): FoundArming | null {
  const armings = listArmings(home, now);
  let best: FoundArming | null = null;
  for (const arming of armings) {
    if (arming.kind !== "project" || !arming.dir || !contains(arming.dir, cwd)) continue;
    if (!best || (best.dir?.length ?? 0) < arming.dir.length) best = arming;
  }
  return best ?? armings.find((arming) => arming.kind === "nap") ?? null;
}

/**
 * A project arming is one-shot: its first end-of-task alert ends it. Claims it before sending, so
 * when two hooks race for it, only the one whose rename wins sends; false for the loser. A nap
 * runs until it expires, so it's never used up.
 */
export function claim(home: string, arming: FoundArming): boolean {
  if (arming.kind !== "project") return true;
  const path = join(armedDir(home), `${arming.key}.json`);
  const claimed = `${path}.${process.pid}.${Date.now()}.claimed`;
  try {
    renameSync(path, claimed);
  } catch {
    return false;
  }
  rmSync(claimed, { force: true });
  return true;
}

export function disarmProject(home: string, dir: string): boolean {
  const path = join(armedDir(home), `${keyFor(dir)}.json`);
  const existed = existsSync(path);
  rmSync(path, { force: true });
  return existed;
}

export function disarmAll(home: string): number {
  const dir = armedDir(home);
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  for (const file of files) rmSync(join(dir, file), { force: true });
  return files.length;
}

/**
 * Where "signalled this turn" is kept: per agent session, so one session's signal never silences
 * another's Stop, whichever arming each one finds. Without a session ID, per arming.
 */
export function signalKey(armingKey: string, sessionId?: string): string {
  return sessionId ? `session-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}` : armingKey;
}

/** The agent sent an explicit signal this turn, so the Stop hook mustn't add a vague "stopped". */
export function markSignaled(home: string, key: string, now: number, kind: Kind): void {
  writeFileAtomic(signalFile(home, key), JSON.stringify({ at: now, kind }));
}

export function isSignaled(home: string, key: string): boolean {
  return existsSync(signalFile(home, key));
}

/** Which signal the agent already sent this turn, if any. */
export function signaledKind(home: string, key: string): Kind | null {
  try {
    const { kind } = JSON.parse(readFileSync(signalFile(home, key), "utf8")) as { kind?: Kind };
    return kind ?? null;
  } catch {
    return null;
  }
}

export function clearSignaled(home: string, key: string): void {
  rmSync(signalFile(home, key), { force: true });
}

/** True if `kind` was already sent for this arming within `windowMs`; otherwise records it as sent now. */
export function rateLimited(home: string, key: string, kind: string, now: number, windowMs: number): boolean {
  const path = sentFile(home, key, kind);
  try {
    const { at } = JSON.parse(readFileSync(path, "utf8")) as { at: number };
    if (typeof at === "number" && now - at < windowMs) return true;
  } catch {
    // Never sent, or unreadable: treat as not sent.
  }
  mkdirSync(join(home, "sent"), { recursive: true });
  writeFileAtomic(path, JSON.stringify({ at: now }));
  return false;
}
