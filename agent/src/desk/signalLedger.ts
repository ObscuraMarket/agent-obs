// The signal ledger: the desk's board, written once per thinking cycle as one
// row per token in play, with every read the cycle made on it and the desk's
// own stance on it. The operator's architecture of 2026-09-08: each agent
// executes on Agent OBS's signals independently, and sometimes they select one
// and all buy together (the convoy). The rows here are the signals; the
// desk's own buy is one agent acting on them, and the follower agents read
// them in-process in the next step. Nothing here is served publicly: the
// research rows already leak the desk's next buy 80 to 100 seconds ahead
// (investigated 2026-09-08), so this ledger reaches only the operator's own
// wallets (/signals, behind the bearer and OBS_CONSOLE_ALLOWLIST: the review
// of 2026-09-08 found that a signed holder at an open door could poll the
// strong rows, the very rows the convoy will act on). The name "signals" was
// taken by the public strip route (/api/obs/signals), hence signalLedger.
//
// Pure builders, and one writer the cycle calls with what it already has.
// Every field is null-safe: a read that was not made is a null, never a pass.
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { appendLedger, readLedger } from "../ledger.ts";
import { dataPath } from "../config.ts";
import type { EntryRead } from "./entry.ts";
import type { HolderRead } from "./holders.ts";
import type { LaunchRead } from "./launch.ts";
import { holderReadComplete, launchReadComplete } from "./readgate.ts";

export const SIGNALS_LEDGER = "obs-signals.jsonl";
/** How much of the ledger's tail one board read parses (the last few dozen cycles; a cycle is a handful of rows). */
export const TAIL_BYTES = 256 * 1024;

export type SignalGrade = "A" | "B" | "C" | null;
export type SignalLane = "launch" | "record";
/** The tape's setup word, as the entry read names it (entry.ts). Null when no tape was read. */
export type SignalEntryKind = "base" | "pullback" | "reignition" | "breakdown" | "waiting" | "quiet" | "spike" | "dip" | null;
/**
 * The desk's own decision about the token this cycle: took = it bought it; held = the model held, with its reason;
 * full = the position cap refused the want; spaced = the spacing rail; brake = the daily loss brake; refused = any
 * other rail or read-gate reason; unargued = the model wanted it but did not argue for it (the evidence check);
 * failed = the swap was sent and did not go through (a revert, a bad quote, a pool that would not fill); add-on = it
 * added to a position; exit = it sold it, or wanted to and could not.
 */
export type StanceKind = "took" | "held" | "full" | "spaced" | "brake" | "refused" | "unargued" | "failed" | "add-on" | "exit";

export interface SignalRow {
  at: number;
  /** The cycle's start ms, the same number the desk's trade ids carry (pool-<cycleId>). */
  cycleId: number;
  symbol: string;
  token: string | null;
  poolId: string | null;
  lane: SignalLane;
  grade: SignalGrade;
  capUsd: number | null;
  /** The mark the cycle used: the book's price for a held token, else the tape's last print in dollars. */
  priceUsd: number | null;
  depthUsd: number | null;
  entry: { ok: boolean; kind: SignalEntryKind; why: string };
  holders: { ok: boolean; complete: boolean; wallets: number | null; largestPct: number | null; topTenPct: number | null; why: string };
  launch: { ok: boolean; complete: boolean; score: number | null; devSharePct: number | null; why: string };
  tape: { buyPressurePct: number | null; trend: string | null };
  proven: boolean | null;
  blacklisted: boolean;
  deskHeld: boolean;
  stance: { kind: StanceKind; why: string };
  strong: boolean;
}

/** The convoy rule's numbers (strongSignal). */
export interface ConvoyRules {
  /** The pool must be at least this many times the desk's per-swap cap deep (OBS_CONVOY_DEPTH_MULT). */
  depthMult: number;
  /** The desk's per-swap cap in dollars (OBS_MAX_SWAP_USD). */
  maxSwapUsd: number;
  /** The model's conviction scale tops out here (1 to 5). */
  topConviction: number;
}

