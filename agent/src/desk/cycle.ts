// One desk cycle: settle anything in flight, read the world, mark the book,
// hand the operator persona a measured observation, record his public
// thoughts and his decision, snapshot equity. When trading is armed
// (OBS_TRADING=on, key present) a decision that passes the rails is executed
// through Obscura from the desk's own wallet; otherwise it is recorded as a
// proposal. Meant to run on a timer (launchd, see scripts/). DRY_RUN=1 runs
// the model call and writes nothing, and never executes.
import { GatewayClient } from "@openhermit/sdk";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { AGENT_ID, DRY, dataPath } from "../config.ts";
import { liveReads, assetPrices, walletBalances } from "../obscura/reads.ts";
import { quoteWatchlist, parseWatchlist, DEFAULT_WATCHLIST } from "../obscura/orders.ts";
import { readBook, snapshot, snapshotFromChain, recordSnapshot, recordTrade, latestTrades, boughtSymbols, type Trade, markIsTrustworthy } from "./book.ts";
import { observationLines, buildThoughtPrompt, parseThoughtReply, guardThoughts, readThoughts, recordThought, decisionUnread, decisionLineOf, type QuoteRead, type Thought } from "./thoughts.ts";
import { recallForPrompt, remember } from "../journal.ts";
import { railsFromEnv, tradingArmed, sentTodayUsd, resolveAsset, dayStartEquity, entryStats, baseLeg } from "./rails.ts";
import { assetKey, type Asset } from "./assets.ts";
import { execute, settleOpenOrders } from "./execute.ts";
import { executeOnChain, settleOnChain, poolQuotes, exitCandidates, rememberClose } from "./onchain.ts";
import { readFeed, resolveAny, dynamicAssets, tokenInfo, readTokens, gradeCandidate, gradeRulesFromEnv, dynamicPoolSpec, candidateAsset, earlyAsCandidate, curveKey, isHolding } from "./candidates.ts";
import { checkCandidate, clampToBalance } from "./rails.ts";
import { readPaper, paperBalances, paperByKey, paperExecute, PAPER_BOOK } from "./paper.ts";
import { recordPrices, readPrices, priceStats, ratioStats, usSession, evidenceCheck, basisSignal } from "./analysis.ts";
import { stockReference } from "../obscura/stockRef.ts";
import { updateTape, tapeStats, tapeLine } from "./tape.ts";
import { entryRead, entryLine, entryRulesFromEnv, type EntryRead } from "./entry.ts";
import { updateTransfers, holderRead, holdersLine, holderRulesFromEnv, infrastructureAddresses, balancesFrom, txCounts, contractsAmong, explorerHolders, holderReadFromList, withoutWalletCount, type HolderRead } from "./holders.ts";
import { walletTrades, recordWalletTrades, readWalletTrades, walletRecords, walletsLine } from "./wallets.ts";
import { readLaunch, launchLine, launchRulesFromEnv, launchRulesForRecord, type LaunchRead } from "./launch.ts";
import { autoEntryPick, autoEntryFor } from "./autoentry.ts";
import { recordResearch } from "./research.ts";
import { digestThought, shortWhy } from "./digest.ts";
import { readCloses, recallLike, recallLine, launchRecord, launchRecordLine, recordEntry } from "./trade-memory.ts";
import { chainMemory, poolRead } from "../obscura/pools.ts";
import { appendLedger } from "../ledger.ts";
import { positions } from "./book.ts";

const MIN_GAP_MIN = Number(process.env.OBS_MIN_THOUGHT_GAP_MIN ?? 25);
const ARMED = tradingArmed() && !DRY;

// One cycle at a time. The 30-minute timer, the live watch and an operator's
// own run must never overlap, or two could take the same position before
// either records it. The lock names its pid; a lock whose pid is gone, or
// older than 15 minutes, is stale and taken over. Dry runs take no lock.
const LOCK = dataPath("obs-cycle.lock");
if (!DRY) {
  try {
    const l = JSON.parse(readFileSync(LOCK, "utf8")) as { pid: number; at: number };
    let alive = false;
    try {
      process.kill(l.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive && Date.now() - l.at < 15 * 60e3) {
      console.log(`[desk] another cycle is running (pid ${l.pid}, started ${((Date.now() - l.at) / 60e3).toFixed(0)} min ago); leaving`);
      process.exit(0);
    }
  } catch {
    /* no lock, or an unreadable one: take it */
  }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }));
  process.on("exit", () => {
    try {
      if ((JSON.parse(readFileSync(LOCK, "utf8")) as { pid: number }).pid === process.pid) unlinkSync(LOCK);
    } catch {
      /* already gone */
    }
  });
}
// Paper: everything but the send, at full size, in its own ledger. Never while armed.
const PAPER = (process.env.OBS_PAPER ?? "off") === "on" && !ARMED && !DRY;
// Where a decided swap runs: the pools on Robinhood Chain from the desk's own
// wallet (the default), or Obscura's routes. Both sit behind the same rails.
const VENUE: "pool" | "obscura" = (process.env.OBS_VENUE ?? "pool").toLowerCase() === "obscura" ? "obscura" : "pool";
// The basis on the tokenized stock is a side trade, off unless the operator turns it on. Tokens are the job.
const BASIS_ON = (process.env.OBS_BASIS ?? "off") === "on";

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
// What the rails sold at the top of this cycle: the wallet read below is cached and may still show it, and a token
// sold seconds ago must not be described as held in the same breath.
const soldThisCycle = new Set<string>();
if (ARMED && readTokens().length) {
  const readsForExit = await liveReads();
  const chainForExit = readsForExit.wallet ? walletBalances(readsForExit.wallet) : null;
  if (chainForExit) {
    const bookForExit = readBook();
    const boughtForExit = boughtSymbols(bookForExit.trades);
    const heldNames = Object.values(dynamicAssets()).filter((a) => boughtForExit.has(a.symbol) && isHolding(chainForExit.bySymbol[a.symbol])).map((a) => a.symbol);
    if (heldNames.length) {
      const exitPrices = await assetPrices([...heldNames, "ETH"], {});
      const exits = await exitCandidates(chainForExit.bySymbol, exitPrices, { rails: railsFromEnv(), balances: chainForExit.byKey, nativeOnFromChain: chainForExit.byKey["ETH@robinhood"] ?? null, openOrders: 0, sentTodayUsd: sentTodayUsd(bookForExit.trades, now) }, undefined, now);
      for (const t of exits) console.log(`[desk] forced exit ${t.id} ${t.status}: ${t.note}`);
      for (const t of exits) if (t.status === "settled" || t.status === "pending") soldThisCycle.add(t.from.asset);
    }
  }
}

