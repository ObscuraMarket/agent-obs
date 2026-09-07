// The desk's read-only commands as lines of text, from the same payloads the page reads. Pure formatters: the
// route hands in what the API already builds, so the console and the page can never disagree about a number.
const usd = (v: unknown, digits = 0): string => (v == null || !Number.isFinite(Number(v)) ? "n/a" : `${Number(v) < 0 ? "-" : ""}$${Math.abs(Number(v)).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);
const pct = (v: unknown): string => (v == null || !Number.isFinite(Number(v)) ? "n/a" : `${Number(v) >= 0 ? "+" : ""}${(Number(v) * 100).toFixed(1)}%`);
const clock = (ts: number): string => new Date(ts).toISOString().slice(11, 16) + "Z";

type Any = Record<string, any>;

export function statusLines(status: Any, pnl: Any): string[] {
  const d = status.desk ?? {};
  const r = status.rails;
  const held = ((pnl.positions ?? []) as Any[]).filter((x) => x.asset !== "ETH");
  return [
    `equity ${usd(d.equityUsd)}  pnl ${usd(d.pnlUsd)} (${pct(d.pnlPct)})  capital ${usd(d.netCapitalUsd)}  last cycle ${d.lastThoughtAt ? clock(d.lastThoughtAt) : "n/a"}`,
    ...(r ? [`trading ${r.tradingOn ? "on" : "off"}  size ${usd(r.maxSwapUsd)} a trade  open orders ${r.openOrders} of ${r.maxOpenOrders ?? "?"}`] : []),
    ...(status.wallet?.address ? [`the desk's wallet ${status.wallet.address}`] : []),
    held.length ? `holding ${held.map((x) => `${x.asset} ${usd(x.valueUsd)} (${pct(x.unrealizedPct)})`).join(", ")}` : "holding nothing but ETH",
  ];
}

export function positionsLines(pnl: Any): string[] {
  const out = ["positions"];
  for (const x of (pnl.positions ?? []) as Any[]) out.push(`  ${String(x.asset).padEnd(10)}${usd(x.valueUsd, 2).padStart(12)}  ${pct(x.unrealizedPct).padStart(8)}  share ${Math.round((x.share ?? 0) * 100)}%`);
  const closed = ((pnl.closed ?? []) as Any[]).slice(0, 10);
  if (closed.length) {
    out.push("closed, last 24 hours");
    for (const c of closed) out.push(`  ${clock(c.closedAt)}  ${String(c.asset).padEnd(10)}${usd(c.resultUsd, 2).padStart(10)}  ${c.heldMin} min  ${c.how}`);
  }
  return out;
}

export function thoughtsLines(items: Any[]): string[] {
  const out: string[] = [];
  for (const x of items) {
    const d = x.decision ?? {};
    out.push(`${clock(x.at)}  ${d.kind === "propose-swap" ? `swap ${d.amount} ${d.from} -> ${d.to}` : "hold"}`);
    for (const l of ((x.thoughts ?? []) as string[]).slice(0, 4)) out.push(`  ${l}`);
    if (d.reason) out.push(`  reason: ${d.reason}`);
  }
  return out.length ? out : ["no thoughts recorded yet"];
}

export function researchLines(items: Any[]): string[] {
  const out = items.slice().reverse().map((x) => `${clock(x.at)}  ${String(x.kind).padEnd(11)}${x.line}`);
  return out.length ? out : ["nothing read yet"];
}

export function watchLines(live: Any): string[] {
  const out = [`${live.live ? "live" : "not live"} at block ${live.block ?? "?"}${live.lastTrigger ? `  last trigger: ${live.lastTrigger}` : ""}`];
  for (const w of (live.watching ?? []) as Any[]) out.push(`  ${String(w.symbol).padEnd(10)}${String(w.role).padEnd(7)}${String(w.trend ?? "").padEnd(14)}${w.why ?? ""}`);
  if (!(live.watching ?? []).length) out.push("  nothing on watch right now");
  return out;
}

export function readsLines(r: Any): string[] {
  const out = [`ETH ${usd(r.prices?.ethUsd, 2)}  BTC ${usd(r.prices?.btcUsd, 0)}`];
  if (r.token) out.push(`$OBS ${r.token.address}${r.token.explorerPriceUsd != null ? `  price ${usd(r.token.explorerPriceUsd, 6)}` : ""}${r.token.holders != null ? `  holders ${r.token.holders}` : ""}`);
  return out;
}

export function eligibleLines(e: { swaps: number; required: number; eligible: boolean; recent: Array<{ at: number; from: string; to: string; amountIn: number; amountOut: number | null; txHash: string }> }): string[] {
  const out = [`${e.swaps} of ${e.required} verified swaps${e.eligible ? ": eligible. your agent is provisioned to this wallet; just type to it." : `. ${e.required - e.swaps} more unlock${e.required - e.swaps === 1 ? "s" : ""} your own agent.`}`];
  for (const r of e.recent.slice(0, 5)) out.push(`  ${clock(r.at)}  ${r.amountIn} ${r.from} -> ${r.amountOut != null ? `${r.amountOut} ` : ""}${r.to}  ${r.txHash.slice(0, 10)}...`);
  if (!e.eligible) out.push(`  /swap 0.05 ETH USDG is one. your wallet signs it; the desk reads it off the chain.`);
  return out;
}
