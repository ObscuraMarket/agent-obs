// A cycle, digested for a reader. The observation is dozens of long lines
// and the model's reply is a shape for the parser; a person on the page
// wants the verdict, one sentence on why, and the state of each token in
// play. This is a pure reduction of a recorded thought into that: nothing
// is added, every field traces to a line the agent was shown or wrote. It
// travels with each thought on the API and the stream, and the page draws
// it; the raw lines stay one click away.
import type { Thought } from "./thoughts.ts";

export type Verdict = "hold" | "probe" | "sell" | "swap" | "refused";

export interface TokenDigest {
  symbol: string;
  role: "held" | "launch";
  /** The one-line status the page shows, and its tone. */
  line: string;
  tone: "good" | "bad" | "quiet";
  entry?: { state: string; ok: boolean; why: string };
  /** `short` is the failing reason in a few words, for a chip; `why` is the whole of it. */
  holders?: { ok: boolean; why: string; short: string };
  launch?: { ok: boolean; score: number | null; why: string; short: string };
  records?: string;
  tape?: string;
}

export interface ThoughtDigest {
  verdict: Verdict;
  /** One sentence a newcomer follows. */
  headline: string;
  /** The agent's own lines, without repeats and without the one that restates the headline. */
  lines: string[];
  /** The swap that was refused or proposed, as "0.002 ETH to COFF". */
  wanted?: string;
  tokens: TokenDigest[];
  /** What the board held this cycle: early launches and graded candidates, in counts. */
  board?: { early: number; probeAllowed: number; gateFailed: number; graded: number; belowBar: number };
  argument?: { thesis: string; evidence: string[]; invalidation: string; conviction: number | null };
}

