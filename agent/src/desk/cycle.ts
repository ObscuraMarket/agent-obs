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
import { quoteWatchlist, parseWatchlist, DEFAULT_WATCHLIST } from "../obscura/orders.ts";
import { readBook, snapshot, snapshotFromChain, recordSnapshot, recordTrade, latestTrades, type Trade, markIsTrustworthy } from "./book.ts";
import { observationLines, buildThoughtPrompt, parseThoughtReply, guardThoughts, readThoughts, recordThought, type QuoteRead, type Thought } from "./thoughts.ts";
import { recallForPrompt, remember } from "../journal.ts";
import { railsFromEnv, tradingArmed, sentTodayUsd, resolveAsset, dayStartEquity, entryStats } from "./rails.ts";
import { assetKey } from "./assets.ts";
import { execute, settleOpenOrders } from "./execute.ts";
import { executeOnChain, settleOnChain, poolQuotes, exitCandidates } from "./onchain.ts";
import { readFeed, resolveAny, dynamicAssets, tokenInfo, readTokens } from "./candidates.ts";
import { checkCandidate, clampToBalance } from "./rails.ts";
import { readPaper, paperBalances, paperByKey, paperExecute, PAPER_BOOK } from "./paper.ts";
import { recordPrices, readPrices, priceStats, ratioStats, usSession, evidenceCheck } from "./analysis.ts";
import { chainMemory, poolRead } from "../obscura/pools.ts";
import { appendLedger } from "../ledger.ts";
import { positions } from "./book.ts";

const MIN_GAP_MIN = Number(process.env.OBS_MIN_THOUGHT_GAP_MIN ?? 25);
const ARMED = tradingArmed() && !DRY;
// Paper: everything but the send, at full size, in its own ledger. Never while armed.
const PAPER = (process.env.OBS_PAPER ?? "off") === "on" && !ARMED && !DRY;
// Where a decided swap runs: the pools on Robinhood Chain from the desk's own
// wallet (the default), or Obscura's routes. Both sit behind the same rails.
const VENUE: "pool" | "obscura" = (process.env.OBS_VENUE ?? "pool").toLowerCase() === "obscura" ? "obscura" : "pool";

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
  const settled = [...(await settleOpenOrders(now)), ...(await settleOnChain(now))];
  for (const t of settled) console.log(`[desk] ${t.id} -> ${t.status}${t.settlementTx ? ` (${t.settlementTx})` : ""}`);
}

