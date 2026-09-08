import { test } from "node:test";
import assert from "node:assert/strict";
import { traderBlock, traderPrompt, TRADER_FORMS } from "../src/social/traderVoice.ts";

const T = Date.UTC(2026, 8, 7, 23, 40);

test("the desk block carries only the desk's own numbers: equity, the record, the book, today's closes, the watch, the thoughts", () => {
  const block = traderBlock({
    equityUsd: 1727.4, realizedUsd: 714.2,
    positions: [{ asset: "LENNY", valueUsd: 182, unrealizedPct: -8.8, ageH: 0.6 }],
    closesToday: [
      { at: T - 3600e3, symbol: "PENGUIN", realizedUsd: 13.4, realizedPct: 6.7, exitKind: "trail", holdH: 0.03 },
      { at: T - 1800e3, symbol: "ONBOARD", realizedUsd: -38.1, realizedPct: -19.4, exitKind: "floor", holdH: 2.9 },
    ],
    record: "22 wins and 7 losses, +$678 realized",
    thoughts: [{ at: T - 600e3, text: "every read passed LENNY this cycle; the floor at -30% is the invalidation.", decision: "propose-swap" }],
    watching: [{ symbol: "LUDES", role: "watch", entryState: "waiting", trend: "holding", why: "ran +52% to a peak 162 min ago" }],
    now: T,
  });
  assert.match(block, /^- equity \$1727; realized since the start \$714; the time is 23:40 UTC\n- the record: 22 wins and 7 losses/);
  assert.match(block, /- holding LENNY: \$182 \(-8\.8%\), held 0\.6 h/);
  assert.match(block, /- closed today: 2 \(1 won\), net -\$24\.70/);
  assert.match(block, /22:40 UTC PENGUIN: \$13\.40 \(\+6\.7%\) after 0\.0 h, out on the trailing stop/);
  assert.match(block, /ONBOARD: -\$38\.10 \(-19\.4%\) after 2\.9 h, out on the floor/);
  assert.match(block, /- watching: LUDES \(waiting, tape holding: ran \+52% to a peak 162 min ago\)/);
  assert.match(block, /\[propose-swap\] every read passed LENNY/);
  assert.ok(!block.includes("—"));
});

test("an empty desk says so, and the prompt hands the model the block, the memory, the form and the hard rules", () => {
  const block = traderBlock({ equityUsd: null, realizedUsd: 0, positions: [], closesToday: [], record: "no closes yet", thoughts: [], watching: [], now: T });
  assert.match(block, /holding nothing but ETH right now/);
  assert.match(block, /closed today: nothing yet/);
  const p = traderPrompt({ handle: "AgentOBS", block, journal: "I said the trail was tight.", recent: ["one from before"], performance: "", form: TRADER_FORMS[0], maxChars: 280 });
  assert.match(p, /^You are Agent OBS, the trading desk, posting on X as @AgentOBS in the first person/);
  assert.match(p, /the only numbers you may cite/);
  assert.match(p, /I said the trail was tight\./);
  assert.match(p, /- one from before/);
  assert.match(p, /A TRADE NOTE\./);
  assert.match(p, /never tell anyone to buy or sell/);
  assert.match(p, /HARD LIMIT: 280 characters/);
  assert.match(p, /reply with PASS on the first line/);
  assert.equal(TRADER_FORMS.length, 7);
  assert.ok(!p.includes("—"));
});
