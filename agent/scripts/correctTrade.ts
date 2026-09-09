// Correct a recorded trade: append a row with the SAME id carrying the desk's own share of a swap, and the reason.
// The book keeps the latest row per id (latestTrades), so the corrected one is what every read sees afterwards.
//
// For a swap that moved more than the desk owned. The desk shares its wallet with the operator, who buys in the
// app; on 2026-09-09 an exit sold 4,044,007 BYCOCKET when the desk's ledger held 2,760,750, because the sell was
// sized from the wallet rather than from the desk's own lot (fixed in onchain.ts the same day). The chain moved
// what it moved and the transaction hash on the row still proves it. What this corrects is the BOOK, which should
// carry the desk's trades and not the operator's: the amounts are scaled to the desk's share and the note says so.
//
// Re-running this on the same trade is safe: the correction is always rebuilt from the row the chain wrote, never
// from a row this script wrote, so the share it reports is the share of the real swap. The arithmetic lives in
// src/desk/correction.ts so it can be tested without a ledger.
//   npx tsx scripts/correctTrade.ts <tradeId> <fromAmount> "<why>"        the to leg is scaled in proportion
import { appendLedger } from "../src/ledger.ts";
import { readBook } from "../src/desk/book.ts";
import { basisRow, correctedRow } from "../src/desk/correction.ts";

const [id, amountArg, why] = process.argv.slice(2);
const fromAmount = Number(amountArg);
if (!id || !Number.isFinite(fromAmount) || fromAmount <= 0 || !why) {
  console.error('usage: correctTrade.ts <tradeId> <fromAmount> "<why>"');
  process.exit(1);
}
const row = basisRow(readBook().trades.filter((t) => t.id === id));
if (!row) {
  console.error(`no trade on record with id ${id}`);
  process.exit(1);
}
if (fromAmount > row.from.amount) {
  console.error(`${fromAmount} is more than the ${row.from.amount} the swap itself moved; this only ever narrows a trade to the desk's own share`);
  process.exit(1);
}
const corrected = correctedRow(row, fromAmount, why, Date.now());
const share = fromAmount / row.from.amount;
appendLedger("obs-trades.jsonl", corrected as unknown as Record<string, unknown>);
console.log(`${id}: ${row.from.amount} -> ${fromAmount} ${row.from.asset} (${(share * 100).toFixed(2)}%), out ${row.to.amount} -> ${corrected.to.amount} ${row.to.asset}`);
console.log(`  ${corrected.note}`);
