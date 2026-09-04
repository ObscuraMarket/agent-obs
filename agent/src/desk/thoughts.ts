// OBS's public reasoning. Each desk cycle the operator persona is handed a
// measured observation (the book, the reads, any quotes, anything in flight)
// and thinks out loud in a few short lines that people on obscura.market can
// read, then states a decision. The lines are public by design and pass the
// same guards as a tweet; the NOTE at the end is private and goes to his
// journal. The arithmetic is here; the model only explains it.
//
// A swap decision is a PROPOSAL. Nothing in this file moves funds. Execution
// is a separate, deliberate stage with its own rails, and until it exists a
// proposal is exactly what the dashboard shows it as.
import { appendLedger, readLedger } from "../ledger.ts";
import { DEFAULT_TRADE_ASSETS } from "./rails.ts";
import { forbiddenReason, stripDashes } from "../social/postGuards.ts";
import { walletLines, marketLine, type Reads } from "../obscura/reads.ts";
import type { BookSnapshot, Trade } from "./book.ts";
import type { Analysis, PriceStats, RatioStats, Session } from "./analysis.ts";

export interface Decision {
  kind: "hold" | "propose-swap";
  /** Asset specs as the registry reads them: "ETH" or "ETH@robinhood". */
  from?: string;
  to?: string;
  amount?: number;
  reason: string;
}

export interface Thought {
  at: number;
  /** The measured lines the model was handed. Public, so a reader can check the thinking against them. */
  observation: string[];
  /** The model's public reasoning, guarded. */
  thoughts: string[];
  decision: Decision;
  /** Set when the cycle ran as a paper session. */
  paper?: boolean;
  /** The argument behind the decision: thesis, evidence lines, invalidation, conviction 1 to 5. */
  analysis?: Analysis;
}

export interface QuoteRead {
  from: string;
  to: string;
  amountIn: number;
  amountOut: number | null;
  partner: string | null;
  at: number;
}

const usd = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 6 });

