import { test } from "node:test";
import assert from "node:assert/strict";
import { staleVerdict, cycleVerdict, dueNow, webhookRequest, alertRulesFromEnv, parseBackupFailure, backupVerdict, backupAgeVerdict, BACKUP_FAILED_FILE, type AlertRow } from "../src/desk/alerts.ts";

const T0 = Date.UTC(2026, 8, 8, 1, 0);

test("the live watch is stale once it has been quiet past the bar, and a watch that never wrote is not stale", () => {
  assert.equal(staleVerdict(T0 - 9 * 60e3, T0, 10), null);
  assert.match(staleVerdict(T0 - 12 * 60e3, T0, 10) ?? "", /^the live watch has not looked in 12 min \(its last look was 00:48 UTC\); nothing is being reviewed or entered until it is back$/);
  assert.equal(staleVerdict(null, T0, 10), null, "no heartbeat file yet is a watch that has not started, not one that died");
});

test("a failed cycle is raised with the last error line it printed; a clean exit is nothing", () => {
  assert.equal(cycleVerdict(0, "[desk] something printed"), null);
  assert.equal(cycleVerdict(1, "[desk] OBS could not think this cycle: the gateway timed out after 90 s"), "a desk cycle failed (exit 1): OBS could not think this cycle: the gateway timed out after 90 s");
  assert.equal(cycleVerdict(null, null), "a desk cycle failed (exit ?): no error line");
});

test("one alert of a kind per cooldown; another kind is not held back", () => {
  const rows: AlertRow[] = [{ at: T0 - 10 * 60e3, kind: "stale", text: "quiet" }];
  assert.equal(dueNow("stale", rows, T0, 30), false);
  assert.equal(dueNow("stale", rows, T0 + 25 * 60e3, 30), true);
  assert.equal(dueNow("exit", rows, T0, 30), true);
  assert.equal(dueNow("cycle", [], T0, 30), true);
});

test("a failed backup is raised once per cooldown while its marker stays, and the other kinds are not held back by it", () => {
  const rows: AlertRow[] = [{ at: T0 - 10 * 60e3, kind: "backup", text: "refused" }];
  assert.equal(dueNow("backup", rows, T0, 30), false, "the marker is still there ten minutes later; that is the same failure, not a new message");
  assert.equal(dueNow("backup", rows, T0 + 30 * 60e3, 30), true);
  assert.equal(dueNow("backup", [], T0, 30), true);
  assert.equal(dueNow("stale", rows, T0, 30), true);
});

test("the backup marker is read as the script writes it, and anything else is no marker", () => {
  assert.equal(BACKUP_FAILED_FILE, "obs-backup-failed.json");
  const line = `{"at":${T0},"step":"push","error":"! [rejected] main -> main (fetch first) (the pull before it failed too: CONFLICT (content): obs-book.jsonl)"}\n`;
  assert.deepEqual(parseBackupFailure(line), { at: T0, step: "push", error: "! [rejected] main -> main (fetch first) (the pull before it failed too: CONFLICT (content): obs-book.jsonl)" });
  assert.deepEqual(parseBackupFailure('{"at":"2026-09-08T01:00:00.000Z","step":" copy ","error":""}'), { at: T0, step: "copy", error: "" }, "an ISO time is taken too, and the step is trimmed");
  assert.deepEqual(parseBackupFailure('{"step":"commit","error":"nothing"}'), { at: 0, step: "commit", error: "nothing" }, "no time is zero, never a throw");
  assert.equal(parseBackupFailure(null), null);
  assert.equal(parseBackupFailure(""), null);
  assert.equal(parseBackupFailure("{not json"), null);
  assert.equal(parseBackupFailure('{"at":1,"error":"no step"}'), null, "a marker without a step says nothing a person can act on");
  assert.equal(parseBackupFailure("[]"), null);
});

