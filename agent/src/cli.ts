// obs: the desk's command line. The reads come from a running desk's public API (OBS_API_URL, default Obscura's own
// agent); a quote comes from the pools through the desk's router; a swap is signed by your own wallet key on this
// machine, paid to your address, then reported to the desk, which reads it off the chain and counts it toward
// running your own agent. The rest wraps the scripts of your own agent. The web console at /console on the site
// speaks the same commands.
//   npm run obs -- <command>      or, once installed:   obs <command>
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT_DIR, WALLET_ADDRESS } from "./config.ts";
import { parseCli, HELP, type CliCommand } from "./cli/commands.ts";
import { consoleAssets } from "./desk/console.ts";
import { quoteOnChain, encodeSwap, ensureAllowances } from "./desk/onchain.ts";
import { sendTx, waitReceipt } from "./desk/signer.ts";
import { relayQuote } from "./obscura/relay.ts";

const API = (process.env.OBS_API_URL || "https://obs-api.obscura.markets").replace(/\/+$/, "");
const EXPLORER = "https://robinhoodchain.blockscout.com";

const usd = (v: unknown, digits = 0): string => (v == null || !Number.isFinite(Number(v)) ? "n/a" : `${Number(v) < 0 ? "-" : ""}$${Math.abs(Number(v)).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);
const pct = (v: unknown): string => (v == null || !Number.isFinite(Number(v)) ? "n/a" : `${Number(v) >= 0 ? "+" : ""}${(Number(v) * 100).toFixed(1)}%`);
const clock = (ts: number): string => new Date(ts).toISOString().slice(11, 16) + "Z";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(60_000) });
  const body = (await res.json().catch(() => null)) as T & { error?: string; reason?: string };
  if (!res.ok) throw new Error(body?.error ?? body?.reason ?? `HTTP ${res.status} from ${API}${path}`);
  return body;
}

function script(rel: string, args: string[], env: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(join(ROOT_DIR, "node_modules", ".bin", "tsx"), [join(ROOT_DIR, rel), ...args], { cwd: ROOT_DIR, stdio: "inherit", env: { ...process.env, ...env } });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function node(rel: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT_DIR, rel), ...args], { cwd: ROOT_DIR, stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function status(): Promise<void> {
  const s = await api<any>("/api/obs/status");
  const d = s.desk;
  const r = s.rails;
  console.log(`equity ${usd(d.equityUsd)}  pnl ${usd(d.pnlUsd)} (${pct(d.pnlPct)})  capital ${usd(d.netCapitalUsd)}  last cycle ${d.lastThoughtAt ? clock(d.lastThoughtAt) : "n/a"}`);
  if (r) console.log(`trading ${r.tradingOn ? "on" : "off"}  size ${usd(r.maxSwapUsd)} a trade  open orders ${r.openOrders} of ${r.maxOpenOrders}`);
  if (s.wallet?.address) console.log(`the desk's wallet ${s.wallet.address}  ${s.wallet.explorerUrl}`);
  const p = await api<any>("/api/obs/pnl?hours=24");
  const held = (p.positions ?? []).filter((x: any) => x.asset !== "ETH");
  console.log(held.length ? `holding ${held.map((x: any) => `${x.asset} ${usd(x.valueUsd)} (${pct(x.unrealizedPct)})`).join(", ")}` : "holding nothing but ETH");
}

async function positions(): Promise<void> {
  const p = await api<any>("/api/obs/pnl?hours=24");
  console.log("positions");
  for (const x of p.positions ?? []) console.log(`  ${String(x.asset).padEnd(10)}${usd(x.valueUsd, 2).padStart(12)}  ${pct(x.unrealizedPct).padStart(8)}  share ${Math.round((x.share ?? 0) * 100)}%`);
  const closed = (p.closed ?? []).slice(0, 10);
  if (closed.length) {
    console.log("closed, last 24 hours");
    for (const c of closed) console.log(`  ${clock(c.closedAt)}  ${String(c.asset).padEnd(10)}${usd(c.resultUsd, 2).padStart(10)}  ${c.heldMin} min  ${c.how}`);
  }
}