const QUOTE = new Set(["ETH", "USDG", "USDC", "USDT", "DAI", "NVDA", "OBS"]);
const sym = (s: string | undefined) => (s ?? "").split("@")[0].toUpperCase();
const clip = (s: string, n = 150) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** PURE: a failing reason in a few words, for a chip. The first clause, in the desk's own shorthand. */
export function shortWhy(why: string): string {
  const first = why.split(";")[0].split(/,\s+(?=the |\d|it |a )/)[0].trim();
  const rules: Array<[RegExp, string]> = [
    [/^the dev buy is ([\d.]+%)/, "dev buy $1"],
    [/^(\d+) wallets? were exempted/, "$1 exempt wallets"],
    [/^the largest wallet holds ([\d.]+%)/, "largest $1"],
    [/^the top ten hold ([\d.]+%)/, "top ten $1"],
    [/^(\d+) wallets \(\d+ needed\)/, "$1 wallets"],
    [/^([\d.]+%) of the first buyers look bundled/, "$1 bundled"],
    [/^(\d+) of the top ten wallets are fresh/, "$1 fresh wallets"],
    [/^it has no X link/, "no links"],
    [/^score (\d+) under/, "score $1"],
    [/^a serial deployer/, "serial deployer"],
    [/^the creator tax is ([\d.]+%)/, "tax $1"],
    [/^the launch is swept/, "swept"],
    [/^the launch was rescued/, "rescued"],
  ];
  for (const [re, out] of rules) if (re.test(first)) return first.replace(new RegExp(`${re.source}.*$`), out);
  return clip(first.replace(/^the /, "").replace(/\s*\(.*$/, ""), 26);
}

/** PURE: the decision's reason without the agent's preamble ("I am holding the book in ether as ..."). */
export function plainReason(reason: string): string {
  return cap(reason.replace(/^I am (holding|keeping) (the book|everything) in (ether|ETH)(,? (as|because|while|since|until|and))?\s*/i, "").replace(/^I am (probing|proposing (a )?(small )?probe (in|into)|buying|selling) \S+ (as|because|since|while)\s+/i, "").trim());
}

/** PURE: the digest of one recorded thought. */
export function digestThought(t: Thought): ThoughtDigest {
  const d = t.decision;
  const tokens = new Map<string, TokenDigest>();
  const tok = (symbol: string, role: TokenDigest["role"] = "launch") => {
    const k = symbol.toUpperCase();
    if (!tokens.has(k)) tokens.set(k, { symbol, role, line: "", tone: "quiet" });
    const x = tokens.get(k)!;
    if (role === "held") x.role = "held";
    return x;
  };
  let board: ThoughtDigest["board"] | undefined;
  for (const raw of t.observation ?? []) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^Entry (\S+) \([^)]*\): (.*)\. ([A-Z]+), (ENTRY ALLOWED|NO ENTRY)\.$/))) {
      const why = m[2].replace(/^[^;]*;\s*/, "").replace(/:\s*[a-z ]+, (entry allowed|no entry)$/i, "");
      tok(m[1]).entry = { state: m[3].toLowerCase(), ok: m[4] === "ENTRY ALLOWED", why: clip(why) };
    } else if ((m = line.match(/^Holders (\S+) \([^)]*\): (.*?)\.? (HOLDERS OK|HOLDERS FAIL: (.*))\.$/))) {
      const ok = m[3].startsWith("HOLDERS OK");
      const summary = m[2].split(";").slice(0, 3).join(";");
      tok(m[1]).holders = { ok, why: clip(ok ? summary : m[4]), short: ok ? "" : shortWhy(m[4]) };
    } else if ((m = line.match(/^Holders (\S+): not read( yet)?/))) {
      tok(m[1]).holders = { ok: true, why: "not read yet", short: "" };
    } else if ((m = line.match(/^Launch (\S+): (.*?)(?: Score (\d+) \((.*)\)\.)? (LAUNCH OK|LAUNCH FAIL: (.*))\.$/))) {
      const ok = m[5].startsWith("LAUNCH OK");
      const bits = m[2].replace(/\.$/, "").split(";").map((s) => s.trim());
      const summary = bits.filter((b) => !b.startsWith("pons v2")).slice(0, 3).join("; ");
      tok(m[1]).launch = { ok, score: m[3] ? Number(m[3]) : null, why: clip(ok ? summary : m[6]), short: ok ? "" : shortWhy(m[6]) };
    } else if ((m = line.match(/^Launch (\S+): not a pons v2 launch/))) {
      tok(m[1]).launch = { ok: true, score: null, why: "not a pons v2 launch", short: "" };
    } else if ((m = line.match(/^Records (\S+): (.*)\.$/))) {
      tok(m[1]).records = clip(m[2], 120);
    } else if ((m = line.match(/^Tape (\S+) \(last (\d+) min\): (\d+) swaps; buys \$[\d,.]+ vs sells \$[\d,.]+ \((\d+)% buy pressure\); price ([+-][\d.]+%) over the window; (\d+)% off its peak;.*?, ([a-z ]+)\.$/))) {
      tok(m[1]).tape = `${m[3]} swaps in ${m[2]} min, ${m[4]}% buy pressure, ${m[5]}, ${m[6]}% off its peak, ${m[7]}`;
    } else if ((m = line.match(/^Held launch token (\S+): (.*)$/))) {
      tok(m[1], "held");
    } else if (line.startsWith("Early launches from the watcher, minute one onward")) {
      const body = line.slice(line.indexOf(":") + 1);
      const entries = body.split(/\);\s+/).filter((s) => s.includes("@robinhood"));
      board = { ...(board ?? { graded: 0, belowBar: 0 }), early: entries.length, probeAllowed: entries.filter((e) => e.includes("PROBE ALLOWED")).length, gateFailed: entries.filter((e) => e.includes("gate FAILED")).length } as ThoughtDigest["board"];
    } else if (line.startsWith("Launch candidates from the watcher, graded against the bar")) {
      const body = line.slice(line.indexOf(":") + 1);
      const graded = (body.match(/ GRADE [ABC]/g) ?? []).length;
      const below = (body.match(/BELOW THE BAR/g) ?? []).length;
      board = { ...(board ?? { early: 0, probeAllowed: 0, gateFailed: 0 }), graded, belowBar: below } as ThoughtDigest["board"];
    }
  }
  // The verdict and its headline.
  let verdict: Verdict = "hold";
  let headline = d.reason ? plainReason(d.reason) : "Holding.";
  let wanted: string | undefined;
  if (d.kind === "propose-swap") {
    const from = sym(d.from), to = sym(d.to);
    verdict = !QUOTE.has(to) ? "probe" : !QUOTE.has(from) ? "sell" : "swap";
    wanted = `${d.amount} ${from} to ${to}`;
    const plain = plainReason((d.reason || "").replace(/\s*\(sized to .*$/s, "").trim());
    const reason = plain ? plain[0].toLowerCase() + plain.slice(1) : "";
    headline = verdict === "probe" ? `Probes ${to} with ${d.amount} ${from}${reason ? `: ${reason}` : "."}` : verdict === "sell" ? `Sells ${from} for ${to}${reason ? `: ${reason}` : "."}` : `Swaps ${wanted}${reason ? `: ${reason}` : "."}`;
  } else {
    const m = (d.reason || "").match(/^wanted ([\d.]+) (\S+) to (\S+), refused: (.*)$/s);
    if (m) {
      verdict = "refused";
      wanted = `${m[1]} ${sym(m[2])} to ${sym(m[3])}`;
      headline = `Wanted ${wanted}; the rails refused it: ${m[4]}`;
    }
  }
  // The agent's lines without repeats, and without the one that is the headline again.
  const seen = new Set<string>();
  const norm = (s: string) => s.trim().toLowerCase().replace(/[.\s]+$/, "");
  const lines: string[] = [];
  for (const l of t.thoughts ?? []) {
    const k = norm(l);
    if (!k || seen.has(k) || k === norm(d.reason || "") || k === norm(headline)) continue;
    seen.add(k);
    lines.push(l);
  }
  const a = t.analysis;
  const argument = a && a.thesis && !/^none\b/i.test(a.thesis.trim()) ? { thesis: a.thesis, evidence: a.evidence ?? [], invalidation: a.invalidation ?? "", conviction: a.conviction ?? null } : undefined;
  const out: ThoughtDigest = { verdict, headline: clip(headline, 300), lines, tokens: [...tokens.values()].map((x) => ({ ...x, ...tokenStatusLine(x) })) };
  if (wanted) out.wanted = wanted;
  if (board) out.board = board;
  if (argument) out.argument = argument;
  return out;
}

