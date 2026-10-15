import { ConfigError, type AppConfig } from "./config.js";
import type { AlarmEvent } from "./events.js";
import type { SendResult } from "./ntfy.js";

/**
 * The Code Alarm app's transport: events go to the relay, which pushes them to the paired phone
 * (docs/protocol.md). The request body is the event itself and nothing else; the token goes only in
 * the Authorization header.
 */

/** The Code Alarm relay. `pair --relay <url>` or CODE_ALARM_RELAY points a pairing elsewhere (a local test relay). */
export const DEFAULT_RELAY = "https://relay.codealarm.workers.dev";
export const RELAY_ENV = "CODE_ALARM_RELAY";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The relay to pair with: HTTPS, except on this computer (a local test relay). */
export function relayUrl(given: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const raw = given ?? (env[RELAY_ENV] || DEFAULT_RELAY);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${raw} isn't a URL.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new ConfigError("The relay must be an https:// address: the token travels with every request.");
  }
  if (url.search || url.hash || url.username || url.password) throw new ConfigError("The relay address takes no query, fragment or credentials.");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** How the phone lists this computer when `pair` gets no --name. Never the hostname: it would leave the computer. */
export function defaultName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "Windows PC" : platform === "darwin" ? "Mac" : platform === "linux" ? "Linux computer" : "Computer";
}

const TIMEOUT_MS = 10_000;

interface RelayRequest {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string };
}

interface RelayAnswer {
  status: number;
  body: Record<string, unknown>;
}

async function call(request: RelayRequest, fetchImpl: typeof fetch, timeoutMs: number): Promise<RelayAnswer> {
  const res = await fetchImpl(request.url, { ...request.init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: a proxy's error page, say. The status says enough.
  }
  return { status: res.status, body };
}

const message = (answer: RelayAnswer) =>
  typeof answer.body.message === "string" ? answer.body.message : `the relay answered HTTP ${answer.status}`;

/** What `pair` sends: the code typed from the phone, and the name to list this computer under. */
export function pairRequest(relay: string, code: string, name: string): RelayRequest {
  return {
    url: `${relay}/v1/pair`,
    init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name }) },
  };
}

export type PairResult = { ok: true; app: AppConfig } | { ok: false; message: string };

export async function pairWithPhone(relay: string, code: string, name: string, now: number, fetchImpl: typeof fetch = fetch): Promise<PairResult> {
  let answer: RelayAnswer;
  try {
    answer = await call(pairRequest(relay, code, name), fetchImpl, TIMEOUT_MS);
  } catch (e) {
    return { ok: false, message: `couldn't reach the relay at ${relay} (${e instanceof Error ? e.name : "error"})` };
  }
  const { sender_id, token, device_id, name: listedAs } = answer.body;
  if (answer.status !== 201 || typeof sender_id !== "string" || typeof token !== "string" || typeof device_id !== "string") {
    return { ok: false, message: message(answer) };
  }
  return {
    ok: true,
    app: { relay, deviceId: device_id, senderId: sender_id, token, name: typeof listedAs === "string" ? listedAs : name, pairedAt: now },
  };
}

/** The event request. Its body is exactly the event: nothing else reaches the relay (hard rule 1). */
export function appRequest(event: AlarmEvent, app: AppConfig): RelayRequest {
  return {
    url: `${app.relay}/v1/events`,
    init: {
      method: "POST",
      headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json" },
      body: JSON.stringify(event),
    },
  };
}

/**
 * Sends one event. A network error or a failed push is retried once with the same ID: the relay
 * dedupes by ID, so a retry can never ring twice.
 */
