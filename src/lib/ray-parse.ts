// Ray ID lookup: the Ray ID and the window searched. Pure functions, shared by server and client (and
// the unit tests) — no Node imports.

/** A Ray ID: 16 hex characters, optionally with the data center ("-AMS"). */
const RAY = /^([0-9a-f]{16})(?:-[a-z]{3,4})?$/i;
/** The 16-character Ray ID (Cloudflare's rayName), or null. */
export function parseRay(v: string): string | null {
  const m = RAY.exec(v.trim());
  return m ? m[1].toLowerCase() : null;
}

/** One query covers at most a day: every plan's single-request datasets allow that range. */
export const SLICE_MS = 24 * 3600_000;
/** Every plan keeps the adaptive datasets for at least 31 days. */
const KEPT_MS = 31 * 86_400_000 - 120_000;

/** The window: back from now, or centred on `at`, never older than Cloudflare keeps; in days, newest first. Throws with the reason. */
export function rayWindow(hours: number, at?: string, now = Date.now()) {
  let since: number, until: number;
  if (at) {
    const t = Date.parse(at);
    if (Number.isNaN(t)) throw new Error('Not a time (use ISO 8601, e.g. 2026-10-31T14:05:00Z)');
    since = t - (hours * 3600_000) / 2; until = Math.min(now, t + (hours * 3600_000) / 2);
  } else { until = now; since = now - hours * 3600_000; }
  since = Math.max(since, now - KEPT_MS);
  if (since >= until) throw new Error('Cloudflare keeps single requests and security events for about 31 days — choose a later time');
  const slices: { since: string; until: string }[] = [];
  for (let end = until; end > since; end -= SLICE_MS) slices.push({ since: new Date(Math.max(since, end - SLICE_MS)).toISOString(), until: new Date(end).toISOString() });
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString(), slices };
}