/** PURE: the measured observation. Every number the model may use is here. */
export function observationLines(i: { reads: Reads; book: BookSnapshot; quotes: QuoteRead[]; open: Trade[]; now: number; unread?: string[]; candidates?: Array<{ symbol: string; hour: number; volUsd: number; movePct: number; senders: number; tierPct: number; ageH: number; trail: string; grade?: "A" | "B" | "C" | null; capUsd?: number; why?: string; depthUsd?: number | null }>; heldCandidates?: Array<{ symbol: string; qty: number; costUsd: number | null; valueUsd: number | null; pnlPct: number | null; ageH: number; trail: string }>; paper?: boolean; market?: { stats: PriceStats[]; ethPerNvda: RatioStats | null; btcChange24hPct: number | null; ethChange24hPct: number | null; nvdaDepthUsd: number | null; nvdaDepthBaselineUsd: number | null }; session?: Session }): string[] {
  const lines: string[] = [];
  if (i.unread?.length) lines.push(`Balances the chain did not answer for this cycle, excluded from equity, not zero: ${i.unread.join(", ")}. Do not size anything against them.`);
  const h = Object.entries(i.book.holdings);
  if (!h.length && i.book.netCapitalUsd === 0) lines.push("Book: no capital yet. The desk holds nothing and has been handed nothing; there is nothing to trade and nothing to mark.");
  else {
    lines.push(`Book: ${h.length ? h.map(([a, q]) => `${qty(q)} ${a}`).join(", ") : "empty"}${i.book.inFlightUsd > 0 ? `, ${usd(i.book.inFlightUsd)} in flight` : ""}.`);
    lines.push(
      `Equity ${i.book.equityUsd == null ? "not priced this cycle" : usd(i.book.equityUsd)} against ${usd(i.book.netCapitalUsd)} net capital; PnL ${i.book.pnlUsd == null ? "not measured" : `${usd(i.book.pnlUsd)}${i.book.pnlPct != null ? ` (${(i.book.pnlPct * 100).toFixed(2)}%)` : ""}`}.${i.book.unpriced.length ? ` Unpriced and excluded: ${i.book.unpriced.join(", ")}.` : ""}`,
    );
  }
  if (i.market) {
    const pct = (v: number | null, signed = true) => (v == null ? "not measured" : `${signed && v > 0 ? "+" : ""}${v.toFixed(2)}%`);
    for (const st of i.market.stats) {
      if (st.priceUsd == null) continue;
      const bits = [`${st.symbol} at ${st.symbol === "ETH" || st.priceUsd >= 1 ? usd(st.priceUsd) : `$${st.priceUsd.toPrecision(3)}`}`, `24h ${pct(st.change24hPct)}`];
      if (st.low7d != null && st.high7d != null && st.rangePosPct != null) bits.push(`7-day range ${usd(st.low7d)} to ${usd(st.high7d)}, sitting at ${st.rangePosPct.toFixed(0)}% of it`);
      if (st.move30mPct != null) bits.push(`typical 30-minute move ${st.move30mPct.toFixed(2)}%`);
      bits.push(st.historyH < 24 ? `${st.historyH.toFixed(0)}h of history so far` : `${st.samples} samples over ${(st.historyH / 24).toFixed(1)} days`);
      lines.push(`${bits.join("; ")}.`);
    }
    if (i.market.ethPerNvda?.ratioNow != null) lines.push(`Relative value: one ETH buys ${i.market.ethPerNvda.ratioNow.toFixed(3)} NVDA${i.market.ethPerNvda.deviationPct != null ? `, ${pct(i.market.ethPerNvda.deviationPct)} against its 7-day average` : ", no 7-day average yet"}.`);
    if (i.market.btcChange24hPct != null || i.market.ethChange24hPct != null) lines.push(`Backdrop: BTC ${pct(i.market.btcChange24hPct)} and ETH ${pct(i.market.ethChange24hPct)} over 24h on the wider market.`);
    if (i.market.nvdaDepthUsd != null) lines.push(`NVDA pool depth: ${usd(i.market.nvdaDepthUsd)} moves it 2%${i.market.nvdaDepthBaselineUsd != null ? `, against ${usd(i.market.nvdaDepthBaselineUsd)} when the pool was last measured for the chain memory` : ""}.`);
  }
  if (i.session) lines.push(`US equities: ${i.session.label}${i.session.minutesToChange != null ? ` (${i.session.open ? "closes" : "opens"} in ${Math.round(i.session.minutesToChange / 60)}h${i.session.minutesToChange % 60}m)` : ""}. NVDA's pool tracks the live print only while the session is open; off-hours it drifts from a stale one.`);
  const pending = i.open.filter((t) => t.status === "pending");
  const proposed = i.open.filter((t) => t.status === "proposed");
  if (pending.length) lines.push(`In flight: ${pending.map((t) => `${qty(t.from.amount)} ${t.from.asset} to ${t.to.asset} via ${t.partner ?? "a route"}`).join("; ")}.`);
  if (proposed.length) lines.push(`Proposed and awaiting the operator: ${proposed.map((t) => `${qty(t.from.amount)} ${t.from.asset} to ${t.to.asset}`).join("; ")}.`);
  if (i.quotes.length) {
    lines.push(
      ...(i.paper ? ["PAPER SESSION: the book above includes simulated trades at full size; nothing has been sent on chain."] : []),
      `Quotes this cycle: ${i.quotes.map((q) => `${qty(q.amountIn)} ${q.from} to ${q.amountOut == null ? "no quote" : `${qty(q.amountOut)} ${q.to}`}${q.partner ? ` (${q.partner})` : ""}`).join("; ")}.`,
      ...(i.candidates?.length
        ? [`Launch candidates from the watcher, graded against the bar: ${i.candidates.map((c) => `${c.symbol}@robinhood ${c.grade ? `GRADE ${c.grade}, up to ${usd(c.capUsd ?? 0)}${c.grade === "C" ? " probe only" : ""}` : "BELOW THE BAR, not tradable"}${c.why ? ` (${c.why})` : ""}: hour ${c.hour}, ${c.ageH.toFixed(1)}h ago, $${Math.round(c.volUsd).toLocaleString("en-US")} prior-hour volume, ${c.movePct >= 0 ? "+" : ""}${c.movePct.toFixed(1)}% move, ${c.senders} senders, ${c.tierPct}% fee each way${c.depthUsd != null ? `, ${usd(c.depthUsd)} of 2% depth` : ""}; since then ${c.trail}`).join("; ")}.`]
        : i.candidates ? ["Launch candidates from the watcher: none in the window."] : []),
      ...(i.heldCandidates?.length
        ? i.heldCandidates.map((h) => `Held launch token ${h.symbol}: ${qty(h.qty)}, cost ${h.costUsd == null ? "unknown" : usd(h.costUsd)}, now ${h.valueUsd == null ? "unpriced" : usd(h.valueUsd)}${h.pnlPct == null ? "" : ` (${h.pnlPct >= 0 ? "+" : ""}${h.pnlPct.toFixed(1)}%)`}, held ${h.ageH.toFixed(1)}h; hourly volume ${h.trail}.`)
        : []),
    );
  }
  if (i.reads.prices.btcUsd != null) lines.push(`BTC ${usd(i.reads.prices.btcUsd)}.`);
  if (i.reads.prices.ethUsd != null) lines.push(`ETH ${usd(i.reads.prices.ethUsd)}.`);
  if (i.reads.token.symbol) lines.push(`${i.reads.token.name ?? i.reads.token.symbol} (${i.reads.token.symbol}) on Robinhood Chain${i.reads.token.holders != null ? `, ${i.reads.token.holders.toLocaleString("en-US")} holders` : ""}.`);
  if (i.reads.market) lines.push(marketLine(i.reads.market));
  for (const l of walletLines(i.reads.wallet)) lines.push(l.replace(/^- /, ""));
  lines.push(`Obscura: the app is ${i.reads.siteUp ? "up" : "not answering"}, the routing API ${i.reads.apiUp ? "healthy" : "not answering"}.`);
  return lines;
}

