// OBS X autopilot. The copywriter DECIDES: he is handed the live reads, his own journal and his
// recent posts, and chooses what (if anything) to say. The script is just his
// hands. DRY_RUN=1 previews without posting or journaling. Draft-first: with
// X_LIVE unset the tweet lands in the ledger and nowhere else.
import { GatewayClient } from "@openhermit/sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DRY, MIN_POST_GAP_MIN, SIMILARITY_MAX, X_AGENT_ID, X_HANDLE, X_VOICE, MAX_TWEET_CHARS, ROOT_DIR } from "./config.ts";
import { traderBlock, traderData, traderPrompt, TRADER_FORMS, ARRIVAL_FORMS } from "./social/traderVoice.ts";
import { postTweet, getMyPostMetrics } from "./social/xClient.ts";
import { cleanReply, forbiddenReason, tooSimilar } from "./social/postGuards.ts";
import { recallForPrompt, remember, splitNote } from "./journal.ts";
import { appendLedger, readLedger } from "./ledger.ts";
import { liveReads, readsBlock } from "./obscura/reads.ts";

const baseUrl = process.env.OPENHERMIT_GATEWAY_URL;
const token = process.env.GATEWAY_ADMIN_TOKEN;
if (!baseUrl || !token) {
  console.error("[autopilot] gateway not configured (OPENHERMIT_GATEWAY_URL / GATEWAY_ADMIN_TOKEN)");
  process.exit(1);
}
const gw = new GatewayClient({ baseUrl, token });

// Cadence floor, checked BEFORE the model call so a suppressed cycle costs
// nothing. Without it a manual post, a rerun, or timer drift stacks two
// tweets minutes apart.
const postedRows = readLedger<{ at?: number; id?: string; text?: string; posted?: boolean }>("x-posts.jsonl").filter((x) => x?.text);
const published = postedRows.filter((x) => x.posted);
const recent = (published.length ? published : postedRows).map((x) => x.text as string).slice(-12);
const lastPostAt = postedRows.length ? (postedRows[postedRows.length - 1].at ?? 0) : 0;
// The arrival: once live, the first six published posts introduce the account in order (ARRIVAL_FORMS), closer
// together than the daily gap (OBS_X_ARRIVAL_GAP_MIN, 30 by default). Drafts never arrive; they keep the rotation.
const arriving = process.env.X_LIVE === "true" && X_VOICE === "trader" && published.length < ARRIVAL_FORMS.length;
const gapFloor = arriving ? Math.max(5, Number(process.env.OBS_X_ARRIVAL_GAP_MIN ?? 30)) : MIN_POST_GAP_MIN;
if (lastPostAt && !DRY) {
  const gapMin = (Date.now() - lastPostAt) / 60000;
  if (gapMin < gapFloor) {
    console.log(`Holding: last post was ${gapMin.toFixed(0)}m ago, floor is ${gapFloor}m${arriving ? " (arrival)" : ""}.`);
    process.exit(0);
  }
}

const reads = await liveReads();
const data = readsBlock(reads);

// Performance feedback: how his OWN recent posts actually landed. Handed to
// him as an OBSERVATION, never a target: engagement on crypto X rewards the
// hype the voice bans. Only matured posts (>2h) carry any signal.
let performance = "";
try {
  const MATURE_MS = 2 * 60 * 60 * 1000;
  const matured = published.filter((r) => r.id && r.at && Date.now() - (r.at as number) > MATURE_MS).slice(-8);
  if (matured.length >= 4) {
    const metrics = await getMyPostMetrics(matured.map((r) => r.id as string));
    const lines = matured
      .map((r) => {
        const m = metrics[r.id as string];
        if (!m) return null;
        const ageH = Math.round((Date.now() - (r.at as number)) / 3600_000);
        return `- (${ageH}h ago, ${(r.text as string).length}c) "${(r.text as string).slice(0, 55)}..." got ${m.likes} likes, ${m.replies} replies, ${m.reposts} reposts`;
      })
      .filter(Boolean) as string[];
    if (lines.length >= 4) {
      performance =
        `How your own recent posts actually landed. Small numbers are noise: look ONLY for a pattern across several, never react to a single tweet.\n${lines.join("\n")}\n\n` +
        `Treat this as an observation, not a target. NEVER chase engagement, never reach for hype or a louder register to farm it. The voice and boundary rules always win.\n\n`;
    }
  }
} catch {
  /* best-effort */
}

const journal = recallForPrompt(X_AGENT_ID, 8);
const voice = readFileSync(join(ROOT_DIR, "OBS_X_VOICE.md"), "utf8");
const kb = readFileSync(join(ROOT_DIR, "OBSCURA_KB.md"), "utf8");

// THE SHAPE OF THIS CYCLE'S POST, rotated deterministically so the feed does
// not read like one long essay in instalments. Keyed to the number of posts
// already in the ledger, so it survives restarts and never repeats twice running.
const FORMS: string[] = [
  `A SHIP NOTE. Something that is now true for someone using Obscura, stated the way a project posts a real update: one concrete fact first, then one plain line of what it means, then stop. Only from what the knowledge base says is live today; never a roadmap item.`,
  `A MECHANIC READ. One thing a public order leaks, or one thing about how a route settles, and why it matters. Lead with the mechanic, land the point in a line or two.`,
  `A ONE-LINER. Under fifteen words, hard stop. One observation, no setup, no conclusion. Lowercase is fine.`,
  `A CALLBACK. Name something you said before, from your notes, and say what happened to it: held up, fell apart, still open. Short.`,
  `A CULTURE BEAT. Short, native to this ecosystem: tokenized stocks trading while Wall Street sleeps, settlement to your own wallet, the quiet of a route that leaves no trace on a dashboard. Never tag or name other projects to borrow their standing.`,
  `WHAT YOU ARE WATCHING AND NOT TOUCHING. Name the thing and the one condition that would change your mind. The discipline is the content.`,
  `AN ADMISSION about the MARKET, not yourself. A read you hold loosely, a number you do not trust yet. Never uncertainty about your own competence.`,
];
const forms = X_VOICE === "trader" ? TRADER_FORMS : FORMS;
const form = arriving ? ARRIVAL_FORMS[published.length] : forms[postedRows.length % forms.length];
if (arriving) console.log(`Arrival post ${published.length + 1} of ${ARRIVAL_FORMS.length}.`);

