// Withdraw every open proposal in the book: one cancelled row per proposal,
// same id, with the reason written down. A proposal is what the desk writes
// while it is unarmed; once armed it executes at decision time and never goes
// back to old proposals, so any left in the book are dead rows that the model
// keeps reading as "awaiting the operator" and holds against. Run this before
// arming, so the armed desk starts with a clean book.
//   npm run book:withdraw            withdraw them all
//   npm run book:withdraw -- --dry   list them, write nothing
import { readBook, latestTrades, recordTrade } from "../src/desk/book.ts";

const dry = process.argv.includes("--dry");
const now = Date.now();
const stamp = new Date(now).toISOString().slice(0, 16) + "Z";
const open = latestTrades(readBook().trades).filter((t) => t.status === "proposed");
if (!open.length) {
  console.log("no open proposals");
  process.exit(0);
}
for (const t of open) {
  console.log(`${dry ? "would withdraw" : "withdrawn"}: ${t.id}  ${t.from.amount} ${t.from.asset} to ${t.to.asset}  (proposed ${new Date(t.at).toISOString().slice(0, 16)}Z)`);
  if (!dry) recordTrade({ ...t, status: "cancelled", updatedAt: now, note: `withdrawn ${stamp}: proposed while the desk was unarmed and never sent; an armed desk decides and executes in the same cycle` });
}
console.log(`${open.length} proposal(s) ${dry ? "listed, nothing written" : "withdrawn"}`);