async function thoughts(n: number): Promise<void> {
  const t = await api<any>(`/api/obs/thoughts?limit=${Math.max(1, Math.min(20, n))}`);
  for (const x of t.items ?? []) {
    console.log(`${clock(x.at)}  ${x.decision?.kind === "propose-swap" ? `swap ${x.decision.amount} ${x.decision.from} -> ${x.decision.to}` : "hold"}`);
    for (const l of (x.thoughts ?? []).slice(0, 4)) console.log(`  ${l}`);
    if (x.decision?.reason) console.log(`  reason: ${x.decision.reason}`);
  }
}

async function research(n: number): Promise<void> {
  const r = await api<any>(`/api/obs/research?limit=${Math.max(1, Math.min(50, n))}`);
  for (const x of (r.items ?? []).slice().reverse()) console.log(`${clock(x.at)}  ${String(x.kind).padEnd(11)}${x.line}`);
}

async function watch(): Promise<void> {
  const l = await api<any>("/api/obs/live");
  console.log(`${l.live ? "live" : "not live"} at block ${l.block ?? "?"}${l.lastTrigger ? `  last trigger: ${l.lastTrigger}` : ""}`);
  for (const w of l.watching ?? []) console.log(`  ${String(w.symbol).padEnd(10)}${String(w.role).padEnd(7)}${String(w.trend ?? "").padEnd(14)}${w.why ?? ""}`);
  if (!(l.watching ?? []).length) console.log("  nothing on watch right now");
}

async function reads(): Promise<void> {
  const r = await api<any>("/api/obs/reads");
  console.log(`ETH ${usd(r.prices?.ethUsd, 2)}  BTC ${usd(r.prices?.btcUsd, 0)}`);
  if (r.token) console.log(`$OBS ${r.token.address}${r.token.explorerPriceUsd != null ? `  price ${usd(r.token.explorerPriceUsd, 6)}` : ""}${r.token.holders != null ? `  holders ${r.token.holders}` : ""}`);
}

async function quote(amount: number, fromSpec: string, toSpec: string): Promise<void> {
  const pair = consoleAssets(fromSpec, toSpec);
  if ("error" in pair) throw new Error(pair.error);
  const q = await quoteOnChain(pair.from, pair.to, amount);
  if (!q) throw new Error(`no pool route from ${pair.from.symbol} to ${pair.to.symbol}, or the pools did not answer`);
  console.log(`${amount} ${pair.from.symbol} -> ${q.amountOut} ${pair.to.symbol} through the pools (${q.route.hops.map((h) => h.key).join(" then ")}${q.costPct != null ? `, all in ${q.costPct.toFixed(2)}% against the mark` : ""}); floor ${q.minOut}`);
  if (["ETH", "USDG"].includes(pair.from.symbol) && ["ETH", "USDG"].includes(pair.to.symbol)) {
    const r = await relayQuote(pair.from, pair.to, amount, WALLET_ADDRESS || "0x000000000000000000000000000000000000dEaD");
    console.log(r.quote ? `the app's Relay route pays ${r.quote.amountOut} ${pair.to.symbol}${r.quote.feeUsd != null ? ` with $${r.quote.feeUsd.toFixed(2)} of fees` : ""}` : `Relay: ${r.error ?? "no quote"}`);
  }
}

