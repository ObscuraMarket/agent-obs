// The live watch: the desk in real time. A long-running process that
// follows the pool of every token in play a few seconds apart (a few dozen
// blocks on this chain), reads each swap as it lands, keeps the tape and the
// entry read current, and runs a desk cycle the moment a held token's tape
// breaks, an entry appears, or a held token is due a review. The cycle
// keeps every rail and every check, including its own exits before it
// thinks; this process only decides when it runs, and runs one at a time. A
// heartbeat goes to data/obs-live.json for the page. Replaces the
// five-minute tick. OBS_PAPER=on watches the paper book instead.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ROOT_DIR, dataPath } from "../config.ts";
import { readFeed, resolveAny, dynamicPoolSpec, dynamicAssets, earlyAsCandidate, curveKey, isHolding } from "./candidates.ts";
import { recordResearch } from "./research.ts";
import { updateTapes, tapeStats, tapeWindowMin, type SwapRow } from "./tape.ts";
import { entryRead, entryRulesFromEnv } from "./entry.ts";
import { liveReads, walletBalances } from "../obscura/reads.ts";
import { readPaper, paperBalances } from "./paper.ts";
import { readBook, boughtSymbols, type Trade } from "./book.ts";
import { readScout } from "./scout.ts";
import { triggersFor, watchRulesFromEnv, heartbeatLine, holdingNote, lockHeld, displaces, swapLanded, type WatchState, type Role, type Trigger } from "./watch.ts";
import { exitVerdict, type HourlyStat } from "./candidates.ts";
import { railsFromEnv } from "./rails.ts";
import { readPrices } from "./analysis.ts";
import { railInput, quoteUsd, tapeLastUsd } from "./railInput.ts";
import { readTapePeaks, writeTapePeaks, rememberPeak, peaksAfterWalletRead, type TapePeak } from "./tapePeaks.ts";
import { xConfigured } from "../social/xClient.ts";
import { raiseAlert, cycleVerdict } from "./alerts.ts";

const POLL_MS = Number(process.env.OBS_LIVE_POLL_MS ?? 3000);
const BALANCES_MS = Number(process.env.OBS_LIVE_BALANCES_MS ?? 60_000);
const MAX_WATCH = Number(process.env.OBS_LIVE_MAX_WATCH ?? 8);
const PAPER = process.env.OBS_PAPER === "on";
const LIVE_FILE = "obs-live.json";

const entryRules = entryRulesFromEnv();
const rules = watchRulesFromEnv();
const wantIgnition = (process.env.OBS_EARLY_REQUIRE_IGNITION ?? "on") !== "off";

let prev: Record<string, WatchState> = {};
const lastThinkAt: Record<string, number> = {};
let running: ChildProcess | null = null;
// The last cycle's end, its exit code and the last error line it printed: on the heartbeat file for the health
// route, and a failed cycle is raised as an alert from here, since the cycle that could not think has exited.
let lastCycleAt: number | null = null;
let lastCycleCode: number | null = null;
let lastCycleError: string | null = null;

