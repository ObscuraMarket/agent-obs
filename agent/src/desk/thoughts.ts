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
import type { Analysis, PriceStats, RatioStats, Session, BasisSignal } from "./analysis.ts";

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
export function observationLines(i: { reads: Reads; book: BookSnapshot; quotes: QuoteRead[]; open: Trade[]; now: number; unread?: string[]; candidates?: Array<{ symbol: string; hour: number; volUsd: number; movePct: number; senders: number; tierPct: number; ageH: number; trail: string; grade?: "A" | "B" | "C" | null; capUsd?: number; why?: string; depthUsd?: number | null }>; heldCandidates?: Array<{ symbol: string; qty: number; costUsd: number | null; valueUsd: number | null; pnlPct: number | null; ageH: number; trail: string }>; paper?: boolean; market?: { stats: PriceStats[]; ethPerNvda: RatioStats | null; btcChange24hPct: number | null; ethChange24hPct: number | null; nvdaDepthUsd: number | null; nvdaDepthBaselineUsd: number | null }; session?: Session; basis?: BasisSignal | null; reference?: { perpTradesDay: number | null; printStatus: string; printAt: string | null }; early?: Array<{ symbol: string; source: string; ageMin: number; gateOk: boolean; standard: string | null; creatorTaxBps: number | null; ignitedAfterMin: number | null; sidePoolTierPct: number | null; tradable: boolean; why: string; via?: string | null }>; tapes?: string[]; memory?: { record: string; recalls: string[] } }): string[] {
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
  if (i.basis) {
    const b = i.basis;
    const pct = (x: number | null) => (x == null ? "not measured" : `${x > 0 ? "+" : ""}${x.toFixed(2)}%`);
    lines.push(`NVDA reference: the perp venue on this chain prints ${b.perpUsd == null ? "nothing this cycle" : usd(b.perpUsd)} around the clock${i.reference?.perpTradesDay != null ? ` (${i.reference.perpTradesDay.toLocaleString("en-US")} trades today)` : ""}; the last official print was ${b.printUsd == null ? "not read" : usd(b.printUsd)}${i.reference ? ` (market ${i.reference.printStatus})` : ""}.`);
    lines.push(`Basis: the pool at ${usd(b.poolUsd)} is ${pct(b.gapToPerpPct)} against the perp and ${pct(b.gapToPrintPct)} against the print. A round trip through the pools costs ${b.roundTripCostPct.toFixed(2)}%, so the net edge is ${pct(b.netEdgePct)} against a ${b.minEdgePct.toFixed(2)}% bar: ${b.side === "buy" ? "the pool is cheap enough to BUY NVDA with USDG and sell it back when the gap closes" : b.side === "sell" ? "the pool is rich; a held NVDA position could be SOLD back to USDG" : "no basis trade this cycle"}.`);
  }
  if (i.session) {
    const when = i.session.minutesToChange != null ? ` (${i.session.open ? "pauses" : "resumes"} in ${Math.floor(i.session.minutesToChange / 60)}h${i.session.minutesToChange % 60}m)` : "";
    lines.push(
      i.session.open
        ? `NVDA trades around the clock on chain, and right now the Nasdaq print behind it is live${when}: the pool price and the print are pulling on each other.`
        : `NVDA trades around the clock on chain; the Nasdaq print behind it is paused (${i.session.label}${when}). While it is paused the on-chain price floats on its own supply and demand and converges back toward the print when Wall Street reopens. That is context for where the price stands, never a reason by itself to sit out.`,
    );
  }
  const pending = i.open.filter((t) => t.status === "pending");
  const proposed = i.open.filter((t) => t.status === "proposed");
  if (pending.length) lines.push(`In flight: ${pending.map((t) => `${qty(t.from.amount)} ${t.from.asset} to ${t.to.asset} via ${t.partner ?? "a route"}`).join("; ")}.`);
  if (proposed.length) lines.push(`Proposed and awaiting the operator: ${proposed.map((t) => `${qty(t.from.amount)} ${t.from.asset} to ${t.to.asset}`).join("; ")}.`);
  if (i.paper) lines.push("PAPER SESSION: the book above includes simulated trades at full size; nothing has been sent on chain.");
  if (i.quotes.length) lines.push(`Quotes this cycle: ${i.quotes.map((q) => `${qty(q.amountIn)} ${q.from} to ${q.amountOut == null ? "no quote" : `${qty(q.amountOut)} ${q.to}`}${q.partner ? ` (${q.partner})` : ""}`).join("; ")}.`);
  // The launches are the job: candidates, early launches, the tapes, the record and what is held reach the model
  // whether or not the reference legs quoted this cycle. (Until 2026-09-05 they hung off the quotes and vanished
  // whenever the quote watchlist failed to parse, and the model was asked about tokens it had never been shown.)
  {
    lines.push(
      ...(i.candidates?.length
        ? [`Launch candidates from the watcher, graded against the bar: ${i.candidates.map((c) => `${c.symbol}@robinhood ${c.grade ? `GRADE ${c.grade}, up to ${usd(c.capUsd ?? 0)}${c.grade === "C" ? " probe only" : ""}` : "BELOW THE BAR, not tradable"}${c.why ? ` (${c.why})` : ""}: hour ${c.hour}, ${c.ageH.toFixed(1)}h ago, $${Math.round(c.volUsd).toLocaleString("en-US")} prior-hour volume, ${c.movePct >= 0 ? "+" : ""}${c.movePct.toFixed(1)}% move, ${c.senders} senders, ${c.tierPct}% fee each way${c.depthUsd != null ? `, ${usd(c.depthUsd)} of 2% depth` : ""}; since then ${c.trail}`).join("; ")}.`]
        : i.candidates ? ["Launch candidates from the watcher: none in the window."] : []),
      ...(i.early
        ? [i.early.length
            ? `Early launches from the watcher, minute one onward, newest first: ${i.early.map((e) => `${e.symbol}@robinhood (${e.source}, ${e.ageMin} min old, gate ${e.gateOk ? `ok${e.standard ? `, ${e.standard}` : ""}` : "FAILED"}${e.creatorTaxBps != null ? `, creator tax ${(e.creatorTaxBps / 100).toFixed(1)}%` : ""}, ${e.ignitedAfterMin != null ? `ignited at +${e.ignitedAfterMin} min` : "not ignited"}, ${e.sidePoolTierPct != null ? `side pool at ${e.sidePoolTierPct}%` : "no side pool"}: ${e.tradable ? `PROBE ALLOWED through its ${e.via ?? "pool"}` : e.why})`).join("; ")}.`
            : "Early launches from the watcher: none in the last 90 minutes."]
        : []),
      ...(i.tapes ?? []),
      ...(i.memory ? [i.memory.record, ...(i.memory.recalls.length ? [`Your own record on setups like the ones in play: ${i.memory.recalls.join(" | ")}.`] : [])] : []),
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
export function buildThoughtPrompt(observation: string[], recent: Thought[], journal: string, nowIso: string, canExecute: boolean, assets: string[] = DEFAULT_TRADE_ASSETS.split(","), venue: "pool" | "obscura" = "pool", candidates: string[] = [], paper = false, basisOn = false): string {
  const past = recent
    .slice(0, 4)
    .map((t) => `- (${new Date(t.at).toISOString().slice(5, 16).replace("T", " ")} UTC) ${t.thoughts.join(" ")} [decision: ${t.decision.kind}${t.decision.kind === "propose-swap" ? ` ${t.decision.amount} ${t.decision.from} to ${t.decision.to}` : ""}]`)
    .join("\n");
  return [
    `You are OBS, running Obscura's desk: a token trader on Robinhood Chain. The launches and tokens below are the job; the rest is context. This is the desk as measured at ${nowIso}. Every number you may use is here and nowhere else:`,
    "",
    ...observation.map((l) => `- ${l}`),
    "",
    past ? `Your last public thoughts, newest first:\n${past}\n` : "",
    journal ? `Your private notes to yourself from earlier cycles, oldest first:\n${journal}\n` : "",
    `Your job is to be the best trader of tokens on this chain: read every launch and every candidate first, decide which one deserves a probe or size and why, and manage what you hold with the exits the rails give you (a time stop, a floor, volume rolling over, a trailing stop off the peak once a trade is up, and a partial take-profit into strength). ETH is the book's base on this chain: every buy is paid from ETH and every sell comes back to ETH, so keep dry powder in ETH for the next probe. USDG is a hop on the way to a USDG-quoted pool, never a place to park the book, and the rails refuse a swap that would park there.${basisOn ? " Beside the tokens, a side trade is the basis: tokenized stocks trade 24 hours a day on this chain and a paused Nasdaq print only changes what the price is anchored to; when the stock's pool is cheaper than the 24-hour reference by more than the round trip costs plus the bar, buy it with USDG and sell it back to USDG when the gap closes; when the pool is rich and you hold it, sell." : ""} Work like an analyst, not a reflex. First read every data point above: the book, the quotes and what each route costs, the 24-hour moves and 7-day ranges, the typical 30-minute move, relative value, the wider market, pool depth, the session, the candidates and their hourly trails. Then either form ONE specific thesis for ONE trade (which asset, which direction, why now, what would prove it wrong) or conclude there is none. Most cycles there is none, and saying so precisely is the job. A swap is only executed when it is argued for: a thesis, at least three EVIDENCE lines each quoting a figure from the observation, an INVALIDATION, and CONVICTION of 4 or 5; anything less is recorded as a hold with the shortfall stated in public. Entries are also spaced and counted by the rails.`,
    "",
    `Think out loud, in public. Two to four short lines that a person on obscura.market will read as your reasoning. The first line says what you are doing and the one reading that decided it, in words a newcomer follows. Each further line is one specific reading behind it, naming a token and a figure. Never restate equity, PnL or the wider market; the page shows them, and they only belong in a line if they changed the decision. Plain first-person sentences. Every figure must appear in the observation above; anything else is "not measured". No addresses of any kind, no advice, no price predictions, no dates, no em dashes, no quotation marks.`,
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
    `For a swap the DECISION line is: DECISION: swap <amount> <FROM> -> <TO>, where an asset is a symbol with an optional network, for example ETH@robinhood or USDG@robinhood or USDC@erc20. Assets you may name: ${assets.join(", ")}${candidates.length ? `, and the launch candidates listed in the observation (${candidates.join(", ")})` : ""}. Both legs of every swap stay on Robinhood Chain; the rails refuse anything else, in public.${candidates.length ? " A launch token is bought from ETH and sold back to ETH through its own pool; its fee tier is paid each way. Each candidate carries a grade against the bar: GRADE A clears every threshold (big proven flow, many buyers, a contained move, a low tier, real depth, volume holding) and may be swung with size up to its cap; GRADE B may be held at ordinary size; GRADE C is probe only; BELOW THE BAR cannot be bought. A candidate whose reason begins with the word stable is a different kind of token: it has traded in most of its hours for six hours or more, sits within a contained distance of its peak, held its range, and has real senders behind it; that is the token the desk hunts for a swing on price action rather than chasing on ignition, so it is on the board at GRADE B whatever its prior hour printed, and its Entry line times the buy like anything else. The first buy of any token is always the small probe, and only a token whose sell has been proven can be scaled to its grade cap on the next cycle; scaling into a held proven token is a continuation, not a new entry. One launch position at a time; the rails sell it for you when volume rolls over two hours running, when it falls through the floor, or at the time stop, and those exits are never blocked. Profits are taken on the data, not on a number: once a trade has paid, the rails scale out the moment the tape shows the buyers thinning (buy pressure fading or five-minute volume rolling over) and trail the rest; a take-profit and a trailing stop sit behind that as backstops. You may sell into strength before the rails do when the tape says so, and you never let a paid trade go back to flat. Size belongs to grade A and B; a PROBE is a different decision with a different bar. Early launches are a separate lane: a PONS v2 launch shows from minute one with its gate, creator tax, ignition (the watcher's call that the curve has real volume and buyers inside its first minutes) and any hookless side pool. A launch is a PROBE candidate once it has ignited, through a hookless side pool when one exists and otherwise through its own launch curve (where the hook's fee and the creator tax are the cost, and the fill is less predictable, so the floor sits wider); the probe is the small size, the sell is proven right after, and it scales only if it later clears the bar. Minute-one buying loses on average, ignition is the earliest signal worth a probe, and the reason must still be argued from figures. The probe's bar is not the size bar: do not ask an ignited launch for an hour of volume or the $100k print, that is what grade A and B require for SIZE. A probe asks four things: the gate passed, the tax is low, the watcher called ignition, and the tape shows real buying rather than one wallet. When those hold and the Entry line allows it, the probe is the right decision and its cost is the small size; passing on every allowed probe is not caution, it is never learning which launches pay. A probe needs no track record and no measured performance: it is how the record gets measured. An empty launch record, a Records line with no repeat winners, or a token with no history are never reasons to pass on an allowed probe; only a failed Holders or Launch read, a NO ENTRY line, or a specific figure in front of you that contradicts the thesis are. A Launch line reads the launch itself from the chain, with a score and its reasons: the dev buy as a share of supply, the wallets exempted from the opening tax (a declared bundle), the creator tax and whether its fees go to a third party, the links, the deployer's record, the curve's first minute and the phase. LAUNCH FAIL cannot be bought, and a launch that is swept sits between its curve and its pool where nothing trades until the pool exists. The tape lines are your own reading of a pool's swaps from the chain (buys against sells, buy pressure, the price path, 5-minute volume and its trend); use them before the watcher's hourly rows. Volume only puts a token on watch; the entry comes from the price action, and every token in play carries an Entry line that names it. SPIKE is the top of a run and you never buy it, however loud the volume. PULLBACK with ENTRY ALLOWED means the run gave part of itself back, held a higher low and turned up with buyers back: that is an entry. BASE with ENTRY ALLOWED means the price has gone quiet in a tight range with buyers still present: that is an entry. BREAKDOWN, WAITING and a pullback marked NO ENTRY are not entries yet. The rails refuse any launch-token buy whose Entry line says NO ENTRY, so decide with it, and when you buy, name the state you are buying. Your launch record and the recalled trades are your own history: when a like setup lost before, say what is different now or pass." : ""}`,
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
