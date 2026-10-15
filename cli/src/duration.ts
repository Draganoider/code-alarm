export const HOUR = 3_600_000;
export const MINUTE = 60_000;
/** Arming longer than a day is almost certainly a mistake that would ring days later. */
export const MAX_ARM_MS = 24 * HOUR;

/** "2h", "90m", "1h30m", "45s" → milliseconds; null if it isn't a duration. */
export function parseDuration(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(trimmed);
  if (!match || trimmed === "") return null;
  const [, h, m, s] = match;
  const ms = Number(h ?? 0) * HOUR + Number(m ?? 0) * MINUTE + Number(s ?? 0) * 1000;
  return ms > 0 ? ms : null;
}

export function formatDuration(ms: number): string {
  if (ms < MINUTE) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const h = Math.floor(ms / HOUR);
  const m = Math.round((ms % HOUR) / MINUTE);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