// Agent OBS on X. Once the account's keys are set, the posting job runs every OBS_X_EVERY_MIN minutes from this
// loop (the job keeps its own post gap and decides whether to speak; without X_LIVE=true it drafts to the ledger,
// which the Agent page shows). The engagement pass, replies to mentions, runs only with OBS_X_ENGAGE=on. One social
// job at a time, never in the way of a desk cycle.
const X_EVERY_MS = Math.max(5, Number(process.env.OBS_X_EVERY_MIN ?? 20)) * 60_000;
const X_ENGAGE_MS = Math.max(5, Number(process.env.OBS_X_ENGAGE_EVERY_MIN ?? 15)) * 60_000;
const X_ENGAGE = (process.env.OBS_X_ENGAGE ?? "off").toLowerCase() === "on";
let socialAt = 0;
let engageAt = 0;
let social: ChildProcess | null = null;
function runSocial(script: string, tag: string): void {
  if (social) return;
  const child = spawn(join(ROOT_DIR, "node_modules", ".bin", "tsx"), [script], { cwd: ROOT_DIR, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  social = child;
  const relay = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) console.log(`[${tag}] ${line.slice(0, 300)}`);
  };
  child.stdout?.on("data", relay);
  child.stderr?.on("data", relay);
  child.on("exit", (code) => {
    console.log(`[${tag}] done (exit ${code ?? "?"})`);
    social = null;
  });
}
function maybeSocial(now: number): void {
  if (!xConfigured()) return;
  if (now - socialAt >= X_EVERY_MS) { socialAt = now; runSocial("src/autopilot.ts", "x"); return; }
  if (X_ENGAGE && now - engageAt >= X_ENGAGE_MS) { engageAt = now; runSocial("src/engage.ts", "x-engage"); }
}
/**
 * A trigger that fired while a cycle was running, or while another process held the cycle's lock: the most urgent
 * one is kept and run the moment the desk is free. An exit does not wait for a review to finish, and an entry that
 * flipped once is not lost to a busy desk (an entry trigger fires once; a dropped one waited fifteen minutes for
 * a fresh look).
 */
let pendingExit: Trigger | null = null;

/** The book and the price samples, read at most every fifteen seconds for the watch's rail read. */
let railBookAt = 0;
let railBook: { trades: Trade[]; flows: ReturnType<typeof readBook>["flows"] } | null = null;
let railSamples: ReturnType<typeof readPrices> = [];
function railInputs(now: number): { trades: Trade[]; flows: ReturnType<typeof readBook>["flows"]; samples: ReturnType<typeof readPrices> } {
  if (!railBook || now - railBookAt >= 15_000) {
    const b = readBook();
    railBook = { trades: b.trades, flows: b.flows };
    railSamples = readPrices();
    railBookAt = now;
  }
  return { ...railBook, samples: railSamples };
}

/**
 * A held token's exit rails at the tape's last price: the same pure verdict the cycle applies, on the position the
 * book says the desk holds, so the floor, the trail and the take-profit are seen within a look of the tape crossing
 * them rather than at the next review. The cycle still decides and sells; this only says "now". The mark and the
 * verdict's input are built the way the cycle's exit pass builds them (railInput.ts): a rail seen here is a rail
 * seen there, where the two once priced the position apart and the cycle dismissed the watch's floor (2026-09-08).
 */
function railRead(symbol: string, st: WatchState, rows: SwapRow[], poolId: string, feedHourly: Record<string, HourlyStat[]>, now: number): { rail: string | null; railKind: string | null } {
  const none = { rail: null, railKind: null };
  if (PAPER) return none;
  const qty = heldBalances[symbol];
  if (!(qty > 0)) return none;
  const { trades, flows, samples } = railInputs(now);
  // Unpriced (no swap in the window, or a quote with no dollar read), the rails that need no price still read.
  const quotePriceUsd = st.quote ? quoteUsd(st.quote, {}, samples, now) : null;
  const priceUsd = tapeLastUsd(rows, quotePriceUsd, now, tapeWindowMin());
  const input = railInput({ symbol, qty, priceUsd, trades, flows, samples, tapeRows: rows, quote: st.quote, quotePriceUsd, tapePeaks, hourly: feedHourly[poolId.toLowerCase()] ?? [], tapeTrend: st.trend, tapeBuyPressurePct: st.buyPressurePct ?? null, now });
  // The position's high, kept on disk the look it is raised: the tape's window rolls and a redeploy empties this
  // process, and the trail read from cycle-time samples alone gave back 22 to 31% instead of 15% (2026-09-08). It
  // is the tape's own peak in the pool's quote units, so the cycle prices it at its own quote price (tapePeaks.ts).
  if (st.quote) {
    const kept = rememberPeak(tapePeaks, symbol, input.firstBuy, st.quote, input.tapePeakQuote, now);
    if (kept.changed) { tapePeaks = kept.rows; savePeaks(); }
  }
  const v = exitVerdict(input, railsFromEnv());
  return v ? { rail: v.reason, railKind: v.kind } : none;
}

