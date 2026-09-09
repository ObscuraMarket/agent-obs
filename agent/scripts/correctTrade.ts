// Correct a recorded trade: append a row with the SAME id carrying the desk's own share of a swap, and the reason.
// The book keeps the latest row per id (latestTrades), so the corrected one is what every read sees afterwards.
//
// For a swap that moved more than the desk owned. The desk shares its wallet with the operator, who buys in the
// app; on 2026-09-09 an exit sold 4,044,007 BYCOCKET when the desk's ledger held 2,760,750, because the sell was
// sized from the wallet rather than from the desk's own lot (fixed in onchain.ts the same day). The chain moved
// what it moved and the transaction hash on the row still proves it. What this corrects is the BOOK, which should
// carry the desk's trades and not the operator's: the amounts are scaled to the desk's share and the note says so.
//   npx tsx scripts/correctTrade.ts <tradeId> <fromAmount> "<why>"        the to leg is scaled in proportion
import { appendLedger } from "../src/ledger.ts";
import { readBook, latestTrades, type Trade } from "../src/desk/book.ts";

const [id, amountArg, why] = process.argv.slice(2);
const fromAmount = Number(amountArg);
if (!id || !Number.isFinite(fromAmount) || fromAmount <= 0 || !why) {
  console.error('usage: correctTrade.ts <tradeId> <fromAmount> "<why>"');
  process.exit(1);
}
const row = latestTrades(readBook().trades).find((t) => t.id === id);
if (!row) {
  console.error(`no trade on record with id ${id}`);
  process.exit(1);
}
if (fromAmount > row.from.amount) {
  console.error(`${fromAmount} is more than the ${row.from.amount} the row already carries; this only ever narrows a trade to the desk's own share`);
  process.exit(1);
}
const share = fromAmount / row.from.amount;
const scale = (v: number | null | undefined): number | null => (v == null ? null : Number((v * share).toPrecision(12)));
const corrected: Trade = {
  ...row,
  updatedAt: Date.now(),
  from: { ...row.from, amount: fromAmount, usd: scale(row.from.usd) },
  to: { ...row.to, amount: scale(row.to.amount) ?? row.to.amount, usd: scale(row.to.usd) },
  note: `${row.note ?? ""}; CORRECTED to the desk's own share (${(share * 100).toFixed(2)}% of the swap): ${why}. The chain moved the full amount and ${row.settlementTx ?? "the transaction"} still shows it.`,
};
appendLedger("obs-trades.jsonl", corrected as unknown as Record<string, unknown>);
console.log(`${id}: ${row.from.amount} -> ${fromAmount} ${row.from.asset} (${(share * 100).toFixed(2)}%), out ${row.to.amount} -> ${corrected.to.amount} ${row.to.asset}`);
console.log(`  ${corrected.note}`);