test("a failed backup is worded with its step, its age and what git said; a landed one is nothing", () => {
  assert.equal(backupVerdict(null, T0), null);
  assert.equal(
    backupVerdict({ at: T0 - 7 * 60e3, step: "push", error: "! [rejected] main -> main (fetch first)" }, T0),
    "the memory backup failed at its push step 7 min ago: ! [rejected] main -> main (fetch first); the ledgers are not leaving this machine until it is fixed (FORCE=1 bash scripts/_obs-backup.sh retries now)",
  );
  assert.match(backupVerdict({ at: 0, step: "commit", error: "" }, T0) ?? "", /^the memory backup failed at its commit step at an unknown time: no error text;/);
  assert.match(backupVerdict({ at: T0 + 60e3, step: "push", error: "x" }, T0) ?? "", /push step 0 min ago/, "a clock ahead of the server is not a negative age");
  const long = backupVerdict({ at: T0, step: "push", error: "e".repeat(500) }, T0) ?? "";
  assert.ok(long.includes("e".repeat(300)) && !long.includes("e".repeat(301)), "git's error is cut to what a message can carry");
});

test("the webhook gets JSON for Discord and Slack and plain text for anything else", () => {
  const d = webhookRequest("https://discord.com/api/webhooks/1/abc", "the desk could not sell RWA");
  assert.equal(d.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(d.body), { content: "Agent OBS: the desk could not sell RWA" });
  const s = webhookRequest("https://hooks.slack.com/services/T/B/x", "quiet");
  assert.deepEqual(JSON.parse(s.body), { text: "Agent OBS: quiet" });
  const n = webhookRequest("https://ntfy.sh/obs-desk", "quiet");
  assert.equal(n.headers["Content-Type"], "text/plain");
  assert.equal(n.headers.Title, "Agent OBS");
  assert.equal(n.body, "quiet");
  assert.equal(webhookRequest("not a url", "x").body, "x", "an unparsable URL still gets the plain body");
});

test("the rules come from the environment with the defaults a desk needs", () => {
  assert.deepEqual(alertRulesFromEnv({} as NodeJS.ProcessEnv), { webhook: "", staleMin: 10, cooldownMin: 30, backupMaxAgeMin: 180 });
  assert.deepEqual(alertRulesFromEnv({ OBS_ALERT_WEBHOOK: " https://ntfy.sh/x ", OBS_ALERT_STALE_MIN: "5", OBS_ALERT_COOLDOWN_MIN: "nope" } as NodeJS.ProcessEnv), { webhook: "https://ntfy.sh/x", staleMin: 5, cooldownMin: 30, backupMaxAgeMin: 180 });
});

test("an alert with a key is due per thing, not per kind: one agent's refused exit no longer silences another's", () => {
  const T = Date.UTC(2026, 8, 8, 15, 0, 0);
  const rows = [{ at: T, kind: "exit" as const, text: "wallet a, PORT", key: "0xa PORT" }];
  assert.equal(dueNow("exit", rows, T + 60e3, 30, "0xa PORT"), false, "the same wallet and token waits out the cooldown");
  assert.equal(dueNow("exit", rows, T + 60e3, 30, "0xb PORT"), true, "another wallet's exit of the same token goes out");
  assert.equal(dueNow("exit", rows, T + 60e3, 30, "0xa ECHELON"), true, "the same wallet's other token goes out");
  assert.equal(dueNow("exit", rows, T + 60e3, 30), false, "without a key the kind's last alert still counts");
});

test("a backup's age is a reason once it is past the bar, from never on a fresh volume, and nothing where backups are not configured", () => {
  const T = Date.UTC(2026, 8, 8, 15, 0, 0);
  assert.equal(backupAgeVerdict(T - 100 * 60e3, T, 180, true), null, "100 minutes is inside a 180-minute bar");
  assert.match(backupAgeVerdict(T - 230 * 60e3, T, 180, true) ?? "", /last landed 230 min ago, past the 180 min bar/);
  assert.match(backupAgeVerdict(null, T, 180, true) ?? "", /no memory backup has landed on this volume yet/);
  assert.equal(backupAgeVerdict(null, T, 180, false), null, "a machine without backups configured has nothing to say");
});
