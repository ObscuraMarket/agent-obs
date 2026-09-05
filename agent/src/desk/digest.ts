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
  holders?: { ok: boolean; why: string };
  launch?: { ok: boolean; score: number | null; why: string };
  records?: string;
  tape?: string;
}

export interface ThoughtDigest {
  verdict: Verdict;
  /** One sentence a newcomer follows. */
  headline: string;
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
      tok(m[1]).holders = { ok, why: clip(ok ? summary : m[4]) };
    } else if ((m = line.match(/^Holders (\S+): not read( yet)?/))) {
      tok(m[1]).holders = { ok: true, why: "not read yet" };
    } else if ((m = line.match(/^Launch (\S+): (.*?)(?: Score (\d+) \((.*)\)\.)? (LAUNCH OK|LAUNCH FAIL: (.*))\.$/))) {
      const ok = m[5].startsWith("LAUNCH OK");
      const bits = m[2].replace(/\.$/, "").split(";").map((s) => s.trim());
      const summary = bits.filter((b) => !b.startsWith("pons v2")).slice(0, 3).join("; ");
      tok(m[1]).launch = { ok, score: m[3] ? Number(m[3]) : null, why: clip(ok ? summary : m[6]) };
    } else if ((m = line.match(/^Launch (\S+): not a pons v2 launch/))) {
      tok(m[1]).launch = { ok: true, score: null, why: "not a pons v2 launch" };
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
  let headline = d.reason || "Holding.";
  let wanted: string | undefined;
  if (d.kind === "propose-swap") {
    const from = sym(d.from), to = sym(d.to);
    verdict = !QUOTE.has(to) ? "probe" : !QUOTE.has(from) ? "sell" : "swap";
    wanted = `${d.amount} ${from} to ${to}`;
    const reason = (d.reason || "").replace(/\s*\(sized to .*$/s, "").trim();
    headline = verdict === "probe" ? `Probes ${to} with ${d.amount} ${from}${reason ? `: ${reason}` : "."}` : verdict === "sell" ? `Sells ${from} for ${to}${reason ? `: ${reason}` : "."}` : `Swaps ${wanted}${reason ? `: ${reason}` : "."}`;
  } else {
    const m = (d.reason || "").match(/^wanted ([\d.]+) (\S+) to (\S+), refused: (.*)$/s);
    if (m) {
      verdict = "refused";
      wanted = `${m[1]} ${sym(m[2])} to ${sym(m[3])}`;
      headline = `Wanted ${wanted}; the rails refused it: ${m[4]}`;
    }
  }
  const a = t.analysis;
  const argument = a && a.thesis && !/^none\b/i.test(a.thesis.trim()) ? { thesis: a.thesis, evidence: a.evidence ?? [], invalidation: a.invalidation ?? "", conviction: a.conviction ?? null } : undefined;
  const out: ThoughtDigest = { verdict, headline: clip(headline, 300), tokens: [...tokens.values()].map((x) => ({ ...x, ...tokenStatusLine(x) })) };
  if (wanted) out.wanted = wanted;
  if (board) out.board = board;
  if (argument) out.argument = argument;
  return out;
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