/**
 * The running peak of every held position (obs-tape-peaks.json), read once at boot and written by this process
 * alone: raised in railRead, dropped in refreshHeld once the wallet no longer holds the token. The cycle reads the
 * file as a third source of the peak beside the samples and the tape.
 */
let tapePeaks: TapePeak[] = PAPER ? [] : readTapePeaks();
function savePeaks(): void {
  try { writeTapePeaks(tapePeaks); } catch (e) { console.log(`[live] tape peaks not written: ${e instanceof Error ? e.message : String(e)}`); }
}

/** Whether another process holds the cycle's lock right now: the watch waits for it rather than spawning a cycle that would leave. */
function lockBusy(now: number): boolean {
  try {
    const l = JSON.parse(readFileSync(dataPath("obs-cycle.lock"), "utf8")) as { pid: number; at: number };
    return lockHeld(l, now, (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  } catch {
    return false;
  }
}
let lastTrigger: string | null = null;
let lastTriggerKind: Trigger["kind"] | null = null;
let cycles = 0;
let held: string[] = [];
let balancesAt = 0;
let lastBeat = 0;
/** Each watched pool's window, in memory between looks; cleared after a cycle, which appends to the same files. */
const tapeCache = new Map<string, SwapRow[]>();

/** What the wallet (or the paper book) holds among the dynamic tokens, refreshed every minute, off the loop's critical path. */
let heldInFlight = false;
let heldBalances: Record<string, number> = {};
function refreshHeld(now: number): void {
  if (heldInFlight || now - balancesAt < BALANCES_MS) return;
  heldInFlight = true;
  balancesAt = now;
  liveReads()
    .then((reads) => {
      const chain = reads.wallet ? walletBalances(reads.wallet) : null;
      if (!chain) return;
      const by = PAPER ? paperBalances(chain.bySymbol, readPaper()) : chain.bySymbol;
      const bought = boughtSymbols([...readBook().trades, ...(PAPER ? readPaper() : [])]);
      held = Object.values(dynamicAssets()).filter((a) => bought.has(a.symbol) && isHolding(by[a.symbol])).map((a) => a.symbol);
      heldBalances = Object.fromEntries(held.map((s) => [s, by[s] ?? 0]));
      // A position the wallet read says is no longer held is closed: its peak is dropped so a re-entry starts its
      // own. Only here, after a real wallet read, and only for a token the read answered for: a balance the chain
      // did not answer is unread, not zero (tapePeaks.ts, review of 2026-09-08).
      if (!PAPER) {
        const kept = peaksAfterWalletRead(tapePeaks, chain.bySymbol);
        if (kept.changed) { tapePeaks = kept.rows; savePeaks(); }
      }
    })
    .catch((e) => console.log(`[live] balances not read: ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => {
      heldInFlight = false;
    });
}

/** Tape files are caches rebuilt from the chain; drop the ones nothing has touched in three days. */
let prunedAt = 0;
function pruneTapes(now: number): void {
  if (now - prunedAt < 3600e3) return;
  prunedAt = now;
  try {
    const dir = join(DATA_DIR, "tape");
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (f.endsWith(".jsonl") && now - statSync(p).mtimeMs > 3 * 24 * 3600e3) unlinkSync(p);
    }
  } catch {
    /* nothing to prune */
  }
}

/** One desk cycle, the same script the timers run, with the trigger in its environment. One at a time. */
function runCycle(t: Trigger, state: WatchState | undefined, now: number): void {
  const { symbol, reason } = t;
  lastThinkAt[symbol] = now;
  lastTrigger = `${new Date(now).toISOString().slice(11, 19)}Z ${reason}`;
  lastTriggerKind = t.kind;
  cycles++;
  console.log(`[live] trigger: ${reason}; running the desk`);
  // The terminal's line: an entry is "gave an entry"; a held token is what its tape is doing, on the cadence or at the break.
  if (t.kind === "entry") recordResearch({ kind: "trigger", symbol, ok: null, note: compactWhy(t.what) });
  else recordResearch({ kind: "holding", symbol, ok: t.kind === "exit" ? false : null, note: `${t.kind === "exit" ? t.what : "review"}|${state ? holdingNote(state) : t.what}` });
  const child = spawn(join(ROOT_DIR, "node_modules", ".bin", "tsx"), ["src/desk/cycle.ts"], {
    cwd: ROOT_DIR,
    env: { ...process.env, OBS_TICK: "fast", OBS_MIN_THOUGHT_GAP_MIN: String(rules.cooldownMin), OBS_LIVE_TRIGGER: reason },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running = child;
  lastCycleError = null;
  let landed = false;
  const relay = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (/^\[desk\]|^Holding|paper trade|refused|Error/.test(line)) console.log(`  ${line.slice(0, 400)}`);
      if (/could not think|Error|failed|another cycle is running/.test(line)) lastCycleError = line.trim();
      if (swapLanded(line)) landed = true;
    }
  };
  child.stdout?.on("data", relay);
  child.stderr?.on("data", relay);
  child.on("exit", (code) => {
    console.log(`[live] desk cycle done (exit ${code ?? "?"})`);
    lastCycleAt = Date.now();
    lastCycleCode = code;
    const failed = cycleVerdict(code, lastCycleError);
    if (failed) void raiseAlert("cycle", failed, lastCycleAt);
    running = null;
    tapeCache.clear();
    // A swap landed: the wallet and the rail book are re-read on the next look rather than on their own minute, so
    // a fresh buy has its rails at once and a token just sold trips nothing (2026-09-08).
    if (landed) { balancesAt = 0; railBookAt = 0; }
    // A cycle that only read another's lock and left did nothing: its trigger is kept and runs when the lock clears.
    if (lastCycleError && /another cycle is running/.test(lastCycleError) && !pendingExit) { pendingExit = t; console.log(`[live] the cycle left (the lock was held); its trigger is kept: ${t.reason}`); return; }
    if (pendingExit && !lockBusy(Date.now())) {
      const t2 = pendingExit;
      pendingExit = null;
      runCycle(t2, prev[t2.symbol], Date.now());
    }
  });
}

const looks: number[] = [];

// The research log's memory: which launches and ignitions were already noted, which pools are on the watch.
const seenLaunch = new Map<string, boolean>();
const watchingNow = new Set<string>();
let firstLook = true;
const entryNoted = new Map<string, number>();
/** PURE: the two figures that decide an entry read, from its sentence: how far off the peak, and the buy pressure. */
function compactWhy(why: string): string {
  const off = why.match(/now (\d+)% off it|(\d+)% off its peak/);
  const bp = why.match(/buy pressure (\d+)%/);
  const run = why.match(/ran \+(\d+)% to its peak/);
  const bits = [run ? `ran +${run[1]}%` : null, off ? `${off[1] ?? off[2]}% off the peak` : null, bp ? `buy pressure ${bp[1]}%` : null].filter(Boolean);
  if (bits.length) return bits.join(", ");
  return why.replace(/^[^;:]*;\s*/, "").replace(/:\s*[a-z ]+,? ?(entry allowed|no entry|not allowed).*$/i, "").replace(/^no volume pickup \(/, "").replace(/\)$/, "").trim().slice(0, 110);
}

async function step(now: number): Promise<void> {
  refreshHeld(now);
  pruneTapes(now);
  const feed = readFeed(now);
  // New launches and ignitions from the feed, noted once each. The first look after boot only learns what is there.
  for (const l of feed.early) {
    const k = l.token.toLowerCase();
    const ignited = l.ignitedAfterMin != null;
    const known = seenLaunch.get(k);
    if (known === undefined) {
      seenLaunch.set(k, ignited);
      if (!firstLook) {
        const bits = [`${l.source || "launch"}`, l.pairSymbol ? `paired with ${l.pairSymbol}` : null, l.creatorTaxBps != null ? `creator tax ${(l.creatorTaxBps / 100).toFixed(1)}%` : null, l.gateOk ? null : "not the launcher's standard"].filter(Boolean).join(", ");
        recordResearch({ kind: "launch", symbol: l.symbol, ok: l.gateOk, note: bits });
        if (ignited) recordResearch({ kind: "ignited", symbol: l.symbol, ok: null, note: `${l.ignitedAfterMin} minute${l.ignitedAfterMin === 1 ? "" : "s"} after launch` });
      }
    } else if (!known && ignited) {
      seenLaunch.set(k, true);
      recordResearch({ kind: "ignited", symbol: l.symbol, ok: null, note: `${l.ignitedAfterMin} minute${l.ignitedAfterMin === 1 ? "" : "s"} after launch` });
    }
  }
  if (seenLaunch.size > 4000) for (const k of [...seenLaunch.keys()].slice(0, 1000)) seenLaunch.delete(k);
  const inPlay: Array<{ symbol: string; role: Role }> = held.map((symbol) => ({ symbol, role: "held" as const }));
  const add = (symbol: string, role: Role) => {
    if (!inPlay.some((x) => x.symbol === symbol)) inPlay.push({ symbol, role });
  };
  for (const l of feed.early.slice(0, 8)) {
    if (!l.gateOk || (wantIgnition && l.ignitedAfterMin == null) || (l.creatorTaxBps != null && l.creatorTaxBps > 100)) continue;
    const key = !l.sidePools.length && l.curvePoolId ? await curveKey(l.curvePoolId as `0x${string}`) : null;
    if (earlyAsCandidate(l, now, wantIgnition, key)) add(l.symbol, "launch");
  }
  // The scout's ranking fills the survivor slots when it is fresh (under fifteen minutes); the board's own order otherwise.
  const scout = readScout();
  const scoutFresh = scout.ranked.length > 0 && now - scout.at < 15 * 60e3;
  const survivors = scoutFresh ? scout.ranked.map((r) => r.symbol) : feed.candidates.filter((x) => x.stable?.stable || (x.record && x.record.vol1 > 0)).map((c) => c.symbol);
  for (const symbol of survivors.slice(0, MAX_WATCH)) add(symbol, "stable");
  const items: Array<{ symbol: string; role: Role; spec: NonNullable<ReturnType<typeof dynamicPoolSpec>> }> = [];
  for (const { symbol, role } of inPlay.slice(0, MAX_WATCH)) {
    const a = resolveAny(`${symbol}@robinhood`, feed);
    const spec = a?.candidate ? dynamicPoolSpec(a) : null;
    if (spec) items.push({ symbol, role, spec });
  }
  // Tokens taken onto the watch and dropped from it.
  const nowWatching = new Set(items.map((x) => x.symbol));
  if (!firstLook) {
    for (const { symbol, role } of items) if (!watchingNow.has(symbol)) {
      const e = feed.early.find((x) => x.symbol === symbol);
      recordResearch({ kind: "watch", symbol, ok: null, note: role === "held" ? "a token the desk holds" : role === "stable" ? "a token with active hours behind it" : e ? `a launch that ignited${e.ignitedAfterMin != null ? ` at +${e.ignitedAfterMin} min` : ""}${e.creatorTaxBps != null ? ` with a ${(e.creatorTaxBps / 100).toFixed(1)}% creator tax` : ""}` : "a launch candidate" });
    }
    for (const symbol of watchingNow) if (!nowWatching.has(symbol)) recordResearch({ kind: "dropped", symbol, ok: null, note: "it left the window or the board" });
  }
  watchingNow.clear();
  for (const sy of nowWatching) watchingNow.add(sy);
  // One read for every watched pool: the blocks since the last look, kept in memory.
  // Three hours of tape by default (OBS_LIVE_TAPE_MIN), the same window the cycle reads: the dip read looks that far back for the pump it buys under.
  const { tapes, headBlock: block } = await updateTapes(items, now, tapeWindowMin(), tapeCache);
  const states: WatchState[] = [];
  for (const { symbol, role, spec } of items) {
    const rows = tapes.get(spec.id as string) ?? [];
    const st = tapeStats(rows, symbol, now, 15);
    const er = entryRead(rows, symbol, now, entryRules, role !== "launch");
    const state: WatchState = { symbol, role, entryState: er.state, entryOk: er.ok, trend: st.trend, offPeakPct: st.offPeakPct, buyPressurePct: st.buyPressurePct, swaps: st.swaps, lastSwapAgoMin: st.lastSwapAgoMin, why: er.why, lastPrice: rows.length ? rows[rows.length - 1].price : null, quote: spec.token0 === symbol ? spec.token1 : spec.token0 };
    if (role === "held") {
      try { Object.assign(state, railRead(symbol, state, rows, spec.id as string, feed.hourly, now)); } catch (e) { console.log(`[live] rail read of ${symbol} failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
    states.push(state);
  }
  // The tape's entry state changing on a watched token is research worth a line: the state, and the two
  // figures that decide it, at most once every three minutes per token and state so a flapping read does not flood the log.
  // Not on a held token: the desk is in it, its line is the holding review, and "no entry" would read as if it were not.
  if (!firstLook) {
    for (const st of states) {
      if (st.role === "held") continue;
      const p = prev[st.symbol];
      if (p && p.entryState === st.entryState && p.entryOk === st.entryOk) continue;
      if (!p && st.entryState === "quiet") continue;
      const k = `${st.symbol}|${st.entryState}`;
      if (now - (entryNoted.get(k) ?? 0) < 3 * 60e3) continue;
      entryNoted.set(k, now);
      recordResearch({ kind: "entry", symbol: st.symbol, ok: st.entryOk, note: `${st.entryState}|${compactWhy(st.why)}` });
    }
  }
  firstLook = false;
  const triggers = triggersFor(prev, states, lastThinkAt, now, rules);
  prev = Object.fromEntries(states.map((s) => [s.symbol, s]));
  const busy = !!running || lockBusy(now);
  if (triggers.length && !busy) runCycle(triggers[0], states.find((s) => s.symbol === triggers[0].symbol), now);
  else if (triggers.length && busy) {
    // Kept for the moment the desk is free: the first trigger unless one is already kept, and a higher rank takes
    // the kept one's place (an exit over an entry over a review).
    const t = triggers[0];
    if (displaces(t, pendingExit)) {
      pendingExit = t;
      console.log(`[live] ${t.kind} trigger held for the next cycle (${running ? "a cycle is running" : "another process holds the cycle's lock"}): ${t.reason}`);
    }
  } else if (pendingExit && !busy) {
    const t = pendingExit;
    pendingExit = null;
    runCycle(t, prev[t.symbol], now);
  }
  const lookMs = Date.now() - now;
  looks.push(lookMs);
  writeFileSync(dataPath(LIVE_FILE), JSON.stringify({ at: Date.now(), block, paper: PAPER, pollMs: POLL_MS, lookMs, watching: states, lastTrigger, lastTriggerKind, cycles, cycleRunning: !!running, lastCycleAt, lastCycleCode }));
  if (now - lastBeat >= 60_000) {
    lastBeat = now;
    const mean = looks.reduce((s, v) => s + v, 0) / Math.max(1, looks.length);
    looks.length = 0;
    console.log(heartbeatLine(states, block, lastTrigger, mean));
  }
}

console.log(`[live] the live watch: every ${POLL_MS} ms${PAPER ? ", on the paper book" : ""}; a held token is reviewed every ${rules.heldEveryMin} min, an entry fires once with a ${rules.cooldownMin} min cooldown`);
mkdirSync(DATA_DIR, { recursive: true });
for (;;) {
  const now = Date.now();
  try {
    await step(now);
    maybeSocial(now);
  } catch (e) {
    console.log(`[live] step failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const spent = Date.now() - now;
  await new Promise((r) => setTimeout(r, Math.max(250, POLL_MS - spent)));
}
