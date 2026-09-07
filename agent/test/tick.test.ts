import { test } from "node:test";
import assert from "node:assert/strict";
import { entryVeto } from "../src/desk/autoentry.ts";
import { tickChoice } from "../src/desk/model.ts";

test("a fast tick asks the rails before it thinks: a full book, a fresh entry or an open order is a think saved", () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0);
  const base = { symbol: "PLEDGE", held: [] as string[], maxCandidates: 2, lastEntryAt: null as number | null, minHoursBetweenEntries: 0.5, openOrders: 0, maxOpenOrders: 2, now };
  assert.equal(entryVeto(base), null, "nothing in the way: think");
  assert.match(entryVeto({ ...base, held: ["NSDX", "TALES"] }) ?? "", /already holding NSDX, TALES; 2 launch positions at a time/);
  assert.equal(entryVeto({ ...base, held: ["NSDX", "PLEDGE"] }), null, "adding to a token already held is a continuation, not vetoed here");
  assert.match(entryVeto({ ...base, lastEntryAt: now - 10 * 60e3 }) ?? "", /the last entry was 10 min ago; entries are at least 0.5h apart/);
  assert.equal(entryVeto({ ...base, lastEntryAt: now - 40 * 60e3 }), null);
  assert.match(entryVeto({ ...base, openOrders: 2 }) ?? "", /2 order\(s\) already open; the limit is 2/);
});

test("the fast persona is the desk's sibling on a cheaper model, and off is off", () => {
  assert.deepEqual(tickChoice({} as NodeJS.ProcessEnv), { agentId: "obs-fast", model: "deepseek/deepseek-v4-flash-0731" });
  assert.deepEqual(tickChoice({ OBS_TICK_MODEL: "google/gemini-3.8-flash", OBS_TICK_AGENT_ID: "obs-quick" } as NodeJS.ProcessEnv), { agentId: "obs-quick", model: "google/gemini-3.8-flash" });
  assert.equal(tickChoice({ OBS_TICK_MODEL: "off" } as NodeJS.ProcessEnv), null);
  assert.equal(tickChoice({ OBS_TICK_MODEL: "  " } as NodeJS.ProcessEnv), null);
});
