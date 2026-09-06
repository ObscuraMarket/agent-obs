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
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ROOT_DIR, dataPath } from "../config.ts";
import { readFeed, resolveAny, dynamicPoolSpec, dynamicAssets, earlyAsCandidate, curveKey, isHolding } from "./candidates.ts";
import { recordResearch } from "./research.ts";
import { updateTapes, tapeStats, tapeWindowMin, type SwapRow } from "./tape.ts";
import { entryRead, entryRulesFromEnv } from "./entry.ts";
import { liveReads, walletBalances } from "../obscura/reads.ts";
import { readPaper, paperBalances } from "./paper.ts";
import { readBook, boughtSymbols } from "./book.ts";
import { readScout } from "./scout.ts";
import { triggersFor, watchRulesFromEnv, heartbeatLine, holdingNote, type WatchState, type Role, type Trigger } from "./watch.ts";

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
  const relay = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) if (/^\[desk\]|^Holding|paper trade|refused|Error/.test(line)) console.log(`  ${line.slice(0, 400)}`);
  };
  child.stdout?.on("data", relay);
  child.stderr?.on("data", relay);
  child.on("exit", (code) => {
    console.log(`[live] desk cycle done (exit ${code ?? "?"})`);
    running = null;
    tapeCache.clear();
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
    states.push({ symbol, role, entryState: er.state, entryOk: er.ok, trend: st.trend, offPeakPct: st.offPeakPct, buyPressurePct: st.buyPressurePct, swaps: st.swaps, lastSwapAgoMin: st.lastSwapAgoMin, why: er.why, lastPrice: rows.length ? rows[rows.length - 1].price : null, quote: spec.token0 === symbol ? spec.token1 : spec.token0 });
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
  if (triggers.length && !running) runCycle(triggers[0], states.find((s) => s.symbol === triggers[0].symbol), now);
  const lookMs = Date.now() - now;
  looks.push(lookMs);
  writeFileSync(dataPath(LIVE_FILE), JSON.stringify({ at: Date.now(), block, paper: PAPER, pollMs: POLL_MS, lookMs, watching: states, lastTrigger, lastTriggerKind, cycles, cycleRunning: !!running }));
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
  } catch (e) {
    console.log(`[live] step failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const spent = Date.now() - now;
  await new Promise((r) => setTimeout(r, Math.max(250, POLL_MS - spent)));
}
