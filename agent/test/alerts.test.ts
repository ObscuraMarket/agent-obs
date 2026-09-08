import { test } from "node:test";
import assert from "node:assert/strict";
import { staleVerdict, cycleVerdict, dueNow, webhookRequest, alertRulesFromEnv, type AlertRow } from "../src/desk/alerts.ts";

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
  assert.deepEqual(alertRulesFromEnv({} as NodeJS.ProcessEnv), { webhook: "", staleMin: 10, cooldownMin: 30 });
  assert.deepEqual(alertRulesFromEnv({ OBS_ALERT_WEBHOOK: " https://ntfy.sh/x ", OBS_ALERT_STALE_MIN: "5", OBS_ALERT_COOLDOWN_MIN: "nope" } as NodeJS.ProcessEnv), { webhook: "https://ntfy.sh/x", staleMin: 5, cooldownMin: 30 });
});