/** The prompt for the operator persona. Public thoughts, private note. */
export function buildThoughtPrompt(observation: string[], recent: Thought[], journal: string, nowIso: string, canExecute: boolean, assets: string[] = DEFAULT_TRADE_ASSETS.split(","), venue: "pool" | "obscura" = "pool", candidates: string[] = [], paper = false): string {
  const past = recent
    .slice(0, 4)
    .map((t) => `- (${new Date(t.at).toISOString().slice(5, 16).replace("T", " ")} UTC) ${t.thoughts.join(" ")} [decision: ${t.decision.kind}${t.decision.kind === "propose-swap" ? ` ${t.decision.amount} ${t.decision.from} to ${t.decision.to}` : ""}]`)
    .join("\n");
  return [
    `You are OBS, running Obscura's desk. This is the desk as measured at ${nowIso}. Every number you may use is here and nowhere else:`,
    "",
    ...observation.map((l) => `- ${l}`),
    "",
    past ? `Your last public thoughts, newest first:\n${past}\n` : "",
    journal ? `Your private notes to yourself from earlier cycles, oldest first:\n${journal}\n` : "",
    `Work like an analyst, not a reflex. First read every data point above: the book, the quotes and what each route costs, the 24-hour moves and 7-day ranges, the typical 30-minute move, relative value, the wider market, pool depth, the session, the candidates and their hourly trails. Then either form ONE specific thesis for ONE trade (which asset, which direction, why now, what would prove it wrong) or conclude there is none. Most cycles there is none, and saying so precisely is the job. A swap is only executed when it is argued for: a thesis, at least three EVIDENCE lines each quoting a figure from the observation, an INVALIDATION, and CONVICTION of 4 or 5; anything less is recorded as a hold with the shortfall stated in public. Entries are also spaced and counted by the rails.`,
    "",
    `Think out loud, in public. Two to five short lines that a person on obscura.market will read as your reasoning: what you see, what it means, what you would do and why not yet. Plain first-person sentences. Every figure must appear in the observation above; anything else is "not measured". No addresses of any kind, no advice, no price predictions, no dates, no em dashes, no quotation marks.`,
    "",
    canExecute
      ? venue === "pool"
        ? `Then decide. A swap you decide on is executed on chain from the desk's own wallet, in the USDG pools on Robinhood Chain, inside the rails in code (a per-swap cap, a daily cap, one open order at a time, an asset allowlist, a gas reserve, a cost floor against the pool mark). The pool quotes in the observation are the prices you actually get. Size small; the rails refuse anything else and the refusal is public. Trade only when the reason is real: a dislocation you can name, a risk you are cutting, a position you want at this price.`
        : `Then decide. A swap you decide on is executed through Obscura from the desk's own wallet, inside the rails in code (a per-swap cap, a daily cap, one open order at a time, an asset allowlist, a gas reserve). Size small; the rails refuse anything else and the refusal is public. Every swap through Obscura earns the desk cashback in tokenized stocks, which is the earning leg: trade only when the route and the reason are real, never to farm the rebate.`
      : `Then decide. You cannot execute anything yet: a swap decision is a proposal the operator sees on the dashboard, and you say so nowhere except in the DECISION line.`,
    "",
    paper ? "This is a paper session: a swap you decide on is priced against the live pools and recorded as a paper trade at full size, and nothing is sent on chain. Decide exactly as you would with real money; the point is to see what you would do." : "",
    "Reply in exactly this shape, one item per line:",
    "THOUGHT: <a line>",
    "THOUGHT: <another line>",
    "THESIS: <the one trade you would make and why now, or: none>",
    "EVIDENCE: <one observed figure and what it means>",
    "EVIDENCE: <another>",
    "EVIDENCE: <another>",
    "INVALIDATION: <what would prove the thesis wrong>",
    "CONVICTION: <1 to 5>",
    "DECISION: hold",
    "REASON: <one sentence>",
    "NOTE: <one private sentence to yourself, fed back next cycle>",
    "",
    `For a swap the DECISION line is: DECISION: swap <amount> <FROM> -> <TO>, where an asset is a symbol with an optional network, for example ETH@robinhood or USDG@robinhood or USDC@erc20. Assets you may name: ${assets.join(", ")}${candidates.length ? `, and the launch candidates listed in the observation (${candidates.join(", ")})` : ""}. Both legs of every swap stay on Robinhood Chain; the rails refuse anything else, in public.${candidates.length ? " A launch token is bought from ETH and sold back to ETH through its own pool; its fee tier is paid each way. Each candidate carries a grade against the bar: GRADE A clears every threshold (big proven flow, many buyers, a contained move, a low tier, real depth, volume holding) and may be swung with size up to its cap; GRADE B may be held at ordinary size; GRADE C is probe only; BELOW THE BAR cannot be bought. The first buy of any token is always the small probe, and only a token whose sell has been proven can be scaled to its grade cap on the next cycle; scaling into a held proven token is a continuation, not a new entry. One launch position at a time; the rails sell it for you when volume rolls over two hours running, when it falls through the floor, or at the time stop, and those exits are never blocked. Spend a thesis on grade A and B only." : ""}`,
  ]
    .filter((s) => s !== undefined)
    .join("\n");
}