// The fast tick (OBS_TICK=fast, a timer every few minutes): it only spends a
// model call when a token is in play: a held launch token, or an ignited
// launch inside the window whose tape gives an entry (a held pullback or a
// base, never the top of a run). Otherwise it leaves quietly, saying which
// launches it skipped and why. Forced exits above ran regardless. The
// 30-minute desk cycle is unchanged and still reads everything.
if (process.env.OBS_TICK === "fast" && !DRY) {
  if (process.env.OBS_LIVE_TRIGGER) console.log(`[desk] live trigger: ${process.env.OBS_LIVE_TRIGGER}`);
  const feedNow = readFeed(now);
  const wantIgnition = (process.env.OBS_EARLY_REQUIRE_IGNITION ?? "on") !== "off";
  const tickRules = entryRulesFromEnv();
  let probeable: string | null = null;
  let entryWhy = "";
  const skipped: string[] = [];
  for (const l of feedNow.early.slice(0, 8)) {
    if (!l.gateOk || (wantIgnition && l.ignitedAfterMin == null) || (l.creatorTaxBps != null && l.creatorTaxBps > 100)) continue;
    const key = !l.sidePools.length && l.curvePoolId ? await curveKey(l.curvePoolId as `0x${string}`) : null;
    if (!earlyAsCandidate(l, now, wantIgnition, key)) continue;
    const a = resolveAny(`${l.symbol}@robinhood`, feedNow);
    const spec = a?.candidate ? dynamicPoolSpec(a) : null;
    const er = entryRead(spec ? await updateTape(spec, l.symbol, now) : [], l.symbol, now, tickRules);
    if (er.ok) {
      probeable = l.symbol;
      entryWhy = er.why;
      break;
    }
    skipped.push(`${l.symbol} ${er.state}${er.state === "quiet" && er.pickupRatio != null ? ` (${er.pickupRatio.toFixed(1)}x)` : ""}`);
  }
  // Stable tokens are hunted on the tick too: their volume is established by the hourly trail, so only the price action is asked.
  if (!probeable) {
    for (const c of feedNow.candidates.filter((x) => x.stable?.stable || (x.record && x.record.vol1 > 0)).slice(0, 3)) {
      const a = resolveAny(`${c.symbol}@robinhood`, feedNow);
      const spec = a?.candidate ? dynamicPoolSpec(a) : null;
      const er = entryRead(spec ? await updateTape(spec, c.symbol, now) : [], c.symbol, now, tickRules, true);
      if (er.ok) {
        probeable = c.symbol;
        entryWhy = er.why;
        break;
      }
      skipped.push(`${c.symbol} ${er.state} (stable)`);
    }
  }
  const holding = readTokens().length > 0;
  if (!probeable && !holding) {
    console.log(`[desk] fast tick: nothing in play${skipped.length ? ` (${skipped.join(", ")}: no entry on the tape)` : ""}, no model call`);
    process.exit(0);
  }
  // A plain held review (the timer, not a break in the tape) has done its job above: the rails' exits ran. The model
  // writes a review of a position every OBS_HELD_THINK_MIN minutes, not every look; a tape that breaks still thinks at once.
  const trigger = process.env.OBS_LIVE_TRIGGER ?? "";
  const plainReview = trigger === "" || /^held /.test(trigger);
  const heldThinkMin = Number(process.env.OBS_HELD_THINK_MIN ?? 10);
  const lastWrite = readThoughts(1)[0];
  if (!probeable && holding && plainReview && lastWrite && (now - lastWrite.at) / 60000 < heldThinkMin) {
    console.log(`[desk] fast tick: held review, the exits were checked; the last write-up was ${((now - lastWrite.at) / 60000).toFixed(0)}m ago and the next comes at ${heldThinkMin}m, no model call`);
    process.exit(0);
  }
  console.log(`[desk] fast tick: ${probeable ? `${probeable} has an entry (${entryWhy})` : "a launch token is held"}, thinking`);
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
if (chain) for (const sym of soldThisCycle) { chain.bySymbol[sym] = 0; chain.byKey[`${sym}@robinhood`] = 0; }
const bookTrades = PAPER ? [...book.trades, ...paperTrades] : book.trades;
const symbols = chain ? Object.keys(chain.bySymbol) : Object.keys(snapshot(book.flows, bookTrades, {}, now).holdings);
// ETH and NVDA are priced every cycle whether or not they are held: the basis and the samples need them.
const prices = await assetPrices([...new Set([...symbols, "ETH", ...(BASIS_ON ? ["NVDA"] : [])])], { OBS: reads.market?.priceUsd ?? null });
const mark = chain ? snapshotFromChain(book.flows, bookTrades, chain.bySymbol, prices, now) : snapshot(book.flows, bookTrades, prices, now);
const open = latestTrades(book.trades).filter((t) => t.status === "pending" || t.status === "proposed");
// Obscura quotes only the legs it routes (no USDG leg quotes there); the pools quote every Robinhood leg.
const obscuraSpec = parseWatchlist(process.env.OBS_QUOTE_WATCHLIST ?? DEFAULT_WATCHLIST).filter((w) => w.from.code !== "usdg" && w.to.code !== "usdg").map((w) => `${w.from.code}/${w.from.network}->${w.to.code}/${w.to.network}:${w.amount}`).join(",");
const obscuraQuotes: QuoteRead[] = obscuraSpec ? await quoteWatchlist(now, obscuraSpec) : [];
const nvdaDepth = BASIS_ON ? await (async () => { try { const r = await poolRead(chainMemory().referencePools["NVDA/USDG"]); return r?.depthUsd2pct ?? null; } catch { return null; } })() : null;
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
// Each candidate graded against the bar: its row, its hourly trail, and its pool's depth read live.
const gradeRules = gradeRulesFromEnv();
const graded = new Map<string, ReturnType<typeof gradeCandidate>>();
const candidates = [];
for (const cnd of feed.candidates.slice(0, 6)) {
  const spec = dynamicPoolSpec(candidateAsset(cnd));
  const depth = spec ? await (async () => { try { return (await poolRead(spec))?.depthUsd2pct ?? null; } catch { return null; } })() : null;
  const g = gradeCandidate(cnd, feed.hourly[cnd.poolId.toLowerCase()] ?? [], depth, gradeRules);
  graded.set(cnd.symbol, g);
  candidates.push({ symbol: cnd.symbol, hour: cnd.hour, volUsd: cnd.volUsd, movePct: cnd.movePct, senders: cnd.senders, tierPct: cnd.tierPct, ageH: (now - cnd.at) / 3600e3, trail: trailOf(cnd.poolId), grade: g.grade, capUsd: g.capUsd, why: g.why, depthUsd: g.depthUsd });
}
// Early launches: minute one onward. Tradable as a probe once ignited with a hookless side pool; watched otherwise.
const requireIgnition = (process.env.OBS_EARLY_REQUIRE_IGNITION ?? "on") !== "off";
const early = [];
for (const l of feed.early.slice(0, 6)) {
  // An ignited launch with no side pool trades through its own curve, whose key is read from chain once and kept.
  const wantsCurve = l.gateOk && (l.creatorTaxBps == null || l.creatorTaxBps <= 100) && !l.sidePools.length && (!requireIgnition || l.ignitedAfterMin != null) && !!l.curvePoolId;
  const key = wantsCurve ? await curveKey(l.curvePoolId as `0x${string}`) : null;
  const asCand = earlyAsCandidate(l, now, requireIgnition, key);
  const why = !l.gateOk ? "gate failed, never" : l.creatorTaxBps != null && l.creatorTaxBps > 100 ? `creator tax ${(l.creatorTaxBps / 100).toFixed(1)}%, too high` : l.ignitedAfterMin == null && requireIgnition ? "not ignited yet, watch" : !asCand ? (wantsCurve && !key ? "its curve pool is not on chain yet, watch" : !l.curvePoolId ? "its curve pool cannot be named yet, watch" : `its curve pairs with ${l.pairSymbol ?? "an unknown asset"}, which the desk does not trade, watch`) : "";
  if (asCand && !graded.has(asCand.symbol)) graded.set(asCand.symbol, { grade: "C", capUsd: gradeRules.capUsd.C, why: `ignited launch at +${l.ignitedAfterMin ?? 0} min, ${asCand.curve ? `through its ${asCand.curve.quote} curve (hook fee assumed ${Number(process.env.OBS_CURVE_FEE_PCT ?? 2)}% plus ${((l.creatorTaxBps ?? 0) / 100).toFixed(1)}% tax)` : "through its side pool"}, probe only`, depthUsd: null, drawdownPct: null, trend: "unknown" });
  early.push({ symbol: l.symbol, source: l.source, ageMin: Math.round((now - l.at) / 60e3), gateOk: l.gateOk, standard: l.standard, creatorTaxBps: l.creatorTaxBps, ignitedAfterMin: l.ignitedAfterMin, sidePoolTierPct: l.sidePools[0]?.tierPct ?? null, tradable: !!asCand, why, via: asCand ? (asCand.curve ? `${asCand.curve.quote} curve` : "side pool") : null });
}
// Curve keys first (read from chain once, then cached), so an ignited launch with no side pool resolves in this same cycle.
for (const l of feed.early.slice(0, 8)) if (l.gateOk && l.ignitedAfterMin != null && !l.sidePools.length && l.curvePoolId && (l.creatorTaxBps == null || l.creatorTaxBps <= 100)) await curveKey(l.curvePoolId as `0x${string}`);
const dyn = dynamicAssets(feed);
// Held means bought by the desk and still in the wallet above dust: an airdrop is never a holding, whatever the wallet shows.
const bought = boughtSymbols(bookTrades);
const heldDyn = Object.values(dyn).filter((a) => bought.has(a.symbol) && isHolding(chain?.bySymbol[a.symbol]));
const pos = positions(book.flows, bookTrades, chain?.bySymbol ?? mark.holdings, prices).positions;
const heldCandidates = heldDyn.map((a) => {
  const p = pos.find((x) => x.asset === a.symbol);
  const firstBuy = bookTrades.filter((t) => t.to.asset === a.symbol && t.status === "settled").map((t) => t.at).sort()[0] ?? a.candidate?.seenAt ?? now;
  return { symbol: a.symbol, qty: chain?.bySymbol[a.symbol] ?? 0, costUsd: p?.costUsd ?? null, valueUsd: p?.valueUsd ?? null, pnlPct: p?.unrealizedPct != null ? p.unrealizedPct * 100 : null, ageH: (now - firstBuy) / 3600e3, trail: a.candidate ? trailOf(a.candidate.poolId) : "unknown" };
});
// The desk's own price samples, and what they say: 24h moves, 7-day ranges, the typical 30-minute move, relative value.
if (!DRY) recordPrices({ ETH: prices.ETH ?? reads.prices.ethUsd ?? null, ...(BASIS_ON ? { NVDA: prices.NVDA ?? null } : {}), OBS: reads.market?.priceUsd ?? null, ...Object.fromEntries(heldDyn.map((a) => [a.symbol, prices[a.symbol] ?? null])) }, now);
const priceRows = readPrices();
const market = {
  stats: (BASIS_ON ? ["ETH", "NVDA"] : ["ETH"]).map((sym) => priceStats(priceRows, sym, now)),
  ethPerNvda: BASIS_ON ? ratioStats(priceRows, "ETH", "NVDA", now) : null,
  btcChange24hPct: reads.prices.btcChange24hPct ?? null,
  ethChange24hPct: reads.prices.ethChange24hPct ?? null,
  nvdaDepthUsd: nvdaDepth,
  nvdaDepthBaselineUsd: BASIS_ON ? chainMemory().referencePools["NVDA/USDG"]?.measured?.usdgDepth2pct ?? null : null,
};
const session = BASIS_ON ? usSession(now) : undefined;
// The basis, only when it is on: the stock's pool against the 24-hour reference, net of what a round trip costs.
const ref = BASIS_ON ? await stockReference("NVDA", now) : null;
const nvdaPool = BASIS_ON ? prices.NVDA ?? null : null;
const usdgLeg = quotes.find((q) => q.partner?.startsWith("pool") && q.from === "USDG" && q.to === "NVDA");
const roundTripCostPct = usdgLeg && usdgLeg.amountOut != null && nvdaPool ? Math.max(0.3, 2 * (1 - (usdgLeg.amountOut * nvdaPool) / usdgLeg.amountIn) * 100) : 0.62;
const basis = ref && nvdaPool ? basisSignal(nvdaPool, ref, roundTripCostPct, Number(process.env.OBS_BASIS_MIN_EDGE_PCT ?? 0.25)) : null;
// Paper exits: a paper-held launch token past its rails is sold on paper, before the model thinks.
if (PAPER && chain && heldDyn.length) {
  const ctxP = { rails: railsFromEnv(), balances: chain.byKey, nativeOnFromChain: chain.byKey["ETH@robinhood"] ?? null, openOrders: 0, sentTodayUsd: sentTodayUsd(bookTrades, now) };
  const exits = await exitCandidates(chain.bySymbol, prices, ctxP, feed, now, (i, c, t) => paperExecute(i, c, real?.bySymbol ?? {}, t), paperTrades);
  for (const t of exits) console.log(`[desk] paper exit ${t.id}: ${t.note}`);
}
// The desk's own tape for every token in play: held, probeable, or graded; a few pools, incremental reads.
const inPlay = new Map<string, ReturnType<typeof resolveAny>>();
for (const a of heldDyn) inPlay.set(a.symbol, a);
for (const e of early.filter((x) => x.tradable).slice(0, 3)) if (!inPlay.has(e.symbol)) inPlay.set(e.symbol, resolveAny(`${e.symbol}@robinhood`, feed));
for (const cnd of candidates.filter((x) => x.grade).slice(0, Number(process.env.OBS_CYCLE_READ_CANDIDATES ?? 2))) if (!inPlay.has(cnd.symbol)) inPlay.set(cnd.symbol, resolveAny(`${cnd.symbol}@robinhood`, feed));
const tapes: string[] = [];
const tapeTrend = new Map<string, string>();
// The entry read per token: volume puts it on watch, the price action gives the entry.
const entryReads = new Map<string, EntryRead>();
// Who holds each token in play: concentration, the first buyers, fresh wallets. A failed read is a public refusal.
const holderReads = new Map<string, HolderRead>();
const holderRules = holderRulesFromEnv();
// The launch itself: the dev buy, the declared bundle, the creator tax and its recipient, the deployer's record, the phase.
const launchReads = new Map<string, LaunchRead>();
const launchRules = launchRulesFromEnv();
/** Hours of trading after which a token is read on the launch read's hard rules only (OBS_LAUNCH_RECORD_AGE_H). */
const recordAgeH = Number(process.env.OBS_LAUNCH_RECORD_AGE_H ?? 24);
const entryRules = entryRulesFromEnv();
for (const [sym, a] of inPlay) {
  if (!a?.candidate) continue;
  const spec = dynamicPoolSpec(a);
  if (!spec) continue;
  const rows = await updateTape(spec, sym, now);
  const st = tapeStats(rows, sym, now, 15);
  const quote = spec.quote ?? "USDG";
  const quoteUsd = quote === "USDG" ? 1 : prices[quote] ?? null;
  tapes.push(tapeLine(st, quoteUsd, quote));
  tapeTrend.set(sym, st.trend);
  const g = graded.get(sym)?.grade;
  const er = entryRead(rows, sym, now, entryRules, g === "A" || g === "B" || heldDyn.some((h) => h.symbol === sym));
  entryReads.set(sym, er);
  tapes.push(entryLine(er));
  try {
    const launchAt = feed.early.find((x) => x.symbol === sym)?.at ?? feed.candidates.find((x) => x.symbol === sym)?.at ?? null;
    const candForAge = feed.candidates.find((x) => x.symbol === sym);
    const ageH = candForAge ? (Math.max(0, candForAge.hour) * 3600e3 + Math.max(0, now - candForAge.at)) / 3600e3 : 0;
    const infraBase = infrastructureAddresses([a.candidate.curve?.hookAddress]);
    let hr: HolderRead;
    let transfers: Awaited<ReturnType<typeof updateTransfers>> = [];
    let top: string[] = [];
    if (ageH >= recordAgeH && a.contract) {
      // A token with days of trading: the explorer's holder list, not a transfer scan that reaches back hours and
      // would count a handful of wallets. Falls back to the scan if the explorer does not answer.
      try {
        const x = await explorerHolders(a.contract, undefined, a.decimals);
        hr = holderReadFromList(x.list, x.holders, sym, a.contract, now, holderRules, infraBase, x.countIsFloor);
        if (x.ageMin != null) hr.why += ` (the explorer is refusing; its read from ${x.ageMin} min ago stands in)`;
        top = x.list.filter((h) => !h.isContract).sort((p, q) => q.balance - p.balance).slice(0, 10).map((h) => h.address);
      } catch (e) {
        const reason = e instanceof Error ? e.message.replace(/^explorer /, "") : "no answer";
        console.log(`[desk] holders: the explorer did not answer for ${sym} (${reason}); reading recent transfers`);
        transfers = await updateTransfers(a.contract as `0x${string}`, a.decimals, now, launchAt, holderRules);
        hr = withoutWalletCount(holderRead(transfers, sym, a.contract, now, holderRules, infraBase, null), `the explorer ${reason}; read from recent transfers`, holderRules.minWallets);
      }
    } else {
      transfers = await updateTransfers(a.contract as `0x${string}`, a.decimals, now, launchAt, holderRules);
      // Contracts among the largest holders (a pool, a locker, a vesting or treasury contract) are set aside with the
      // infrastructure: the concentration the read fears is people who can sell, and the line says what was set aside.
      const baseSet = new Set(infraBase.map((x) => x.toLowerCase()));
      const largest = [...balancesFrom(transfers).entries()].filter(([addr, v]) => v > 0 && !baseSet.has(addr)).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([addr]) => addr);
      const contracts = transfers.length && largest.length ? await contractsAmong(largest) : [];
      const infra = [...infraBase, ...contracts];
      const infraSet = new Set(infra.map((x) => x.toLowerCase()));
      top = largest.filter((addr) => !infraSet.has(addr)).slice(0, 10);
      const counts = transfers.length && top.length ? await txCounts(top) : null;
      hr = holderRead(transfers, sym, a.contract ?? "", now, holderRules, infra, counts);
      if (contracts.length) hr.why += ` (${contracts.length} contract${contracts.length > 1 ? "s" : ""} among the largest holders set aside as infrastructure)`;
    }
    holderReads.set(sym, hr);
    if (hr.transfers > 0) recordResearch({ kind: "holders", symbol: sym, ok: hr.ok, note: hr.ok ? `${hr.wallets} wallets, largest ${hr.top1Pct == null ? "?" : `${Math.round(hr.top1Pct)}%`}, top ten ${hr.top10Pct == null ? "?" : `${Math.round(hr.top10Pct)}%`}` : shortWhy(hr.why) });
    tapes.push(holdersLine(hr));
    // The wallets' own records: their trades here priced by the tape, kept across tokens, read against the top wallets.
    if (transfers.length && rows.length) {
      recordWalletTrades(walletTrades(transfers, rows, new Set(hr.infra), sym, a.contract ?? "", quoteUsd ?? 0));
      tapes.push(walletsLine(sym, top, walletRecords(readWalletTrades()), (a.contract ?? "").toLowerCase()));
    }
  } catch (e) {
    tapes.push(`Holders ${sym}: not read (${e instanceof Error ? e.message.slice(0, 80) : "error"}).`);
  }
  if (a.contract) {
    try {
      const cand = feed.candidates.find((x) => x.symbol === sym);
      const launchAt = feed.early.find((x) => x.symbol === sym)?.at ?? cand?.at ?? null;
      // A token with a day of trading behind it is read on the hard rules only: socials and the score are launch-day questions.
      const tokenAgeH = cand ? (Math.max(0, cand.hour) * 3600e3 + Math.max(0, now - cand.at)) / 3600e3 : 0;
      const rulesFor = tokenAgeH >= recordAgeH ? launchRulesForRecord(launchRules) : launchRules;
      const lr = await readLaunch(a.contract as `0x${string}`, sym, launchAt, rulesFor, now);
      launchReads.set(sym, lr);
      recordResearch({ kind: "launch-read", symbol: sym, ok: lr.exists ? lr.verdict.ok : null, note: !lr.exists ? "not a pons v2 launch, nothing to read" : lr.verdict.ok ? `${lr.devSharePct != null ? `dev buy ${lr.devSharePct.toFixed(1)}%, ` : ""}${lr.exemptions ? (lr.exemptions.length ? `${lr.exemptions.length} exempt wallets, ` : "no exempt wallets, ") : ""}${lr.socials && (lr.socials.twitter || lr.socials.website || lr.socials.telegram) ? "links set, " : ""}score ${lr.score?.total ?? "n/a"}` : shortWhy(lr.verdict.why) });
      tapes.push(launchLine(lr));
    } catch (e) {
      tapes.push(`Launch ${sym}: not read (${e instanceof Error ? e.message.slice(0, 80) : "error"}).`);
    }
  }
}
// What he learned: the launch record, and the closest past trades to the setups in play.
const closes = readCloses();
const recalls: string[] = [];
const seenRecall = new Set<string>();
for (const [sym, a] of inPlay) {
  if (!a?.candidate) continue;
  const e = early.find((x) => x.symbol === sym);
  const g = graded.get(sym);
  const setup = { source: e?.source ?? feed.candidates.find((x) => x.symbol === sym)?.source ?? "unknown", grade: g?.grade ?? null, tierPct: a.candidate.tierPct, ignitedAfterMin: e?.ignitedAfterMin ?? null, via: a.candidate.curve ? "curve" : "side pool", hourUtc: new Date(now).getUTCHours() };
  for (const r of recallLike(setup, closes, 2)) {
    const key = `${r.close.symbol}-${r.close.at}`;
    if (seenRecall.has(key)) continue;
    seenRecall.add(key);
    recalls.push(recallLine(r.close));
  }
}
const memory = { record: launchRecordLine(launchRecord(closes)), recalls: recalls.slice(0, 4) };
const observation = observationLines({ reads, book: mark, quotes, open, now, unread: chain?.unread, candidates: feed.path ? candidates : undefined, early: feed.path ? early : undefined, heldCandidates, paper: PAPER, market, session, basis, reference: ref ? { perpTradesDay: ref.perpTradesDay, printStatus: ref.printStatus, printAt: ref.printAt } : undefined, tapes, memory: feed.path ? memory : undefined });
// The size a new entry takes, said in ETH, so a buy names the amount the rails will send rather than a guess.
{
  const r = railsFromEnv();
  const ethUsd = prices.ETH ?? reads.prices.ethUsd ?? null;
  if (ethUsd != null && ethUsd > 0) {
    const eth = (usd: number) => `$${usd} of ETH, which is ${(usd / ethUsd).toFixed(4)} ETH`;
    observation.splice(1, 0, r.launchProbeUsd !== r.probeUsd
      ? `Size of a new entry at $${ethUsd.toFixed(2)} per ETH: a token with a record takes ${eth(r.probeUsd)}; a launch still inside its first ${Math.round(Number(process.env.OBS_EARLY_MAX_AGE_MIN ?? 90))} minutes takes ${eth(r.launchProbeUsd)}. A buy names that amount of ETH.`
      : `Size of a new entry: ${eth(r.probeUsd)} at $${ethUsd.toFixed(2)}; a buy names that amount of ETH.`);
  }
}
console.log(`[desk] observation (${mark.source}):\n${observation.map((l) => "  - " + l).join("\n")}`);