export function convoyRulesFromEnv(env: NodeJS.ProcessEnv = process.env): ConvoyRules {
  return { depthMult: Number(env.OBS_CONVOY_DEPTH_MULT ?? 20), maxSwapUsd: Number(env.OBS_MAX_SWAP_USD ?? 25), topConviction: 5 };
}

/** One token on the board, as the cycle has it. Every read may be missing. */
export interface BoardToken {
  symbol: string;
  token?: string | null;
  poolId?: string | null;
  lane: SignalLane;
  /** The desk holds it above dust, bought by the desk. */
  held: boolean;
  grade?: { grade: SignalGrade; capUsd: number; depthUsd: number | null } | null;
  priceUsd?: number | null;
  entry?: Pick<EntryRead, "ok" | "state" | "why"> | null;
  holders?: Pick<HolderRead, "ok" | "why" | "transfers" | "wallets" | "top1Pct" | "top10Pct"> | null;
  launch?: Pick<LaunchRead, "exists" | "unread" | "verdict" | "score" | "devSharePct"> | null;
  /** Why a read threw this cycle, when one did. */
  failed?: { holders?: string; launch?: string };
  tape?: { buyPressurePct: number | null; trend: string } | null;
  /** What the desk knows of the token from its own trades: a proven sell, or a blacklisting. */
  known?: { proven: boolean | null; blacklisted: boolean } | null;
}

/** What the decision block learned about the one token it named, when it named one. */
export interface SignalWant {
  symbol: string;
  /** The want was a sale of a held token. */
  exit: boolean;
  /** The rails', the evidence check's or the read gate's refusal, when there was one: the swap was never sent. */
  refused?: string;
  /** The executor's failure, when the swap was sent and did not go through (kept apart from a refusal, 2026-09-08). */
  failed?: string;
  /** The gate sized it as an add-on to a position already held. */
  addOn?: boolean;
}

export interface SignalInputs {
  at: number;
  cycleId: number;
  board: BoardToken[];
  /** The cycle's final decision: "hold" with its reason, or the swap that went through. */
  decision: { kind: string; reason?: string };
  want: SignalWant | null;
  /** A trade ran this cycle (armed or paper). */
  executed: boolean;
  /** The swap went on the board as a proposal (trading off). */
  proposed: boolean;
  /** The model's conviction, 1 to 5, or null when it gave none. */
  conviction: number | null;
  rules: ConvoyRules;
}

