// Correct a recorded close: copy the last close for a symbol, set what it
// realized, and append it with the reason. The closes ledger keeps the last
// row per entry, so the corrected row replaces the wrong one everywhere the
// record is read. For the two closes of 2026-09-06 whose ETH leg carried no
// dollar value and were recorded as full losses.
//   npx tsx scripts/correctClose.ts <SYMBOL> <realizedUsd> <ethReceived> <ethUsd>
import { appendLedger } from "../src/ledger.ts";
import { readCloses, CLOSES_LEDGER } from "../src/desk/trade-memory.ts";

const [symbol, realizedArg, ethArg, ethUsdArg] = process.argv.slice(2);
const realizedUsd = Number(realizedArg);
if (!symbol || !Number.isFinite(realizedUsd)) {
  console.error("usage: correctClose.ts <SYMBOL> <realizedUsd> [ethReceived] [ethUsd]");
  process.exit(1);
}
const last = readCloses().filter((c) => c.symbol === symbol.toUpperCase() && !c.paper).sort((a, b) => b.at - a.at)[0];
if (!last) {
  console.error(`no close on record for ${symbol}`);
  process.exit(1);
}
const row = {
  ...last,
  at: Date.now(),
  realizedUsd,
  realizedPct: last.usdIn > 0 ? (realizedUsd / last.usdIn) * 100 : null,
  corrected: `the ETH that came back${ethArg ? ` (${ethArg})` : ""}${ethUsdArg ? ` priced at $${ethUsdArg}` : ""}; the first row carried no dollar value for it and read as a full loss`,
};
appendLedger(CLOSES_LEDGER, row as unknown as Record<string, unknown>);
console.log(`${symbol.toUpperCase()}: realized ${realizedUsd >= 0 ? "+" : ""}$${realizedUsd.toFixed(2)} (${row.realizedPct?.toFixed(2)}%) on $${last.usdIn.toFixed(2)} in, exit ${last.exitKind}, entered ${new Date(last.enteredAt).toISOString()}`);