/** PURE: the reply, parsed forgivingly. Unlabelled lines count as thoughts. */
export function parseThoughtReply(raw: string): { thoughts: string[]; decision: Decision; note: string; analysis: Analysis | null } {
  const thoughts: string[] = [];
  let decision: Decision = { kind: "hold", reason: "" };
  let reason = "";
  let note = "";
  const analysis: Analysis = { thesis: "", evidence: [], invalidation: "", conviction: null };
  let stated = false;
  for (const rawLine of (raw ?? "").split("\n")) {
    const line = rawLine.replace(/^[\s>*-]+/, "").trim();
    if (!line) continue;
    const m = line.match(/^(THOUGHT|THESIS|EVIDENCE|INVALIDATION|CONVICTION|DECISION|REASON|NOTE)\s*:\s*(.*)$/i);
    if (!m) {
      if (!note && !reason && !stated) thoughts.push(line);
      continue;
    }
    const key = m[1].toUpperCase();
    const val = m[2].trim();
    if (key === "THOUGHT") thoughts.push(val);
    else if (key === "THESIS") {
      stated = true;
      analysis.thesis = /^none\b/i.test(val) ? "" : stripDashes(val).slice(0, 300);
    } else if (key === "EVIDENCE") {
      stated = true;
      if (val) analysis.evidence.push(stripDashes(val).slice(0, 240));
    } else if (key === "INVALIDATION") {
      stated = true;
      analysis.invalidation = /^none\b/i.test(val) ? "" : stripDashes(val).slice(0, 240);
    } else if (key === "CONVICTION") {
      stated = true;
      const n = Number((val.match(/\d+/) ?? [])[0]);
      analysis.conviction = Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
    } else if (key === "REASON") reason = val;
    else if (key === "NOTE") note = val;
    else if (key === "DECISION") {
      const swap = val.match(/^swap\s+([\d.]+)\s+([A-Za-z0-9]+(?:@[A-Za-z0-9-]+)?)\s*(?:->|to)\s*([A-Za-z0-9]+(?:@[A-Za-z0-9-]+)?)/i);
      if (swap && Number(swap[1]) > 0) {
        const norm = (s: string) => {
          const [sym, net] = s.split("@");
          return net ? `${sym.toUpperCase()}@${net.toLowerCase()}` : sym.toUpperCase();
        };
        decision = { kind: "propose-swap", amount: Number(swap[1]), from: norm(swap[2]), to: norm(swap[3]), reason: "" };
      }
      else decision = { kind: "hold", reason: "" };
    }
  }
  decision.reason = stripDashes(reason).slice(0, 300);
  return { thoughts, decision, note: stripDashes(note).slice(0, 400), analysis: stated ? analysis : null };
}

/** PURE: the public lines after the same boundaries a tweet passes. */
export function guardThoughts(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const s = stripDashes(l).replace(/^["']|["']$/g, "").trim();
    if (!s || s.length < 8) continue;
    if (forbiddenReason(s)) continue;
    out.push(s.slice(0, 240));
    if (out.length === 5) break;
  }
  return out;
}

export function readThoughts(limit = 20): Thought[] {
  return readLedger<Thought>("obs-thoughts.jsonl")
    .filter((t) => t && Number.isFinite(Number(t.at)) && Array.isArray(t.thoughts))
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(1, Math.min(limit, 200)));
}
export function recordThought(t: Thought): void {
  appendLedger("obs-thoughts.jsonl", t as unknown as Record<string, unknown>);
}
