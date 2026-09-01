// One desk cycle: read the world, mark the book, hand the operator persona a
// measured observation, record his public thoughts and his decision, snapshot
// equity. Meant to run on a timer (launchd, see scripts/). DRY_RUN=1 runs the
// model call and writes nothing.
//
// Execution is NOT here. A swap decision becomes a proposal row in the trade
// ledger, visible on the dashboard as exactly that, and nothing moves until
// the execution stage exists and the operator arms it.
import { GatewayClient } from "@openhermit/sdk";
import { AGENT_ID, DRY } from "../config.ts";
import { liveReads, assetPrices } from "../obscura/reads.ts";
import { quoteWatchlist } from "../obscura/orders.ts";
import { readBook, snapshot, recordSnapshot, recordTrade, latestTrades, type Trade } from "./book.ts";
import { observationLines, buildThoughtPrompt, parseThoughtReply, guardThoughts, readThoughts, recordThought, type QuoteRead, type Thought } from "./thoughts.ts";
import { recallForPrompt, remember } from "../journal.ts";

const MIN_GAP_MIN = Number(process.env.OBS_MIN_THOUGHT_GAP_MIN ?? 25);
const CAN_EXECUTE = false; // the execution stage is not built; see DESIGN.md

const baseUrl = process.env.OPENHERMIT_GATEWAY_URL;
const token = process.env.GATEWAY_ADMIN_TOKEN;
if (!baseUrl || !token) {
  console.error("[desk] gateway not configured (OPENHERMIT_GATEWAY_URL / GATEWAY_ADMIN_TOKEN)");
  process.exit(1);
}
const gw = new GatewayClient({ baseUrl, token });
const now = Date.now();

// Cadence floor, before any network or model call.
const last = readThoughts(1)[0];
if (last && !DRY && (now - last.at) / 60000 < MIN_GAP_MIN) {
  console.log(`Holding: last thought was ${((now - last.at) / 60000).toFixed(0)}m ago, floor is ${MIN_GAP_MIN}m.`);
  process.exit(0);
}

// The world, measured.
const book = readBook();
const held = Object.keys(snapshot(book.flows, book.trades, {}, now).holdings);
const [reads, prices] = await Promise.all([liveReads(), assetPrices(held)]);
const mark = snapshot(book.flows, book.trades, prices, now);
const open = latestTrades(book.trades).filter((t) => t.status === "pending" || t.status === "proposed");
// Live quotes for the watched pairs, the same call the app makes. Read-only.
const quotes: QuoteRead[] = await quoteWatchlist(now);
const observation = observationLines({ reads, book: mark, quotes, open, now });
console.log(`[desk] observation:\n${observation.map((l) => "  - " + l).join("\n")}`);

// The persona thinks.
const prompt = buildThoughtPrompt(observation, readThoughts(4), recallForPrompt(AGENT_ID, 6, now), new Date(now).toISOString(), CAN_EXECUTE);
const sessionId = "desk-cycle";
await gw.agent(AGENT_ID).openSession({ sessionId, source: { kind: "api", interactive: true, type: "direct" } }).catch(() => {});
const resp = await gw.agent(AGENT_ID).postMessageSync(sessionId, { text: prompt }, { timeout: 90_000 });
const gwError = (resp as { error?: string }).error;
if (gwError || resp.text == null) {
  console.error(`[desk] OBS could not think this cycle: ${gwError ?? "gateway returned no text"}`);
  process.exit(1);
}
const parsed = parseThoughtReply(resp.text ?? "");
const thoughts = guardThoughts(parsed.thoughts);
if (!thoughts.length) {
  console.error("[desk] every thought line was blocked or empty; nothing recorded");
  process.exit(1);
}

// A proposal must be something the desk could actually do: an asset it holds,
// in a size it holds. Anything else is recorded as a hold with the reason.
let decision = parsed.decision;
let proposal: Trade | null = null;
if (decision.kind === "propose-swap" && decision.from && decision.to && decision.amount) {
  const have = mark.holdings[decision.from] ?? 0;
  if (have + 1e-12 < decision.amount) {
    decision = { kind: "hold", reason: `proposed ${decision.amount} ${decision.from} to ${decision.to} but the desk holds ${have} ${decision.from}; held instead` };
  } else {
    const px = prices[decision.from] ?? null;
    proposal = {
      at: now,
      id: `prop-${now}`,
      status: "proposed",
      from: { asset: decision.from, amount: decision.amount, usd: px != null ? decision.amount * px : null },
      to: { asset: decision.to, amount: 0, usd: null },
      partner: null,
      note: decision.reason || undefined,
    };
  }
}

const entry: Thought = { at: now, observation, thoughts, decision };
console.log(`[desk] thoughts:\n${thoughts.map((t) => "  " + t).join("\n")}\n[desk] decision: ${decision.kind}${decision.reason ? ` (${decision.reason})` : ""}`);
if (parsed.note) console.log(`  note to self: ${parsed.note}`);

if (DRY) {
  console.log("DRY RUN, nothing recorded.");
  process.exit(0);
}
recordThought(entry);
recordSnapshot(mark);
if (proposal) recordTrade(proposal);
remember(AGENT_ID, { decision: decision.kind === "hold" ? "hold" : "post", note: parsed.note });
console.log(`[desk] recorded${proposal ? `, proposal ${proposal.id} on the board` : ""}.`);
