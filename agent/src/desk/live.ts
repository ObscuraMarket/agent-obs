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
import { readFeed, resolveAny, dynamicPoolSpec, dynamicAssets, earlyAsCandidate, curveKey } from "./candidates.ts";
import { updateTapes, tapeStats, type SwapRow } from "./tape.ts";
import { entryRead, entryRulesFromEnv } from "./entry.ts";
import { liveReads, walletBalances } from "../obscura/reads.ts";
import { readPaper, paperBalances } from "./paper.ts";
import { triggersFor, watchRulesFromEnv, heartbeatLine, type WatchState, type Role } from "./watch.ts";

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
      held = Object.values(dynamicAssets()).filter((a) => (by[a.symbol] ?? 0) > 0).map((a) => a.symbol);
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
function runCycle(reason: string, symbol: string, now: number): void {
  lastThinkAt[symbol] = now;
  lastTrigger = `${new Date(now).toISOString().slice(11, 19)}Z ${reason}`;
  cycles++;
  console.log(`[live] trigger: ${reason}; running the desk`);
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

async function step(now: number): Promise<void> {
  refreshHeld(now);
  pruneTapes(now);
  const feed = readFeed(now);
  const inPlay: Array<{ symbol: string; role: Role }> = held.map((symbol) => ({ symbol, role: "held" as const }));
  const add = (symbol: string, role: Role) => {
    if (!inPlay.some((x) => x.symbol === symbol)) inPlay.push({ symbol, role });
  };
  for (const l of feed.early.slice(0, 8)) {
    if (!l.gateOk || (wantIgnition && l.ignitedAfterMin == null) || (l.creatorTaxBps != null && l.creatorTaxBps > 100)) continue;
    const key = !l.sidePools.length && l.curvePoolId ? await curveKey(l.curvePoolId as `0x${string}`) : null;
    if (earlyAsCandidate(l, now, wantIgnition, key)) add(l.symbol, "launch");
  }
  for (const c of feed.candidates.filter((x) => x.stable?.stable).slice(0, 3)) add(c.symbol, "stable");
  const items: Array<{ symbol: string; role: Role; spec: NonNullable<ReturnType<typeof dynamicPoolSpec>> }> = [];
  for (const { symbol, role } of inPlay.slice(0, MAX_WATCH)) {
    const a = resolveAny(`${symbol}@robinhood`, feed);
    const spec = a?.candidate ? dynamicPoolSpec(a) : null;
    if (spec) items.push({ symbol, role, spec });
  }
  // One read for every watched pool: the blocks since the last look, kept in memory.
  const { tapes, headBlock: block } = await updateTapes(items, now, 35, tapeCache);
  const states: WatchState[] = [];
  for (const { symbol, role, spec } of items) {
    const rows = tapes.get(spec.id as string) ?? [];
    const st = tapeStats(rows, symbol, now, 15);
    const er = entryRead(rows, symbol, now, entryRules, role !== "launch");
    states.push({ symbol, role, entryState: er.state, entryOk: er.ok, trend: st.trend, offPeakPct: st.offPeakPct, buyPressurePct: st.buyPressurePct, swaps: st.swaps, lastSwapAgoMin: st.lastSwapAgoMin, why: er.why });
  }
  const triggers = triggersFor(prev, states, lastThinkAt, now, rules);
  prev = Object.fromEntries(states.map((s) => [s.symbol, s]));
  if (triggers.length && !running) runCycle(triggers[0].reason, triggers[0].symbol, now);
  const lookMs = Date.now() - now;
  looks.push(lookMs);
  writeFileSync(dataPath(LIVE_FILE), JSON.stringify({ at: Date.now(), block, paper: PAPER, pollMs: POLL_MS, lookMs, watching: states, lastTrigger, cycles, cycleRunning: !!running }));
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