// The rails' own exits, before the model thinks: a held launch token past
// its time stop, through its floor, or with volume rolling over is sold
// back to ETH here, and the reason is public. Only when armed.
if (ARMED && readTokens().length) {
  const readsForExit = await liveReads();
  const chainForExit = readsForExit.wallet ? walletBalances(readsForExit.wallet) : null;
  if (chainForExit) {
    const bookForExit = readBook();
    const heldNames = Object.values(dynamicAssets()).filter((a) => (chainForExit.bySymbol[a.symbol] ?? 0) > 0).map((a) => a.symbol);
    if (heldNames.length) {
      const exitPrices = await assetPrices(heldNames, {});
      const exits = await exitCandidates(chainForExit.bySymbol, exitPrices, { rails: railsFromEnv(), balances: chainForExit.byKey, nativeOnFromChain: chainForExit.byKey["ETH@robinhood"] ?? null, openOrders: 0, sentTodayUsd: sentTodayUsd(bookForExit.trades, now) }, undefined, now);
      for (const t of exits) console.log(`[desk] forced exit ${t.id} ${t.status}: ${t.note}`);
    }
  }
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
const real = reads.wallet ? walletBalances(reads.wallet) : null;
const paperTrades = PAPER ? readPaper() : [];
// In a paper session the book he sees is the real wallet with the paper trades applied.
const chain = real && PAPER ? { ...real, bySymbol: paperBalances(real.bySymbol, paperTrades), byKey: paperByKey(real.byKey, paperBalances(real.bySymbol, paperTrades)) } : real;
const bookTrades = PAPER ? [...book.trades, ...paperTrades] : book.trades;
const symbols = chain ? Object.keys(chain.bySymbol) : Object.keys(snapshot(book.flows, bookTrades, {}, now).holdings);
const prices = await assetPrices(symbols, { OBS: reads.market?.priceUsd ?? null });
const mark = chain ? snapshotFromChain(book.flows, bookTrades, chain.bySymbol, prices, now) : snapshot(book.flows, bookTrades, prices, now);
const open = latestTrades(book.trades).filter((t) => t.status === "pending" || t.status === "proposed");
const obscuraQuotes: QuoteRead[] = await quoteWatchlist(now);
const nvdaDepth = await (async () => { try { const r = await poolRead(chainMemory().referencePools["NVDA/USDG"]); return r?.depthUsd2pct ?? null; } catch { return null; } })();
// The same legs priced in the pools, so he sees the venue he actually trades on beside Obscura's routes.
const legs = parseWatchlist(process.env.OBS_QUOTE_WATCHLIST ?? DEFAULT_WATCHLIST)
  .map((w) => ({ from: resolveAsset(`${w.from.code}@${w.from.network}`), to: resolveAsset(`${w.to.code}@${w.to.network}`), amount: w.amount }))
  .filter((l): l is { from: NonNullable<typeof l.from>; to: NonNullable<typeof l.to>; amount: number } => !!l.from && !!l.to && l.from.chain === "robinhood" && l.to.chain === "robinhood");
const quotes: QuoteRead[] = [...obscuraQuotes, ...(await poolQuotes(legs, now))];
// The launch watcher's feed: candidates the desk may trade, and what each pool did since.
const feed = readFeed(now);
const trailOf = (poolId: string) => {
  const h = feed.hourly[poolId.toLowerCase()] ?? [];
  return h.length ? h.slice(-4).map((x) => `$${Math.round(x.usd)}${x.px != null ? ` at ${x.px.toPrecision(3)}` : ""}`).join(", ") + " per hour" : "no hourly rows yet";
};
const candidates = feed.candidates.slice(0, 4).map((cnd) => ({ symbol: cnd.symbol, hour: cnd.hour, volUsd: cnd.volUsd, movePct: cnd.movePct, senders: cnd.senders, tierPct: cnd.tierPct, ageH: (now - cnd.at) / 3600e3, trail: trailOf(cnd.poolId) }));
const dyn = dynamicAssets(feed);
const heldDyn = Object.values(dyn).filter((a) => (chain?.bySymbol[a.symbol] ?? 0) > 0);
const pos = positions(book.flows, bookTrades, chain?.bySymbol ?? mark.holdings, prices).positions;
const heldCandidates = heldDyn.map((a) => {
  const p = pos.find((x) => x.asset === a.symbol);
  const firstBuy = bookTrades.filter((t) => t.to.asset === a.symbol && t.status === "settled").map((t) => t.at).sort()[0] ?? a.candidate?.seenAt ?? now;
  return { symbol: a.symbol, qty: chain?.bySymbol[a.symbol] ?? 0, costUsd: p?.costUsd ?? null, valueUsd: p?.valueUsd ?? null, pnlPct: p?.unrealizedPct != null ? p.unrealizedPct * 100 : null, ageH: (now - firstBuy) / 3600e3, trail: a.candidate ? trailOf(a.candidate.poolId) : "unknown" };
});
// The desk's own price samples, and what they say: 24h moves, 7-day ranges, the typical 30-minute move, relative value.
if (!DRY) recordPrices({ ETH: prices.ETH ?? reads.prices.ethUsd ?? null, NVDA: prices.NVDA ?? null, OBS: reads.market?.priceUsd ?? null }, now);
const priceRows = readPrices();
const market = {
  stats: ["ETH", "NVDA"].map((sym) => priceStats(priceRows, sym, now)),
  ethPerNvda: ratioStats(priceRows, "ETH", "NVDA", now),
  btcChange24hPct: reads.prices.btcChange24hPct ?? null,
  ethChange24hPct: reads.prices.ethChange24hPct ?? null,
  nvdaDepthUsd: nvdaDepth,
  nvdaDepthBaselineUsd: chainMemory().referencePools["NVDA/USDG"]?.measured?.usdgDepth2pct ?? null,
};
const session = usSession(now);
// Paper exits: a paper-held launch token past its rails is sold on paper, before the model thinks.
if (PAPER && chain && heldDyn.length) {
  const ctxP = { rails: railsFromEnv(), balances: chain.byKey, nativeOnFromChain: chain.byKey["ETH@robinhood"] ?? null, openOrders: 0, sentTodayUsd: sentTodayUsd(bookTrades, now) };
  const exits = await exitCandidates(chain.bySymbol, prices, ctxP, feed, now, (i, c, t) => paperExecute(i, c, real?.bySymbol ?? {}, t), paperTrades);
  for (const t of exits) console.log(`[desk] paper exit ${t.id}: ${t.note}`);
}
const observation = observationLines({ reads, book: mark, quotes, open, now, unread: chain?.unread, candidates: feed.path ? candidates : undefined, heldCandidates, paper: PAPER, market, session });
console.log(`[desk] observation (${mark.source}):\n${observation.map((l) => "  - " + l).join("\n")}`);

// The persona thinks.
const prompt = buildThoughtPrompt(observation, readThoughts(4), recallForPrompt(AGENT_ID, 6, now), new Date(now).toISOString(), ARMED || PAPER, [...railsFromEnv().allowedAssets], VENUE, candidates.map((cnd) => `${cnd.symbol}@robinhood`), PAPER);
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
  const from = resolveAny(decision.from, feed);
  const to = resolveAny(decision.to, feed);
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
      sentTodayUsd: sentTodayUsd(bookTrades, now),
      dayStartEquityUsd: dayStartEquity(book.snapshots, now),
      equityUsd: mark.equityUsd,
      ...entryStats(bookTrades, now),
      now,
    };
    // A swap must be argued for. An exit of a held position is exempt: leaving is never blocked on paperwork.
    const argued = from.candidate ? { ok: true as const, cited: 0 } : evidenceCheck(parsed.analysis, observation, { minEvidence: rails.minEvidence, minConviction: rails.minConviction });
    const gate = !argued.ok ? argued : checkCandidate({ from, to, amount: decision.amount, usd }, to.contract ? tokenInfo(to.contract) : null, heldCandidates.map((h) => h.symbol), rails);
    if (!gate.ok) {
      decision = { kind: "hold", reason: `wanted ${decision.amount} ${assetKey(from)} to ${assetKey(to)}, refused: ${gate.reason}` };
    } else if (gate.maxUsd != null && usd != null && usd > gate.maxUsd) {
      const clamped = Number(((decision.amount * gate.maxUsd) / usd).toPrecision(6));
      decision = { ...decision, amount: clamped, reason: `${decision.reason || ""} (sized down to a $${gate.maxUsd} probe: ${to.symbol} has no proven sell yet)`.trim() };
    }
    const haveNow = chain ? (chain.bySymbol[from.symbol] ?? chain.byKey[assetKey(from)] ?? 0) : (mark.holdings[from.symbol] ?? 0);
    const amt = decision.kind === "propose-swap" ? clampToBalance(decision.amount as number, haveNow) : 0;
    const intentUsd = usd != null && px != null ? amt * px : usd;
    if (decision.kind === "propose-swap" && (ARMED || PAPER)) {
      const isExit = !!from.candidate;
      const r = PAPER
        ? await paperExecute({ from, to, amount: amt, usd: intentUsd, exit: isExit }, ctx, real?.bySymbol ?? {}, now)
        : VENUE === "obscura" && !from.candidate && !to.candidate ? await execute({ from, to, amount: amt, usd: intentUsd }, ctx, now) : await executeOnChain({ from, to, amount: amt, usd: intentUsd, exit: isExit }, ctx, now);
      if (r.ok) {
        executed = r.trade;
        decision = { ...decision, from: assetKey(from), to: assetKey(to), reason: `${decision.reason || "executing"}; ${PAPER ? `paper: swapped ${amt} ${from.symbol} for ${r.trade.to.amount} ${to.symbol} at full size, nothing sent` : r.trade.venue === "pool" ? `swapped ${amt} ${from.symbol} on chain, ${r.trade.status}` : `sent ${amt} ${from.symbol} via ${r.trade.partner}`}` };
      } else {
        decision = { kind: "hold", reason: `wanted ${amt} ${assetKey(from)} to ${assetKey(to)}, refused: ${r.reason}` };
      }
    } else if (decision.kind === "propose-swap") {
      const have = chain ? (chain.bySymbol[from.symbol] ?? chain.byKey[assetKey(from)] ?? 0) : (mark.holdings[from.symbol] ?? 0);
      if (have + 1e-12 < amt) {
        decision = { kind: "hold", reason: `proposed ${amt} ${assetKey(from)} to ${assetKey(to)} but the desk holds ${have}; held instead` };
      } else {
        proposal = {
          at: now,
          id: `prop-${now}`,
          status: "proposed",
          from: { asset: from.symbol, network: from.network, amount: amt, usd: intentUsd },
          to: { asset: to.symbol, network: to.network, amount: 0, usd: null },
          partner: null,
          note: decision.reason || undefined,
        };
        decision = { ...decision, from: assetKey(from), to: assetKey(to) };
      }
    }
  }
}

