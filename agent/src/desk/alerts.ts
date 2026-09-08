// The desk's own alarm. Three things a person must hear about the moment they happen, because each one was
// found late once: the live watch going quiet (a hung loop is a silent hold), a cycle that could not think (the
// model outage of 2026-09-07 reached only the log), and an exit the chain refused (a position the rails wanted
// out of and could not sell). An alert is a ledger row, a line in the log, and a post to OBS_ALERT_WEBHOOK when
// one is set: a Discord or Slack webhook, or an ntfy topic, by the URL's host. The same kind is raised once per
// cooldown, so a long outage is one message, not one a minute. The health route carries the latest alerts, so an
// outside uptime check can read "stale" off it without any of this.
import { appendLedger, readLedger } from "../ledger.ts";
import { DRY } from "../config.ts";

export type AlertKind = "stale" | "cycle" | "exit";
export interface AlertRow { at: number; kind: AlertKind; text: string }
export interface AlertRules {
  /** Where an alert is posted; empty means the ledger and the log only. */
  webhook: string;
  /** The live watch is stale after this many minutes without a look (OBS_ALERT_STALE_MIN). */
  staleMin: number;
  /** One alert of a kind per this many minutes (OBS_ALERT_COOLDOWN_MIN). */
  cooldownMin: number;
}
export const ALERTS_LEDGER = "obs-alerts.jsonl";

export function alertRulesFromEnv(env: NodeJS.ProcessEnv = process.env): AlertRules {
  const n = (k: string, d: number) => { const v = Number(env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  return { webhook: (env.OBS_ALERT_WEBHOOK ?? "").trim(), staleMin: n("OBS_ALERT_STALE_MIN", 10), cooldownMin: n("OBS_ALERT_COOLDOWN_MIN", 30) };
}

/** PURE: the live watch's silence as a reason, or null while it is looking. A watch that never wrote is not stale: it has not started. */
export function staleVerdict(liveAt: number | null, now: number, staleMin: number): string | null {
  if (liveAt == null) return null;
  const min = (now - liveAt) / 60e3;
  if (min < staleMin) return null;
  return `the live watch has not looked in ${Math.floor(min)} min (its last look was ${new Date(liveAt).toISOString().slice(11, 16)} UTC); nothing is being reviewed or entered until it is back`;
}

/** PURE: a failed cycle's exit as a reason; a clean exit is null. The last error line the cycle printed says why. */
export function cycleVerdict(code: number | null, lastError: string | null): string | null {
  if (code === 0) return null;
  const why = lastError ? lastError.replace(/^\[desk\]\s*/, "").slice(0, 200) : "no error line";
  return `a desk cycle failed (exit ${code ?? "?"}): ${why}`;
}

/** PURE: whether a kind may be raised now, given when it last was. */
export function dueNow(kind: AlertKind, rows: AlertRow[], now: number, cooldownMin: number): boolean {
  const last = rows.filter((r) => r.kind === kind).map((r) => r.at).sort().pop();
  return last == null || now - last >= cooldownMin * 60e3;
}

/** PURE: the request a webhook takes, by its host: Discord and Slack want JSON, anything else (ntfy, a plain hook) gets text. */
export function webhookRequest(url: string, text: string): { headers: Record<string, string>; body: string } {
  const msg = `Agent OBS: ${text}`;
  let host = "";
  try { host = new URL(url).host.toLowerCase(); } catch { /* an unparsable URL still gets the plain body */ }
  if (host.endsWith("discord.com") || host.endsWith("discordapp.com")) return { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: msg.slice(0, 1900) }) };
  if (host.endsWith("slack.com")) return { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: msg }) };
  return { headers: { "Content-Type": "text/plain", Title: "Agent OBS", Priority: "high" }, body: text };
}

export function readAlerts(): AlertRow[] {
  return readLedger<AlertRow>(ALERTS_LEDGER).filter((r) => r && typeof r.at === "number" && typeof r.text === "string");
}

/** The alerts of the last day, newest last, for the health route. */
export function recentAlerts(now = Date.now(), hours = 24): AlertRow[] {
  return readAlerts().filter((r) => now - r.at <= hours * 3600e3).slice(-20);
}

/**
 * Raise an alert: once per kind per cooldown, to the ledger, the log and the webhook. Never throws; a webhook that
 * is down is a log line, not a failure of the desk. Returns whether it went out.
 */
export async function raiseAlert(kind: AlertKind, text: string, now = Date.now(), rules: AlertRules = alertRulesFromEnv(), fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (DRY) return false;
  if (!dueNow(kind, readAlerts(), now, rules.cooldownMin)) return false;
  appendLedger(ALERTS_LEDGER, { at: now, kind, text });
  console.error(`[alert] ${kind}: ${text}`);
  if (!rules.webhook) return true;
  try {
    const { headers, body } = webhookRequest(rules.webhook, text);
    const r = await fetchFn(rules.webhook, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) console.error(`[alert] the webhook answered ${r.status}`);
  } catch (e) {
    console.error(`[alert] the webhook could not be reached: ${e instanceof Error ? e.message : String(e)}`);
  }
  return true;
}
