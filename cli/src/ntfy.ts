import type { NtfyConfig } from "./config.js";
import { type AlarmEvent, type Kind, agentName } from "./events.js";

/**
 * ntfy is the transport until the Code Alarm app's own relay exists (M2). Published as JSON to the
 * server root, so labels with any characters are safe (HTTP headers can't carry them).
 * https://docs.ntfy.sh/publish/#publish-as-json
 */
const TEXT: Record<Kind, { title: string; message: (agent: string) => string; tags: string[] }> = {
  done: { title: "Done", message: (a) => `${a} finished the task.`, tags: ["white_check_mark"] },
  needs_input: { title: "Needs you", message: (a) => `${a} is waiting for your answer or approval.`, tags: ["raising_hand"] },
  failed: { title: "Failed", message: (a) => `${a} stopped on an error.`, tags: ["x"] },
  stopped: { title: "Stopped", message: (a) => `${a} stopped. It may be done, or waiting for you.`, tags: ["warning"] },
  test: { title: "Test alarm", message: () => "If your phone rang loudly, Code Alarm is set up.", tags: ["bell"] },
};

export interface NtfyRequest {
  url: string;
  init: { method: "POST"; headers: Record<string, string>; body: string };
}

export function ntfyRequest(event: AlarmEvent, config: NtfyConfig): NtfyRequest {
  const text = TEXT[event.kind];
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  return {
    url: `${config.server.replace(/\/+$/, "")}/`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({
        topic: config.topic,
        title: event.kind === "test" ? text.title : `${text.title}: ${event.label}`,
        message: text.message(agentName(event.agent)),
        // 5 ("max") is the alarm: the ntfy app keeps alerting until dismissed, through Do Not
        // Disturb if the subscription allows it. 4 ("high") is a normal notification that pops up
        // with sound and vibration, once. 3 ("default") often arrives silently, without a pop-up.
        priority: event.level === "notify" ? 4 : 5,
        tags: text.tags,
      }),
    },
  };
}

export interface SendResult {
  ok: boolean;
  detail: string;
}

export async function sendNtfy(
  event: AlarmEvent,
  config: NtfyConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<SendResult> {
  const { url, init } = ntfyRequest(event, config);
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? { ok: true, detail: `HTTP ${res.status}` } : { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.name : "error" };
  }
}