const clip = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}...` : s);

/**
 * PURE: the rails' own wording sorted into the stance kinds. The sentences are the rails' (rails.ts) and the
 * evidence check's (analysis.ts): a want the model did not argue for is "unargued", not a refusal by the desk's
 * own book, so it is never strong (review of 2026-09-08).
 */
export function stanceOfRefusal(reason: string): Extract<StanceKind, "full" | "spaced" | "brake" | "refused" | "unargued"> {
  if (/^not argued for|was stated$/i.test(reason)) return "unargued";
  if (/daily loss brake/i.test(reason)) return "brake";
  if (/entries are at least .*apart/i.test(reason)) return "spaced";
  if (/ceiling of \$|exceeds the (grade|per-swap) cap/i.test(reason)) return "full";
  return "refused";
}

/** PURE: what became of the want, for the rest of the board's rows. */
function wantWord(w: SignalWant, i: Pick<SignalInputs, "executed" | "proposed">): string {
  if (w.refused || w.failed) return "wanted";
  if (i.executed) return w.exit ? "sold" : "bought";
  return w.exit ? "proposed selling" : "proposed";
}

/**
 * PURE: the desk's stance on one token this cycle, from the decision block's outcome. A sale is an exit whatever
 * became of it: the review of 2026-09-08 found a refused or reverted sale sorted as a refused want, which the convoy
 * rule counts as a want to buy, so a held token the desk could not leave was written strong. The exit is asked first.
 */
export function stanceFor(symbol: string, i: Pick<SignalInputs, "decision" | "want" | "executed" | "proposed">): SignalRow["stance"] {
  const reason = clip(i.decision.reason ?? "");
  const w = i.want;
  if (w && w.symbol === symbol) {
    if (w.exit) {
      if (w.refused) return { kind: "exit", why: clip(`the sale was refused: ${w.refused}`) };
      if (w.failed) return { kind: "exit", why: clip(`the sale failed: ${w.failed}`) };
      return { kind: "exit", why: reason || (i.executed ? "sold" : "a sale was proposed") };
    }
    if (w.refused) return { kind: stanceOfRefusal(w.refused), why: clip(w.refused) };
    if (w.failed) return { kind: "failed", why: clip(w.failed) };
    if (i.executed) return { kind: w.addOn ? "add-on" : "took", why: reason || "bought" };
    if (i.proposed) return { kind: "took", why: clip(`proposed on the board, trading is off${reason ? `; ${reason}` : ""}`) };
    return { kind: "refused", why: reason || "the want did not go through" };
  }
  // The rest of the board: what became of the one the desk named, in its own words, not the model's reason about
  // a different token, and never "bought" when nothing was (the review of 2026-09-08).
  if (!w) return { kind: "held", why: reason || "the model held" };
  return { kind: "held", why: `the desk ${wantWord(w, i)} ${w.symbol} this cycle instead` };
}

/**
 * PURE: the convoy rule. A row is strong when the desk's reads all say yes and the want was the model's at full
 * conviction: grade A; the tape gives an entry; the holder read completed and passed; the launch read completed and
 * passed; the pool is at least OBS_CONVOY_DEPTH_MULT (20) times OBS_MAX_SWAP_USD deep, so several agents buying
 * together do not move it; the token is not blacklisted; and the decision was a swap into it (took, add-on, or a
 * want the desk's own rails refused for their own book: full, spaced, brake, refused) with the model's conviction at
 * its top mark. A refusal by the desk's own rails does not weaken the signal: a follower with room is not full,
 * spaced or braked because the desk is. A hold is never strong, whatever the reads said, and neither is an exit, a
 * want the model did not argue for (unargued), or a swap the pool would not fill (failed): a pool that refused the
 * desk's own fill is a bad convoy target whatever its measured depth (review of 2026-09-08).
 */
export function strongSignal(row: Pick<SignalRow, "grade" | "entry" | "holders" | "launch" | "depthUsd" | "blacklisted" | "stance">, conviction: number | null, rules: ConvoyRules): boolean {
  if (row.grade !== "A") return false;
  if (!row.entry.ok) return false;
  if (!row.holders.complete || !row.holders.ok) return false;
  if (!row.launch.complete || !row.launch.ok) return false;
  if (row.depthUsd == null || !(row.depthUsd >= rules.depthMult * rules.maxSwapUsd)) return false;
  if (row.blacklisted) return false;
  const wanted = row.stance.kind === "took" || row.stance.kind === "add-on" || row.stance.kind === "full" || row.stance.kind === "spaced" || row.stance.kind === "brake" || row.stance.kind === "refused";
  if (!wanted) return false;
  return conviction != null && conviction >= rules.topConviction;
}

/** PURE: the rows for one cycle's board. */
export function signalRows(i: SignalInputs): SignalRow[] {
  const out: SignalRow[] = [];
  for (const t of i.board) {
    const er = t.entry ?? null;
    const hr = t.holders ?? null;
    const lr = t.launch ?? null;
    const holdersComplete = holderReadComplete(hr);
    const launchComplete = launchReadComplete(lr);
    const stance = stanceFor(t.symbol, i);
    const row: SignalRow = {
      at: i.at,
      cycleId: i.cycleId,
      symbol: t.symbol,
      token: t.token ?? null,
      poolId: t.poolId ?? null,
      lane: t.lane,
      grade: t.grade?.grade ?? null,
      capUsd: t.grade ? t.grade.capUsd : null,
      priceUsd: t.priceUsd ?? null,
      depthUsd: t.grade?.depthUsd ?? null,
      entry: { ok: !!er?.ok, kind: er?.state ?? null, why: er ? clip(er.why) : "no tape was read this cycle" },
      holders: {
        ok: holdersComplete && !!hr?.ok,
        complete: holdersComplete,
        wallets: holdersComplete ? hr.wallets : null,
        largestPct: holdersComplete ? hr.top1Pct : null,
        topTenPct: holdersComplete ? hr.top10Pct : null,
        why: holdersComplete ? clip(hr.why) : `not read (${t.failed?.holders ?? (hr ? "no transfers were read" : "not made this cycle")})`,
      },
      launch: {
        ok: launchComplete && !!lr?.verdict?.ok,
        complete: launchComplete,
        score: launchComplete ? lr.score?.total ?? null : null,
        devSharePct: launchComplete ? lr.devSharePct ?? null : null,
        why: launchComplete ? clip(lr.exists ? lr.verdict?.why ?? "" : "not a pons v2 launch, nothing to read") : `not read (${t.failed?.launch ?? (lr ? "the factory record could not be read" : "not made this cycle")})`,
      },
      tape: { buyPressurePct: t.tape?.buyPressurePct ?? null, trend: t.tape?.trend ?? null },
      proven: t.known ? t.known.proven : null,
      blacklisted: !!t.known?.blacklisted,
      deskHeld: t.held,
      stance,
      strong: false,
    };
    row.strong = strongSignal(row, i.conviction, i.rules);
    out.push(row);
  }
  return out;
}

const clock = (ts: number): string => new Date(ts).toISOString().slice(11, 16) + "Z";
const usd = (v: number | null): string => (v == null || !Number.isFinite(v) ? "unknown" : `$${Math.round(v).toLocaleString("en-US")}`);
const pct = (v: number | null): string => (v == null || !Number.isFinite(v) ? "?" : `${Math.round(v)}%`);
const STANCE_WORD: Record<StanceKind, string> = { took: "Took it", held: "Held", full: "Full", spaced: "Spaced", brake: "Brake", refused: "Refused", unargued: "Unargued", failed: "Failed", "add-on": "Added", exit: "Sold" };

/** PURE: one line per row for the console, sentence case, the stance last. */
export function signalLines(rows: SignalRow[]): string[] {
  return rows.map((r) => {
    const holders = !r.holders.complete ? "holders not read" : r.holders.ok ? `holders ok (${r.holders.wallets ?? "?"} wallets, largest ${pct(r.holders.largestPct)})` : `holders fail (${clip(r.holders.why, 60)})`;
    const launch = !r.launch.complete ? "launch not read" : r.launch.ok ? `launch ok${r.launch.score != null ? ` (score ${r.launch.score})` : ""}` : `launch fail (${clip(r.launch.why, 60)})`;
    const facts = [
      `grade ${r.grade ?? "none"}`,
      `${r.lane} lane`,
      `depth ${usd(r.depthUsd)}`,
      `entry ${r.entry.ok ? "ok" : "no"}${r.entry.kind ? ` (${r.entry.kind})` : ""}`,
      holders,
      launch,
      `buyers ${pct(r.tape.buyPressurePct)}`,
      `tape ${r.tape.trend ?? "unread"}`,
      ...(r.deskHeld ? ["held by the desk"] : []),
      ...(r.blacklisted ? ["blacklisted"] : []),
      ...(r.strong ? ["strong"] : []),
    ];
    return `${r.symbol}: ${facts.join(", ")}. ${STANCE_WORD[r.stance.kind]}: ${r.stance.why}`;
  });
}

/** PURE: the console's answer to /signals: a header with the cycle time and the strong count, then the rows. */
export function signalBoardLines(rows: SignalRow[], n?: number): string[] {
  if (!rows.length) return ["No signals yet. The desk writes its board every time it thinks."];
  const strong = rows.filter((r) => r.strong).length;
  const shown = n != null && n > 0 ? rows.slice(0, n) : rows;
  return [`Board at ${clock(rows[0].cycleId)}: ${rows.length} token${rows.length === 1 ? "" : "s"}, ${strong} strong.`, ...signalLines(shown)];
}

const isRow = (r: unknown): r is SignalRow => !!r && typeof r === "object" && Number.isFinite((r as SignalRow).at) && Number.isFinite((r as SignalRow).cycleId) && typeof (r as SignalRow).symbol === "string" && !!(r as SignalRow).stance;

/** PURE: the rows in a chunk of the ledger's text, a bad line skipped as readLedger skips it. */
function parseRows(text: string): SignalRow[] {
  const out: SignalRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as unknown;
      if (isRow(r)) out.push(r);
    } catch {
      /* a partial or bad line is not a row */
    }
  }
  return out;
}

/** The whole history: the rows written at or after sinceMs, oldest first. Reads every line; the board reads the tail. */
export function readSignals(sinceMs = 0): SignalRow[] {
  return readLedger<SignalRow>(SIGNALS_LEDGER).filter((r) => isRow(r) && r.at >= sinceMs);
}

/**
 * The rows in the ledger's last `bytes` bytes, oldest first. The ledger is append-only and never rotated, so the
 * board is read from the tail, not the whole file: the review of 2026-09-08 found every /signals request (and, in
 * the next step, every follower's read) parsing the full history. The first line of the chunk is dropped when the
 * chunk starts mid-file, since it is a partial row. A file that cannot be read is an empty tail, never a throw.
 */
export function tailSignals(bytes = TAIL_BYTES): SignalRow[] {
  const p = dataPath(SIGNALS_LEDGER);
  if (!existsSync(p)) return [];
  let fd: number | null = null;
  try {
    fd = openSync(p, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - Math.max(1, bytes));
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    let text = buf.subarray(0, got).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl < 0 ? "" : text.slice(nl + 1);
    }
    return parseRows(text);
  } catch (e) {
    console.error(`[signals] the ledger's tail could not be read: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  } finally {
    if (fd != null) closeSync(fd);
  }
}