export async function sendApp(
  event: AlarmEvent,
  app: AppConfig,
  fetchImpl: typeof fetch = fetch,
  options: { timeoutMs?: number; retryDelayMs?: number } = {},
): Promise<SendResult> {
  const { timeoutMs = TIMEOUT_MS, retryDelayMs = 3000 } = options;
  let result: SendResult = { ok: false, detail: "not sent" };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((done) => setTimeout(done, retryDelayMs));
    let answer: RelayAnswer;
    try {
      answer = await call(appRequest(event, app), fetchImpl, timeoutMs);
    } catch (e) {
      result = { ok: false, detail: `relay unreachable (${e instanceof Error ? e.name : "error"})` };
      continue;
    }
    if (answer.status === 200 && answer.body.status === "duplicate") return { ok: true, detail: "app: already sent" };
    if (answer.status === 200) {
      return { ok: true, detail: answer.body.limited ? "app: sent as a notification (rate limit)" : "app: sent" };
    }
    if (answer.status === 401) return { ok: false, detail: "this computer isn't paired any more: run `code-alarm pair`" };
    result = { ok: false, detail: `app: ${typeof answer.body.error === "string" ? answer.body.error : `HTTP ${answer.status}`}` };
    if (answer.status !== 502) return result;
  }
  return result;
}

/** Removes this computer from the phone's list. Already gone counts as done. */
export async function unpairFromPhone(app: AppConfig, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  try {
    const answer = await call(
      { url: `${app.relay}/v1/senders/${encodeURIComponent(app.senderId)}`, init: { method: "DELETE", headers: { authorization: `Bearer ${app.token}` } } },
      fetchImpl,
      TIMEOUT_MS,
    );
    if (answer.status === 204) return { ok: true, detail: "removed" };
    if (answer.status === 401 || answer.status === 404) return { ok: true, detail: "already removed" };
    return { ok: false, detail: message(answer) };
  } catch (e) {
    return { ok: false, detail: `couldn't reach the relay (${e instanceof Error ? e.name : "error"})` };
  }
}

export interface Delivery {
  status: string;
  detail?: string | null;
  sent_at: number;
  ringing_at?: number | null;
  ended_at?: number | null;
}

export type DeliveryResult = { ok: true; delivery: Delivery } | { ok: false; message: string };

/** What happened to one event, from the relay and the phone's acks. */
export async function fetchDelivery(app: AppConfig, id: string, fetchImpl: typeof fetch = fetch): Promise<DeliveryResult> {
  try {
    const answer = await call(
      { url: `${app.relay}/v1/events/${encodeURIComponent(id)}`, init: { method: "GET", headers: { authorization: `Bearer ${app.token}` } } },
      fetchImpl,
      TIMEOUT_MS,
    );
    if (answer.status !== 200 || typeof answer.body.status !== "string" || typeof answer.body.sent_at !== "number") {
      return { ok: false, message: answer.status === 404 ? "the relay has no record of it (it keeps a week)" : message(answer) };
    }
    return { ok: true, delivery: answer.body as unknown as Delivery };
  } catch (e) {
    return { ok: false, message: `couldn't reach the relay (${e instanceof Error ? e.name : "error"})` };
  }
}

const seconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;

/** One line for `status --last`. Times compare this computer's clock with the phone's, so they're approximate. */
export function describeDelivery(d: Delivery): string {
  const rang = d.ringing_at ? `${seconds(d.ringing_at - d.sent_at)} after the alert was sent` : "";
  switch (d.status) {
    case "sending":
    case "sent":
      return "sent to the phone; it hasn't answered yet (it may be off, or offline)";
    case "failed":
      return `not delivered${d.detail ? `: ${d.detail}` : ""}`;
    case "received":
      return "received by the phone";
    case "ringing":
      return `ringing, ${rang}`;
    case "notified":
      return `shown as a notification, ${rang}`;
    case "snoozed":
      return `snoozed; it rang ${rang}`;
    case "stopped":
      return `rang ${rang}${d.ended_at && d.ringing_at ? `, stopped after ${seconds(d.ended_at - d.ringing_at)}` : ""}`;
    case "expired":
      return "the phone got it after it expired, so it stayed silent";
    case "duplicate":
      return "the phone had already had it, so it stayed silent";
    default:
      return d.status;
  }
}
