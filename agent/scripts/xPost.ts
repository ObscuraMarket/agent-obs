// The operator's own words through the account: one post, past the same guards the model's posts pass, marked
// operator in the ledger so the agent never counts it as its own (it does not take an arrival slot). Run inside
// the desk, where the keys are.
//   npx tsx scripts/xPost.ts "<text>"              checks the text and prints the verdict; posts nothing
//   npx tsx scripts/xPost.ts "<text>" --now        posts it now, whatever X_LIVE says (this one post only)
//   npx tsx scripts/xPost.ts --b64 <base64> [--now] the text base64-encoded, for a shell that mangles quotes
import { MAX_TWEET_CHARS } from "../src/config.ts";
import { forbiddenReason, stripDashes } from "../src/social/postGuards.ts";
import { postTweet } from "../src/social/xClient.ts";

const args = process.argv.slice(2);
const now = args.includes("--now");
const b = args.indexOf("--b64");
const text = stripDashes(b >= 0 ? Buffer.from(args[b + 1] ?? "", "base64").toString("utf8") : (args.find((a) => !a.startsWith("--")) ?? "")).trim();
if (!text) { console.error('usage: xPost.ts "<text>" [--now]   or   xPost.ts --b64 <base64> [--now]'); process.exit(2); }
console.log(`text (${text.length}/${MAX_TWEET_CHARS} chars):\n${text}\n`);
const bad = forbiddenReason(text);
if (bad) { console.error(`BLOCKED (${bad}); not posted`); process.exit(1); }
if (text.length > MAX_TWEET_CHARS) { console.error(`too long (${text.length}/${MAX_TWEET_CHARS}); not posted`); process.exit(1); }
if (!now) { console.log("passes every guard; add --now to post it"); process.exit(0); }
// The operator asked for this one post; the account may still be drafting for the agent's own posts.
process.env.X_LIVE = "true";
const r = await postTweet(text, { operator: true });
console.log(r.posted ? `POSTED: https://x.com/${(process.env.X_HANDLE ?? "").replace(/^@/, "")}/status/${r.id}` : `not posted: ${r.reason}`);
process.exit(r.posted ? 0 : 1);