/** PURE: the rows of the latest cycle in a list, in the order they were written. */
export function latestBoardOf(rows: SignalRow[]): SignalRow[] {
  let latest = -Infinity;
  for (const r of rows) if (r.cycleId > latest) latest = r.cycleId;
  return rows.filter((r) => r.cycleId === latest);
}

/** The latest cycle's rows, from the ledger's tail. */
export function latestBoard(): SignalRow[] {
  return latestBoardOf(tailSignals());
}

/** The last n rows for one symbol within the ledger's tail, newest first. */
export function signalsFor(symbol: string, n = 10): SignalRow[] {
  const s = symbol.toUpperCase();
  return tailSignals().filter((r) => r.symbol.toUpperCase() === s).slice(-Math.max(1, n)).reverse();
}

/**
 * Build the rows and append them, one row each; the one line the log carries per write. appendLedger never throws
 * and says whether the row landed, so the count of rows that did is returned and logged: a full disk or a bad
 * DATA_DIR must not read as a written board (review of 2026-09-08).
 */
export function writeSignals(i: SignalInputs): { rows: SignalRow[]; strong: number; landed: number } {
  const rows = signalRows(i);
  const landed = rows.filter((r) => appendLedger(SIGNALS_LEDGER, r as unknown as Record<string, unknown>)).length;
  const strong = rows.filter((r) => r.strong).length;
  console.log(`[signals] ${landed}/${rows.length} rows landed, ${strong} strong${landed < rows.length ? "; the board did not land in full" : ""}`);
  return { rows, strong, landed };
}
