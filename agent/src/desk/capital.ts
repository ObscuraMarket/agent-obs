// The operator's capital ledger command. This is the only writer of
// obs-capital.jsonl: a deposit that is not recorded here is not on the book,
// and the model never touches it.
//
//   npm run capital -- deposit ETH 0.5            (USD valued from spot at record time)
//   npm run capital -- deposit USDG 500 500       (explicit USD)
//   npm run capital -- withdraw ETH 0.1
//   npm run capital -- list
import { recordCapital, readBook, netCapitalUsd } from "./book.ts";
import { assetPrices } from "../obscura/reads.ts";

const [cmd, assetArg, amountArg, usdArg] = process.argv.slice(2);
const STABLES = new Set(["USDG", "USDC", "USDT", "DAI"]);

if (cmd === "list" || !cmd) {
  const { flows } = readBook();
  if (!flows.length) console.log("no capital recorded");
  for (const f of flows) console.log(`${new Date(f.at).toISOString()}  ${f.kind.padEnd(8)} ${f.amount} ${f.asset}${f.usd != null ? `  ($${f.usd.toFixed(2)})` : ""}`);
  console.log(`net capital: $${netCapitalUsd(flows).toFixed(2)}`);
  process.exit(0);
}
if (cmd !== "deposit" && cmd !== "withdraw") {
  console.error("usage: capital <deposit|withdraw> <ASSET> <amount> [usd] | capital list");
  process.exit(1);
}
const asset = String(assetArg ?? "").toUpperCase();
const amount = Number(amountArg);
if (!/^[A-Z0-9]{2,12}$/.test(asset) || !(amount > 0)) {
  console.error("asset must be a symbol and amount a positive number");
  process.exit(1);
}
let usd: number | null = usdArg != null ? Number(usdArg) : null;
if (usd == null || !Number.isFinite(usd)) {
  if (STABLES.has(asset)) usd = amount;
  else {
    const px = (await assetPrices([asset]))[asset];
    usd = px != null ? amount * px : null;
  }
}
if (usd == null) {
  console.error(`no price for ${asset}; pass the USD value explicitly: capital ${cmd} ${asset} ${amount} <usd>`);
  process.exit(1);
}
recordCapital({ at: Date.now(), kind: cmd, asset, amount, usd: Math.round(usd * 100) / 100 });
console.log(`recorded ${cmd} ${amount} ${asset} ($${usd.toFixed(2)}); net capital now $${netCapitalUsd(readBook().flows).toFixed(2)}`);
