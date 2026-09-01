// One desk cycle: settle anything in flight, read the world, mark the book,
// hand the operator persona a measured observation, record his public
// thoughts and his decision, snapshot equity. When trading is armed
// (OBS_TRADING=on, key present) a decision that passes the rails is executed
// through Obscura from the desk's own wallet; otherwise it is recorded as a
// proposal. Meant to run on a timer (launchd, see scripts/). DRY_RUN=1 runs
// the model call and writes nothing, and never executes.
import { GatewayClient } from "@openhermit/sdk";
import { AGENT_ID, DRY } from "../config.ts";
import { liveReads, assetPrices, walletBalances } from "../obscura/reads.ts";
import { quoteWatchlist } from "../obscura/orders.ts";
import { readBook, snapshot, snapshotFromChain, recordSnapshot, recordTrade, latestTrades, type Trade } from "./book.ts";
import { observationLines, buildThoughtPrompt, parseThoughtReply, guardThoughts, readThoughts, recordThought, type QuoteRead, type Thought } from "./thoughts.ts";
import { recallForPrompt, remember } from "../journal.ts";
import { railsFromEnv, tradingArmed, sentTodayUsd, resolveAsset } from "./rails.ts";
import { assetKey } from "./assets.ts";
import { execute, settleOpenOrders } from "./execute.ts";

const MIN_GAP_MIN = Number(process.env.OBS_MIN_THOUGHT_GAP_MIN ?? 25);
const ARMED = tradingArmed() && !DRY;

const baseUrl = process.env.OPENHERMIT_GATEWAY_URL;
const token = process.env.GATEWAY_ADMIN_TOKEN;
if (!baseUrl || !token) {
  console.error("[desk] gateway not configured (OPENHERMIT_GATEWAY_URL / GATEWAY_ADMIN_TOKEN)");
  process.exit(1);
}
const gw = new GatewayClient({ baseUrl, token });
const now = Date.now();

// Settle first, so the book the persona sees is current. Skipped in DRY_RUN
// because settling writes rows.
if (!DRY) {
  const settled = await settleOpenOrders(now);
  for (const t of settled) console.log(`[desk] ${t.id} -> ${t.status}${t.settlementTx ? ` (${t.settlementTx})` : ""}`);
}

// Cadence floor, before any model call.
const last = readThoughts(1)[0];
if (last && !DRY && (now - last.at) / 60000 < MIN_GAP_MIN) {
  console.log(`Holding: last thought was ${((now - last.at) / 60000).toFixed(0)}m ago, floor is ${MIN_GAP_MIN}m.`);
  process.exit(0);
}

// The world, measured.
const book = readBook();
const reads = await liveReads();
const chain = reads.wallet ? walletBalances(reads.wallet) : null;
const symbols = chain ? Object.keys(chain.bySymbol) : Object.keys(snapshot(book.flows, book.trades, {}, now).holdings);
const prices = await assetPrices(symbols, { OBS: reads.market?.priceUsd ?? null });
const mark = chain ? snapshotFromChain(book.flows, book.trades, chain.bySymbol, prices, now) : snapshot(book.flows, book.trades, prices, now);
const open = latestTrades(book.trades).filter((t) => t.status === "pending" || t.status === "proposed");
const quotes: QuoteRead[] = await quoteWatchlist(now);
const observation = observationLines({ reads, book: mark, quotes, open, now, unread: chain?.unread });
console.log(`[desk] observation (${mark.source}):\n${observation.map((l) => "  - " + l).join("\n")}`);

// The persona thinks.
const prompt = buildThoughtPrompt(observation, readThoughts(4), recallForPrompt(AGENT_ID, 6, now), new Date(now).toISOString(), ARMED);
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

// A swap decision is resolved against the registry and the rails. When
// trading is armed it executes; otherwise it becomes a proposal. Anything the
// rails refuse is recorded as a hold with the reason, in public.
let decision = parsed.decision;
let proposal: Trade | null = null;
let executed: Trade | null = null;
if (decision.kind === "propose-swap" && decision.from && decision.to && decision.amount) {
  const from = resolveAsset(decision.from);
  const to = resolveAsset(decision.to);
  if (!from || !to) {
    decision = { kind: "hold", reason: `proposed ${decision.amount} ${decision.from} to ${decision.to} but one of them is not a registered asset; held instead` };
  } else {
    const px = prices[from.symbol] ?? null;
    const usd = px != null ? decision.amount * px : null;
    const rails = railsFromEnv();
    const ctx = {
      rails,
      balances: chain?.byKey ?? {},
      nativeOnFromChain: chain ? (chain.byKey[`ETH@${from.network === "erc20" ? "eth" : from.network}`] ?? null) : null,
      openOrders: open.filter((t) => t.status === "pending").length,
      sentTodayUsd: sentTodayUsd(book.trades, now),
    };
    if (ARMED) {
      const r = await execute({ from, to, amount: decision.amount, usd }, ctx, now);
      if (r.ok) {
        executed = r.trade;
        decision = { ...decision, from: assetKey(from), to: assetKey(to), reason: `${decision.reason || "executing"}; sent ${decision.amount} ${from.symbol} via ${r.trade.partner}` };
      } else {
        decision = { kind: "hold", reason: `wanted ${decision.amount} ${assetKey(from)} to ${assetKey(to)}, refused: ${r.reason}` };
      }
    } else {
      const have = chain ? (chain.byKey[assetKey(from)] ?? 0) : (mark.holdings[from.symbol] ?? 0);
      if (have + 1e-12 < decision.amount) {
        decision = { kind: "hold", reason: `proposed ${decision.amount} ${assetKey(from)} to ${assetKey(to)} but the desk holds ${have}; held instead` };
      } else {
        proposal = {
          at: now,
          id: `prop-${now}`,
          status: "proposed",
          from: { asset: from.symbol, network: from.network, amount: decision.amount, usd },
          to: { asset: to.symbol, network: to.network, amount: 0, usd: null },
          partner: null,
          note: decision.reason || undefined,
        };
        decision = { ...decision, from: assetKey(from), to: assetKey(to) };
      }
    }
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
console.log(`[desk] recorded${proposal ? `, proposal ${proposal.id} on the board` : ""}${executed ? `, order ${executed.id} pending (${executed.trackUrl})` : ""}.`);
