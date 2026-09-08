// The desk's own alarm. Four things a person must hear about the moment they happen, because each one was
// found late once: the live watch going quiet (a hung loop is a silent hold), a cycle that could not think (the
// model outage of 2026-09-07 reached only the log), an exit the chain refused (a position the rails wanted
// out of and could not sell), and the memory backup failing (a refused push was silent and, once the memory
// repo had diverged, permanent, 2026-09-08). An alert is a ledger row, a line in the log, and a post to
// OBS_ALERT_WEBHOOK when one is set: a Discord or Slack webhook, or an ntfy topic, by the URL's host. The same
// kind is raised once per cooldown, so a long outage is one message, not one a minute. The health route carries
// the latest alerts, so an outside uptime check can read "stale" off it without any of this.
import { existsSync, readFileSync } from "node:fs";
import { appendLedger, readLedger } from "../ledger.ts";
import { DRY, dataPath } from "../config.ts";

export type AlertKind = "stale" | "cycle" | "exit" | "backup";
export interface AlertRow { at: number; kind: AlertKind; text: string }
/** What scripts/_obs-backup.sh leaves behind while its last run failed: when, which step, and what git said. */
export interface BackupFailure { at: number; step: string; error: string }
/** The marker file, in the data directory; absent while the last backup landed. */
export const BACKUP_FAILED_FILE = "obs-backup-failed.json";
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

/** PURE: the backup's marker as a record, or null for no file, a broken one, or one without a step. A missing or unreadable "at" is 0, never a throw. */
export function parseBackupFailure(raw: string | null | undefined): BackupFailure | null {
  if (!raw || !raw.trim()) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.step !== "string" || !o.step.trim()) return null;
  const at = typeof o.at === "number" && Number.isFinite(o.at) ? o.at : typeof o.at === "string" ? Date.parse(o.at) : NaN;
  return { at: Number.isFinite(at) ? at : 0, step: o.step.trim(), error: typeof o.error === "string" ? o.error.trim() : "" };
}

/** PURE: a failed backup as a reason, or null while the last one landed. Says the step, how long ago, and what git said. */
export function backupVerdict(f: BackupFailure | null, now: number): string | null {
  if (!f) return null;
  const ago = f.at > 0 ? `${Math.max(0, Math.floor((now - f.at) / 60e3))} min ago` : "at an unknown time";
  const why = f.error ? f.error.slice(0, 300) : "no error text";
  return `the memory backup failed at its ${f.step} step ${ago}: ${why}; the ledgers are not leaving this machine until it is fixed (FORCE=1 bash scripts/_obs-backup.sh retries now)`;
}

/** The backup marker off the data directory; null when there is none. */
export function readBackupFailure(): BackupFailure | null {
  const p = dataPath(BACKUP_FAILED_FILE);
  if (!existsSync(p)) return null;
  try { return parseBackupFailure(readFileSync(p, "utf8")); } catch { return null; }
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
