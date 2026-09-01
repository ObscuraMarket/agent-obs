// The execution stage. Turns a decision that passed the rails into an Obscura
// order, sends the deposit from the desk's wallet, and records the trade as
// pending; a later pass polls the order and settles it with its transaction.
//
// The receiving address is always the desk's own wallet. The deposit address
// comes from Obscura's order record, is validated, is sent to once, and is
// never written to any ledger.
import { WALLET_ADDRESS, SITE_URL } from "../config.ts";
import { quote, createOrder, orderStatus } from "../obscura/orders.ts";
import { recordTrade, latestTrades, readBook, type Trade } from "./book.ts";
import { checkRails, partnerAllowed, depositAddressLooksRight, mapStatus, type Intent, type RailContext, type Rails } from "./rails.ts";
import { chainOf, assetKey, ASSETS } from "./assets.ts";
import { sendDeposit } from "./signer.ts";

export type ExecuteResult = { ok: true; trade: Trade } | { ok: false; reason: string; trade?: Trade };

/**
 * Quote, choose, order, deposit, record. Every step can refuse; a refusal
 * before the deposit costs nothing, and the deposit is the last step.
 */
export async function execute(i: Intent, c: RailContext, now = Date.now()): Promise<ExecuteResult> {
  const gate = checkRails(i, c);
  if (!gate.ok) return { ok: false, reason: gate.reason };

  const quotes = (await quote({ code: i.from.code, network: i.from.network }, { code: i.to.code, network: i.to.network }, i.amount)).filter((q) => partnerAllowed(q.partner, c.rails) && !q.isRelay);
  if (!quotes.length) return { ok: false, reason: "no acceptable route quoted" };
  const best = quotes[0];
  const mn = Number(best.raw.min);
  const mx = Number(best.raw.max);
  if (Number.isFinite(mn) && mn > 0 && i.amount < mn) return { ok: false, reason: `${best.partner} minimum is ${mn} ${i.from.symbol}` };
  if (Number.isFinite(mx) && mx > 0 && i.amount > mx) return { ok: false, reason: `${best.partner} maximum is ${mx} ${i.from.symbol}` };

  const order = await createOrder({ from: { code: i.from.code, network: i.from.network }, to: { code: i.to.code, network: i.to.network }, amount: i.amount, address: WALLET_ADDRESS, partner: best.partner, fixed: best.fixed, cexId: best.cexId });
  if (!order) return { ok: false, reason: "Obscura did not create the order" };

  const status = await orderStatus(order.id);
  if (!status) return { ok: false, reason: `order ${order.id} was created but its status could not be read; not depositing` };
  if (!depositAddressLooksRight(status.from.address, i.from)) return { ok: false, reason: `order ${order.id} deposit address does not look like a ${i.from.chain} address; not depositing` };
  const expected = status.from.amount;
  if (expected != null && Math.abs(expected - i.amount) / i.amount > 0.001) return { ok: false, reason: `order ${order.id} expects ${expected} ${i.from.symbol}, decision was ${i.amount}; not depositing` };

  const trackUrl = `${SITE_URL}/exchange/${order.id}`;
  const base: Trade = {
    at: now,
    id: order.id,
    status: "pending",
    from: { asset: i.from.symbol, network: i.from.network, amount: i.amount, usd: i.usd },
    to: { asset: i.to.symbol, network: i.to.network, amount: best.toAmount, usd: null },
    partner: best.partner,
    trackUrl,
    note: `quoted ${best.toAmount} ${i.to.symbol} via ${best.partner}`,
  };
  let depositTx: `0x${string}`;
  try {
    depositTx = await sendDeposit(i.from, status.from.address as `0x${string}`, i.amount);
  } catch (err) {
    const failed: Trade = { ...base, status: "failed", note: `deposit not sent: ${err instanceof Error ? err.message : String(err)}` };
    recordTrade(failed);
    return { ok: false, reason: failed.note ?? "deposit failed", trade: failed };
  }
  const trade: Trade = { ...base, depositTx, depositTxUrl: chainOf(i.from).explorerTx(depositTx) };
  recordTrade(trade);
  return { ok: true, trade };
}

/** Poll every open order and move it to settled or failed when Obscura says so. */
export async function settleOpenOrders(now = Date.now()): Promise<Trade[]> {
  const updated: Trade[] = [];
  for (const t of latestTrades(readAll()).filter((x) => x.status === "pending")) {
    const s = await orderStatus(t.id);
    if (!s) continue;
    const next = mapStatus(s.status);
    if (next === "pending") continue;
    const row: Trade = {
      ...t,
      status: next,
      updatedAt: now,
      to: { ...t.to, amount: s.to.amount ?? t.to.amount, usd: t.to.usd },
      settlementTx: s.to.txHash ?? null,
      explorerUrl: s.to.txHash ? explorerFor(t, s.to.txHash) : null,
      note: next === "settled" ? `settled via ${t.partner ?? "route"} (${s.status})` : `Obscura reports ${s.status}`,
    };
    recordTrade(row);
    updated.push(row);
  }
  return updated;
}

function explorerFor(t: Trade, hash: string): string | null {
  const key = `${t.to.asset}@${t.to.network ?? ""}`;
  const a = Object.values(ASSETS).find((x) => assetKey(x) === key);
  return a ? chainOf(a).explorerTx(hash) : null;
}
const readAll = () => readBook().trades;

export type { Rails, RailContext, Intent };