async function swap(amount: number, fromSpec: string, toSpec: string): Promise<void> {
  if (!WALLET_ADDRESS) throw new Error("no wallet: run `obs wallet create`, then put its address in .env as OBS_WALLET_ADDRESS");
  const pair = consoleAssets(fromSpec, toSpec);
  if ("error" in pair) throw new Error(pair.error);
  const q = await quoteOnChain(pair.from, pair.to, amount);
  if (!q) throw new Error(`no pool route from ${pair.from.symbol} to ${pair.to.symbol}, or the pools did not answer`);
  console.log(`${amount} ${pair.from.symbol} -> ${q.amountOut} ${pair.to.symbol} through the pools; floor ${q.minOut}`);
  const approvals = await ensureAllowances(pair.from, q.amountInRaw);
  for (const h of approvals) console.log(`approval landed ${EXPLORER}/tx/${h}`);
  const tx = encodeSwap(q.route, q.amountInRaw, q.minOutRaw, WALLET_ADDRESS as `0x${string}`, BigInt(Math.floor(Date.now() / 1000) + 1200));
  const hash = await sendTx(pair.from, tx);
  console.log(`sent ${hash}, waiting for the chain`);
  const r = await waitReceipt(pair.from, hash);
  if (!r || r.status !== "success") throw new Error(`the swap did not succeed (${r?.status ?? "not landed in two minutes"}): ${EXPLORER}/tx/${hash}`);
  console.log(`swap landed: ${EXPLORER}/tx/${hash}`);
  const reply = await api<any>("/api/obs/console/swap", { method: "POST", body: JSON.stringify({ address: WALLET_ADDRESS, txHash: hash, from: pair.from.symbol, to: pair.to.symbol, amountIn: amount }) }).catch((e: Error) => ({ ok: false, reason: e.message }));
  if (reply.ok) console.log(`verified by the desk${reply.swap?.amountOut != null ? `, ${reply.swap.amountOut} ${pair.to.symbol} arrived` : ""}. ${reply.eligibility.swaps} of ${reply.eligibility.required} swaps${reply.eligibility.eligible ? ": eligible. Your agent is yours to run." : "."}`);
  else console.log(`the desk could not verify it yet: ${reply.reason}. Run \`obs eligible\` in a minute.`);
}

async function eligible(address: string | null): Promise<void> {
  const a = address ?? WALLET_ADDRESS;
  if (!a) throw new Error("which address? `obs eligible 0x...`, or set OBS_WALLET_ADDRESS in .env");
  const e = await api<any>(`/api/obs/console/eligible?address=${a}`);
  console.log(`${e.swaps} of ${e.required} verified swaps${e.eligible ? ": eligible. Your agent is yours to run: QUICKSTART.md" : ""}`);
  for (const r of e.recent.slice(0, 5)) console.log(`  ${clock(r.at)}  ${r.amountIn} ${r.from} -> ${r.amountOut != null ? `${r.amountOut} ` : ""}${r.to}  ${r.txHash.slice(0, 10)}...`);
}

async function main(c: CliCommand): Promise<number> {
  switch (c.kind) {
    case "help":
      console.log("obs: the desk's command line. Reads come from the desk at " + API + "; a swap is signed by your own wallet on this machine.\n");
      for (const [k, v] of HELP) console.log(`  ${k.padEnd(42)}${v}`);
      return 0;
    case "status": await status(); return 0;
    case "positions": await positions(); return 0;
    case "thoughts": await thoughts(c.n); return 0;
    case "research": await research(c.n); return 0;
    case "watch": await watch(); return 0;
    case "reads": await reads(); return 0;
    case "quote": await quote(c.amount, c.from, c.to); return 0;
    case "swap": await swap(c.amount, c.from, c.to); return 0;
    case "eligible": await eligible(c.address); return 0;
    case "wallet": return c.args[0] === "balances" ? script("src/obscura/walletBalances.ts", []) : node("scripts/wallet.mjs", c.args);
    case "capital": return script("src/desk/capital.ts", c.args);
    case "model": return script("scripts/modelCheck.ts", []);
    case "verify": return script("scripts/verifyObscura.ts", c.args.filter((a) => a.startsWith("--")));
    case "run":
      if (c.what === "desk") return script("src/desk/cycle.ts", []);
      if (c.what === "paper") return script("src/desk/cycle.ts", [], { OBS_PAPER: "on", OBS_MIN_THOUGHT_GAP_MIN: "0" });
      if (c.what === "live") return script("src/desk/live.ts", []);
      if (c.what === "dashboard") return script("src/server.ts", []);
      console.error("obs run desk | paper | live | dashboard");
      return 1;
    default:
      console.error(`not a command: ${c.text}. Try: obs help`);
      return 1;
  }
}

main(parseCli(process.argv.slice(2)))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
