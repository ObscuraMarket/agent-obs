// Does the model answer? Run this before the desk: it says which model the environment names, sends one line,
// and prints the reply or the reason there was none. It never prints a key. `npm run model:check`.
import "../src/config.ts";
import { modelFromEnv, noModelWhy } from "../src/desk/model.ts";

const m = modelFromEnv();
if (!m) {
  console.error(`no model configured: ${noModelWhy()}`);
  process.exit(1);
}
console.log(`model: ${m.name}`);
const t0 = Date.now();
const r = await m.think("A connection check from the desk, with no market data this cycle. Reply with one line: THOUGHT: the desk is connected.");
if (r.error || r.text == null) {
  console.error(`the model did not answer: ${r.error ?? "no text"}`);
  process.exit(1);
}
console.log(`answered in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${r.text.replace(/\s+/g, " ").slice(0, 80)}`);