const entry: Thought = { at: now, observation, thoughts, decision, ...(PAPER ? { paper: true } : {}), ...(parsed.analysis ? { analysis: parsed.analysis } : {}) };
console.log(`[desk] thoughts:\n${thoughts.map((t) => "  " + t).join("\n")}\n[desk] decision: ${decision.kind}${decision.reason ? ` (${decision.reason})` : ""}`);
if (parsed.analysis) console.log(`[desk] analysis: thesis ${parsed.analysis.thesis || "none"}; evidence ${parsed.analysis.evidence.length} lines; invalidation ${parsed.analysis.invalidation || "none"}; conviction ${parsed.analysis.conviction ?? "none"}`);
if (parsed.note) console.log(`  note to self: ${parsed.note}`);

if (DRY) {
  console.log("DRY RUN, nothing recorded.");
  process.exit(0);
}
recordThought(entry);
// A mark built on a failed wallet read would put a false point on the curve; it is logged, not recorded.
const lastMark = book.snapshots.length ? book.snapshots.reduce((a, b) => (b.at > a.at ? b : a)) : null;
if (!markIsTrustworthy(mark, lastMark, chain?.unread ?? [])) console.log(`[desk] mark not recorded: unread balances (${(chain?.unread ?? []).join(", ") || "all"})`);
else if (PAPER) appendLedger(PAPER_BOOK, mark as unknown as Record<string, unknown>);
else recordSnapshot(mark);
if (proposal) recordTrade(proposal);
remember(AGENT_ID, { decision: decision.kind === "hold" ? "hold" : "post", note: parsed.note });
console.log(`[desk] recorded${PAPER ? " (paper session)" : ""}${proposal ? `, proposal ${proposal.id} on the board` : ""}${executed ? (PAPER ? `, paper trade ${executed.id}` : executed.venue === "pool" ? `, swap ${executed.id} ${executed.status} (${executed.explorerUrl ?? "no receipt yet"})` : `, order ${executed.id} pending (${executed.trackUrl})`) : ""}.`);