const copywriterPrompt = `You are Obscura's copywriter, running @${X_HANDLE} on X. Your voice guide, in full:

${voice}

What Obscura is, as verified from the site (facts only; roadmap items are targets, never dates):

${kb}

Your live reads THIS CYCLE. These are the only numbers you may cite:
${data}

${journal ? `What you have been chewing on lately, in your own words. This is your memory, not a script: pick a thread back up, change your mind out loud, notice you were wrong, or let it go.\n${journal}\n\n` : ""}${recent.length ? `You already said these, so say something new. Building on one with a fresh angle is good; restating it is not:\n${recent.map((r) => "- " + r).join("\n")}\n\n` : ""}${performance}Decide what to do right now. Is there something actually worth saying? Your call. Lean toward posting when you have a real thought.

If you post: reply with the tweet, then on a new line a private note to yourself:

POST: <the tweet>
NOTE: <one sentence, just for you, never published>

The NOTE is your memory. Write what you would actually want to remember: the thread you are pulling on, a call you want to check later, something you are unsure about. If you PASS, still give a NOTE.

THE FORM FOR THIS POST, chosen for you so your feed does not read like one long essay. Follow it even when another angle feels more natural, because the variety IS the personality:
${form}

HARD LIMIT: ${MAX_TWEET_CHARS} characters, a wall, not a guideline. Aim well under it. No em dashes, no hashtags, no quotation marks, no reciting your own values.

If nothing is genuinely worth saying right now: reply with PASS on the first line, then your NOTE.`;

// Agent OBS's own account: the desk speaks about its own trading from its own ledgers; the copywriter's prompt is Obscura's voice.
const examplesPath = join(ROOT_DIR, "personality", "xtrader", "examples.md");
const examples = existsSync(examplesPath) ? readFileSync(examplesPath, "utf8").replace(/^#\s+\w+\s*\n/, "").trim() : "";
const prompt = X_VOICE === "trader"
  ? traderPrompt({ handle: X_HANDLE, block: traderBlock(traderData()), journal, recent, performance, form, maxChars: MAX_TWEET_CHARS, examples })
  : copywriterPrompt;

const sessionId = "x-autopilot";
await gw.agent(X_AGENT_ID).openSession({ sessionId, source: { kind: "api", interactive: true, type: "direct" } }).catch(() => {});
const resp = await gw.agent(X_AGENT_ID).postMessageSync(sessionId, { text: prompt }, { timeout: 90000 });

// A failed call is NOT a decision. Exit non-zero so launchd records a failure
// rather than a clean run that looks like a thoughtful silence.
const gwError = (resp as { error?: string }).error;
if (gwError || resp.text == null) {
  console.error(`[autopilot] OBS could not think this cycle: ${gwError ?? "gateway returned no text"}`);
  process.exit(1);
}
// Split the private note off BEFORE any public processing, so a NOTE can never reach the timeline.
const { text: rawText, note } = splitNote(resp.text ?? "");
const tweet = cleanReply(rawText);
const held = /^pass\b/i.test(tweet) || tweet.length < 15;

// A DRY_RUN is a rehearsal and must leave NO trace: a preview that writes the
// ledger teaches the agent he published something he did not.
const persist = !DRY;
if (persist) {
  appendLedger("obs-decisions.jsonl", { at: Date.now(), agent: X_AGENT_ID, decision: held ? "hold" : "post", text: tweet.slice(0, 300) });
  remember(X_AGENT_ID, { decision: held ? "hold" : "post", note });
}
if (note) console.log(`  note to self: ${note}`);
if (held) {
  console.log("OBS chose to hold this cycle.");
  process.exit(0);
}
console.log(`OBS decided to post (${tweet.length} chars):\n${tweet}\n`);
if (tweet.length > MAX_TWEET_CHARS) {
  console.log(`SKIP: too long (${tweet.length}/${MAX_TWEET_CHARS})`);
  process.exit(1);
}

// Mechanical backstop for the hard boundaries in the prompt.
const bad = forbiddenReason(tweet);
if (bad) {
  console.log(`BLOCKED (${bad}). Not posting.`);
  process.exit(0);
}
const dupe = tooSimilar(tweet, recent, SIMILARITY_MAX);
if (dupe) {
  console.log(`SKIP: ${(dupe.score * 100).toFixed(0)}% word overlap with a recent post:\n  ${dupe.hit.slice(0, 90)}`);
  process.exit(0);
}
if (DRY) {
  console.log("DRY RUN, not posting.");
  process.exit(0);
}
const r = await postTweet(tweet);
console.log(r.posted ? `POSTED: https://x.com/${X_HANDLE}/status/${r.id}` : `not posted: ${r.reason}`);
process.exit(r.posted ? 0 : 1);