// The persona thinks.
const prompt = buildThoughtPrompt(observation, readThoughts(4), recallForPrompt(AGENT_ID, 6, now), new Date(now).toISOString(), ARMED || PAPER, [...railsFromEnv().allowedAssets], VENUE, [...candidates.map((cnd) => `${cnd.symbol}@robinhood`), ...early.filter((e) => e.tradable).map((e) => `${e.symbol}@robinhood`)], PAPER, BASIS_ON);
const sessionId = "desk-cycle";
await gw.agent(AGENT_ID).openSession({ sessionId, source: { kind: "api", interactive: true, type: "direct" } }).catch(() => {});
const resp = await gw.agent(AGENT_ID).postMessageSync(sessionId, { text: prompt }, { timeout: 90_000 });
const gwError = (resp as { error?: string }).error;
if (gwError || resp.text == null) {
  console.error(`[desk] OBS could not think this cycle: ${gwError ?? "gateway returned no text"}`);
  process.exit(1);
}
const parsed = parseThoughtReply(resp.text ?? "");
// The failure that must never be silent: the model meant a swap and the desk is about to hold because the line
// could not be read. It is printed, and it goes on the terminal in red with the line itself.
const unreadDecision = decisionUnread(resp.text ?? "", parsed.decision);
if (unreadDecision) {
  console.error(`[desk] DECISION NOT UNDERSTOOD, holding instead: ${unreadDecision}`);
  if (!DRY) recordResearch({ kind: "decision", symbol: "", ok: false, note: `the desk could not read its own decision and held instead. ${unreadDecision.slice(0, 140)}` });
}
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
// The reads decide the entry (OBS_AUTO_ENTRY=on): a candidate that passed the entry read, the holder read and the
// launch read in this same cycle is bought at the rails' size when the model held anyway; its writing stays public.
if ((process.env.OBS_AUTO_ENTRY ?? "off") === "on" && decision.kind === "hold") {
  const heldSet = new Set(heldDyn.map((a) => a.symbol));
  const board = candidates.filter((c) => c.grade).map((c) => c.symbol).concat(early.filter((e) => e.tradable).map((e) => e.symbol));
  const readsFor = [...new Set(board)].map((sym) => {
    const er = entryReads.get(sym);
    const hr = holderReads.get(sym);
    const lr = launchReads.get(sym);
    return { symbol: sym, grade: graded.get(sym)?.grade ?? null, entryOk: !!er?.ok, entryWhy: er?.why ?? "", holdersOk: !hr || hr.transfers === 0 || hr.ok, launchOk: lr && lr.exists ? lr.verdict.ok : null, held: heldSet.has(sym) };
  });
  const pick = autoEntryPick(readsFor);
  const ethUsd = prices.ETH ?? reads.prices.ethUsd ?? null;
  if (pick && ethUsd != null && ethUsd > 0) {
    const rails = railsFromEnv();
    const auto = autoEntryFor(pick, observation, early.some((e) => e.symbol === pick.symbol) ? rails.launchProbeUsd : rails.probeUsd, ethUsd, rails.candidateFloorPct);
    decision = { kind: "propose-swap", amount: auto.amountEth, from: "ETH@robinhood", to: `${pick.symbol}@robinhood`, reason: auto.reason };
    parsed.analysis = auto.analysis;
    thoughts.push(auto.line);
    console.log(`[desk] auto entry: ${auto.amountEth} ETH to ${pick.symbol} (${pick.entryWhy.slice(0, 120)})`);
  }
}
if (decision.kind === "propose-swap" && decision.from && decision.to && decision.amount) {
  const from = resolveAny(decision.from, feed);
  const named = resolveAny(decision.to, feed);
  // ETH is the base: a sell of a launch token comes back to ETH whatever leg was named.
  const based = from && named ? baseLeg(from, named, railsFromEnv()) : null;
  const to = based ? based.to : named;
  if (based?.note && to) {
    decision.to = assetKey(to as Asset);
    decision.reason = `${decision.reason || ""} (${based.note})`.trim();
  }
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
    const heldPos = to.candidate ? pos.find((x) => x.asset === to.symbol) : undefined;
    // The lane: a token still inside its launch window gets the launch ticket; one with a record gets the full size.
    const lane: "launch" | "record" = early.some((e) => e.symbol === to.symbol) ? "launch" : "record";
    const railGate = !argued.ok ? argued : checkCandidate({ from, to, amount: decision.amount, usd }, to.contract ? tokenInfo(to.contract) : null, heldCandidates.map((h) => h.symbol), rails, to.candidate ? (graded.get(to.symbol) ?? null) : null, heldPos?.valueUsd ?? 0, lane);
    // The entry: a launch-token buy also needs the price action to allow it. Volume puts a token on watch; the tape gives the entry.
    const entry = to.candidate && !from.candidate ? (entryReads.get(to.symbol) ?? null) : null;
    const gateEntry = railGate.ok && to.candidate && !from.candidate && !entry?.ok ? { ok: false as const, reason: entry ? `the tape gives no entry: ${entry.why}` : `no tape was read for ${to.symbol} this cycle, so there is no entry read` } : railGate;
    // The holders: a bundled or single-hand token is not bought, whatever the tape says.
    const holders = to.candidate && !from.candidate ? (holderReads.get(to.symbol) ?? null) : null;
    const gateHolders = gateEntry.ok && holders && holders.transfers > 0 && !holders.ok ? { ok: false as const, reason: `the holders fail the read: ${holders.why}` } : gateEntry;
    // The launch: a declared bundle, a heavy dev buy, a serial deployer or a swept curve is not bought, whatever the tape says.
    const launch = to.candidate && !from.candidate ? (launchReads.get(to.symbol) ?? null) : null;
    const gate = gateHolders.ok && launch && !launch.verdict.ok ? { ok: false as const, reason: `the launch fails the read: ${launch.verdict.why}` } : gateHolders;
    let capUsd: number | undefined;
    let addOn = false;
    if (!gate.ok) {
      decision = { kind: "hold", reason: `wanted ${decision.amount} ${assetKey(from)} to ${assetKey(to)}, refused: ${gate.reason}` };
    } else if ("maxUsd" in gate && gate.maxUsd != null) {
      capUsd = gate.maxUsd;
      addOn = !!gate.addOn;
      if (usd != null && usd > gate.maxUsd) {
        const clamped = Number(((decision.amount * gate.maxUsd) / usd).toPrecision(6));
        const known = to.contract ? tokenInfo(to.contract) : null;
        decision = { ...decision, amount: clamped, reason: `${decision.reason || ""} (sized to $${gate.maxUsd}: ${known?.proven === true ? `${to.symbol}'s grade ${graded.get(to.symbol)?.grade ?? "C"} ceiling` : `${to.symbol} has no proven sell yet, so a probe`})`.trim() };
      }
    }
    const haveNow = chain ? (chain.bySymbol[from.symbol] ?? chain.byKey[assetKey(from)] ?? 0) : (mark.holdings[from.symbol] ?? 0);
    const amt = decision.kind === "propose-swap" ? clampToBalance(decision.amount as number, haveNow) : 0;
    const intentUsd = usd != null && px != null ? amt * px : usd;
    if (decision.kind === "propose-swap" && (ARMED || PAPER)) {
      const isExit = !!from.candidate;
      const intent = { from, to, amount: amt, usd: intentUsd, exit: isExit, ...(capUsd != null ? { capUsd } : {}), ...(addOn ? { addOn: true } : {}) };
      const r = PAPER
        ? await paperExecute(intent, ctx, real?.bySymbol ?? {}, now)
        : VENUE === "obscura" && !from.candidate && !to.candidate ? await execute(intent, ctx, now) : await executeOnChain(intent, ctx, now);
      if (r.ok) {
        executed = r.trade;
        if (to.candidate && (r.trade.status === "settled" || r.trade.status === "pending")) {
          const e = early.find((x) => x.symbol === to.symbol);
          recordEntry({ at: now, symbol: to.symbol, token: to.contract ?? "", source: e?.source ?? feed.candidates.find((x) => x.symbol === to.symbol)?.source ?? "unknown", grade: graded.get(to.symbol)?.grade ?? null, tierPct: to.candidate.tierPct, ignitedAfterMin: e?.ignitedAfterMin ?? null, via: to.candidate.curve ? "curve" : "side pool", usd: intentUsd ?? 0, reason: parsed.analysis?.thesis || decision.reason || "", paper: PAPER });
        }
        if (from.candidate && isExit && r.trade.status === "settled" && amt >= (chain?.bySymbol[from.symbol] ?? amt) * 0.999) {
          const p = pos.find((x) => x.asset === from.symbol);
          rememberClose(from.symbol, from.contract ?? "", bookTrades.filter((t) => t.to.asset === from.symbol && t.status === "settled").map((t) => t.at).sort()[0] ?? now, p?.costUsd ?? null, (p?.realizedUsd ?? 0) + (r.trade.to.usd ?? 0) - (p?.costUsd ?? 0), null, "model", PAPER, now);
        }
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

const decisionLine = decisionLineOf(resp.text ?? "");
const entry: Thought = { at: now, observation, thoughts, decision, ...(PAPER ? { paper: true } : {}), ...(parsed.analysis ? { analysis: parsed.analysis } : {}), ...(decisionLine ? { decisionLine } : {}) };
console.log(`[desk] thoughts:\n${thoughts.map((t) => "  " + t).join("\n")}\n[desk] decision: ${decision.kind}${decision.reason ? ` (${decision.reason})` : ""}`);
if (parsed.analysis) console.log(`[desk] analysis: thesis ${parsed.analysis.thesis || "none"}; evidence ${parsed.analysis.evidence.length} lines; invalidation ${parsed.analysis.invalidation || "none"}; conviction ${parsed.analysis.conviction ?? "none"}`);
if (parsed.note) console.log(`  note to self: ${parsed.note}`);

if (DRY) {
  console.log("DRY RUN, nothing recorded.");
  process.exit(0);
}
recordThought(entry);
{
  const g = digestThought(entry);
  recordResearch({ kind: "decision", symbol: g.wanted ? (g.wanted.split(" to ").pop() ?? "") : "", ok: null, note: g.verdict === "hold" ? `hold. ${g.headline}` : g.headline });
}
// A mark built on a failed wallet read would put a false point on the curve; it is logged, not recorded.
const lastMark = book.snapshots.length ? book.snapshots.reduce((a, b) => (b.at > a.at ? b : a)) : null;
if (!markIsTrustworthy(mark, lastMark, chain?.unread ?? [])) console.log(`[desk] mark not recorded: unread balances (${(chain?.unread ?? []).join(", ") || "all"})`);
else if (PAPER) appendLedger(PAPER_BOOK, mark as unknown as Record<string, unknown>);
else recordSnapshot(mark);
if (proposal) recordTrade(proposal);
remember(AGENT_ID, { decision: decision.kind === "hold" ? "hold" : "post", note: parsed.note });
console.log(`[desk] recorded${PAPER ? " (paper session)" : ""}${proposal ? `, proposal ${proposal.id} on the board` : ""}${executed ? (PAPER ? `, paper trade ${executed.id}` : executed.venue === "pool" ? `, swap ${executed.id} ${executed.status} (${executed.explorerUrl ?? "no receipt yet"})` : `, order ${executed.id} pending (${executed.trackUrl})`) : ""}.`);