/** The live watch, as one line for the terminal between cycles. */
export interface WatchEvent {
  at: number;
  block: number | null;
  lookMs: number | null;
  /** "watching JOHN breakdown, BOW quiet; looks 0.8 s" */
  line: string;
  /** The last trigger the watch fired, verbatim, when there is one. */
  trigger: string | null;
  cycleRunning: boolean;
}

/** PURE: the live watch's file reduced to a line. Null when the file is stale (older than 30 s) or empty. */
export function watchEvent(live: { at?: number; block?: number | null; lookMs?: number | null; watching?: Array<{ symbol: string; role?: string; entryState?: string; entryOk?: boolean; trend?: string }>; lastTrigger?: string | null; cycleRunning?: boolean } | null, now = Date.now()): WatchEvent | null {
  if (!live || !live.at || now - live.at > 30_000) return null;
  const w = live.watching ?? [];
  const what = w.length
    ? w.map((s) => `${s.symbol} ${s.entryOk ? `ENTRY (${s.entryState})` : s.role === "held" ? `held, ${s.trend ?? "holding"}` : s.entryState ?? "watching"}`).join(", ")
    : "nothing in play";
  const looks = live.lookMs != null ? `; looks ${(live.lookMs / 1000).toFixed(1)} s` : "";
  return { at: live.at, block: live.block ?? null, lookMs: live.lookMs ?? null, line: `watching ${what}${looks}`, trigger: live.lastTrigger ?? null, cycleRunning: !!live.cycleRunning };
}

/** PURE: one short status line per token, the way the page shows it. */
export function tokenStatusLine(x: Omit<TokenDigest, "line" | "tone">): { line: string; tone: "good" | "bad" | "quiet" } {
  const bits: string[] = [];
  let bad = false;
  if (x.entry) { bits.push(x.entry.ok ? `entry: ${x.entry.state}, allowed` : `entry: ${x.entry.state}, none`); }
  if (x.holders) { bits.push(x.holders.ok ? "holders: ok" : `holders: FAIL, ${x.holders.why}`); if (!x.holders.ok) bad = true; }
  if (x.launch) { bits.push(x.launch.ok ? `launch: ok${x.launch.score != null ? ` ${x.launch.score}` : ""}` : `launch: FAIL, ${x.launch.why}`); if (!x.launch.ok) bad = true; }
  if (x.tape && !x.entry) bits.push(`tape: ${x.tape}`);
  if (x.role === "held") bits.unshift("held");
  const tone = bad ? "bad" : x.entry?.ok ? "good" : "quiet";
  return { line: bits.join(" · ") || "in play", tone };
}
