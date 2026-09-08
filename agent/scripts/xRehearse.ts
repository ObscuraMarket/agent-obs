// Rehearse Agent OBS on X offline: every post form, from the real ledgers in OBS_DATA_DIR, through the same prompt
// and the same guards the live job uses. Nothing is posted, nothing is journaled, no ledger is written.
//   OBS_DATA_DIR=<dir with the ledgers> X_HANDLE=<handle> npm run x:rehearse [-- --forms 0,2,5 --out file.md]
// Locally, point OBS_DATA_DIR at the ledger backup checkout (a copy of it, plus obs-live.json from /api/obs/live); inside the
// desk the data directory is already the one. The gateway must be reachable (OPENHERMIT_GATEWAY_URL, GATEWAY_ADMIN_TOKEN).
import { GatewayClient } from "@openhermit/sdk";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { X_AGENT_ID, X_HANDLE, MAX_TWEET_CHARS, ROOT_DIR } from "../src/config.ts";
import { traderBlock, traderData, traderPrompt, TRADER_FORMS } from "../src/social/traderVoice.ts";
import { cleanReply, forbiddenReason, tooSimilar } from "../src/social/postGuards.ts";
import { splitNote } from "../src/journal.ts";

const args = process.argv.slice(2);
const at = (k: string) => args.indexOf(k);
const formsArg = at("--forms") >= 0 ? args[at("--forms") + 1].split(",").map(Number) : TRADER_FORMS.map((_, i) => i);
const outPath = at("--out") >= 0 ? args[at("--out") + 1] : null;
const baseUrl = process.env.OPENHERMIT_GATEWAY_URL; const token = process.env.GATEWAY_ADMIN_TOKEN;
if (!baseUrl || !token) { console.error("gateway not configured"); process.exit(1); }
const gw = new GatewayClient({ baseUrl, token });

const now = Date.now();
const data = traderData(now);
const block = traderBlock(data);
const out: string[] = [];
const say = (s: string) => { out.push(s); console.log(s); };
say(`# Agent OBS on X, rehearsal ${new Date(now).toISOString().slice(0, 16)}Z\n`);
say("## The block the model was handed\n");
say("```\n" + block + "\n```\n");
const examplesPath = join(ROOT_DIR, "personality", "xtrader", "examples.md");
const examples = existsSync(examplesPath) ? readFileSync(examplesPath, "utf8").replace(/^#\s+\w+\s*\n/, "").trim() : "";
const recent: string[] = [];
const labels = ["trade note", "the record", "watching, not touching", "an admission", "a mechanic", "a one-liner", "a callback", "a take", "a chain note"];
for (const i of formsArg) {
  const form = TRADER_FORMS[i];
  const prompt = traderPrompt({ handle: X_HANDLE, block, journal: "", recent, performance: "", form, maxChars: MAX_TWEET_CHARS, examples });
  const sessionId = `x-rehearsal-${now}-${i}`;
  await gw.agent(X_AGENT_ID).openSession({ sessionId, source: { kind: "api", interactive: true, type: "direct" } }).catch(() => {});
  const t0 = Date.now();
  let text = "";
  try {
    const resp = await gw.agent(X_AGENT_ID).postMessageSync(sessionId, { text: prompt }, { timeout: 90000 });
    const err = (resp as { error?: string }).error;
    if (err || resp.text == null) { say(`## ${i}. ${labels[i]}\n\ngateway error: ${err ?? "no text"}\n`); continue; }
    text = resp.text;
  } catch (e) { say(`## ${i}. ${labels[i]}\n\ngateway threw: ${e instanceof Error ? e.message : String(e)}\n`); continue; }
  const { text: raw, note } = splitNote(text);
  const tweet = cleanReply(raw);
  const held = /^pass\b/i.test(tweet) || tweet.length < 15;
  const bad = held ? null : forbiddenReason(tweet);
  const dupe = held ? null : tooSimilar(tweet, recent, 0.6);
  const verdict = held ? "PASS (would hold)" : bad ? `BLOCKED by the guard: ${bad}` : dupe ? `SKIPPED as a near repeat (${Math.round(dupe.score * 100)}%)` : tweet.length > MAX_TWEET_CHARS ? `TOO LONG (${tweet.length})` : `would post (${tweet.length} chars)`;
  say(`## ${i}. ${labels[i]}\n`);
  say(`> ${held ? raw.trim().split("\n")[0] : tweet}\n`);
  say(`${verdict}, ${((Date.now() - t0) / 1000).toFixed(0)} s${note ? `\n\nnote to self: ${note}` : ""}\n`);
  if (!held && !bad) recent.push(tweet);
}
if (outPath) { writeFileSync(outPath, out.join("\n")); console.log(`\nwritten to ${outPath}`); }
