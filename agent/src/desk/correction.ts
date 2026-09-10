// Narrowing a recorded trade to the desk's own share, as pure functions so the arithmetic can be tested without a
// ledger. The script that drives this is scripts/correctTrade.ts.
//
// A swap can move more than the desk's own lot, and the BOOK carries the desk's part alone. The chain moved what it
// moved and the transaction hash still proves it.
import type { Trade } from "./book.ts";

/**
 * PURE: the row a correction must be built from: the newest row for this trade that this script has NOT already
 * corrected.
 *
 * Correcting against an already corrected row makes the share a fraction of a fraction. On 2026-09-09 a second run
 * against a row already narrowed to 68.27% reported "100.00% of the swap", which was false and served publicly by
 * /api/obs/trades. Reading from the uncorrected row instead makes a re-run idempotent, and the share reported is
 * always the share of the swap the chain actually made.
 */
export function basisRow(rows: Trade[]): Trade | null {
  if (!rows.length) return null;
  const uncorrected = rows.filter((t) => !(t.note ?? "").includes("; CORRECTED"));
  const pool = uncorrected.length ? uncorrected : rows;
  return pool.reduce((a, b) => ((b.updatedAt ?? b.at) >= (a.updatedAt ?? a.at) ? b : a));
}

/** PURE: a figure narrowed to the desk's share, at the precision the ledger carries. */
export function scaleBy(share: number, v: number | null | undefined): number | null {
  return v == null ? null : Number((v * share).toPrecision(12));
}

/**
 * PURE: the note's "received X ASSET" clause reports the WHOLE swap, so a narrowed row that keeps it verbatim
 * contradicts its own to.amount. That contradiction is what made a correct row read as a 32% bad fill on
 * 2026-09-09. Narrow the clause too; the sentence about the chain carries the whole-swap fact.
 */
export function scaleReceivedClause(note: string, share: number): string {
  return note.replace(
    /received ([0-9.]+) (\S+)/,
    (_m, amt: string, asset: string) => `received ${scaleBy(share, Number(amt))} ${asset}`,
  );
}

/** PURE: the note a corrected row carries. REBUILT from the basis row, never appended to, because a note is public. */
export function correctedNote(basis: Trade, share: number, why: string): string {
  const head = scaleReceivedClause((basis.note ?? "").split("; CORRECTED")[0], share);
  const tx = basis.settlementTx ?? "the transaction";
  return `${head}; CORRECTED to the desk's own share (${(share * 100).toFixed(2)}% of the swap): ${why}. The chain moved the full amount and ${tx} still shows it.`;
}

/** PURE: the whole corrected row, from the basis row and the amount the desk actually owned. */
export function correctedRow(basis: Trade, fromAmount: number, why: string, now: number): Trade {
  const share = fromAmount / basis.from.amount;
  return {
    ...basis,
    updatedAt: now,
    from: { ...basis.from, amount: fromAmount, usd: scaleBy(share, basis.from.usd) },
    to: { ...basis.to, amount: scaleBy(share, basis.to.amount) ?? basis.to.amount, usd: scaleBy(share, basis.to.usd) },
    note: correctedNote(basis, share, why),
  } as Trade;
}
