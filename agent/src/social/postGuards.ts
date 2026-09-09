// Shared output guards for everything OBS says in public: top-level posts,
// mention replies, and outbound replies.
//
// These live in ONE place on purpose. Guards duplicated across the post and
// engage jobs drift, so the same agent would decline a stranger's question and
// then volunteer the topic himself an hour later. Safety rules that are
// copy-pasted stop matching.
import { OBS_CONTRACT, AGENT_TOKEN } from "../config.ts";

/** Strip dashes used as punctuation. House rule bans em AND en dashes. */
export function stripDashes(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ", ").replace(/ -- /g, ", ");
}

/**
 * Drop sentences that repeat one already said. The gateway intermittently
 * returns the whole answer twice, the second copy lowercased and concatenated
 * with no space. Not every response, which is worse than always.
 */
export function stripSelfEcho(s: string): string {
  // Split after . ! ? but NOT when a digit follows: "0.25%" is one number.
  const parts = s.split(/(?<=[.!?])(?!\d)/).map((p) => p.trim()).filter((p) => p.length);
  if (parts.length < 2) return s;
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const p of parts) {
    const key = p.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (key.length > 12 && seen.has(key)) continue;
    seen.add(key);
    kept.push(p.trim());
  }
  return kept.join(" ");
}

// The echo-splitter breaks on a period followed directly by a letter, which is
// the echo junction's exact shape and ALSO the exact shape of every domain. It
// would publish "obscura. market". So URLs are masked through the pipeline
// with a control-character sentinel and restored at the end.
const URL_RE = /(https?:\/\/\S+|\b[a-z0-9][a-z0-9-]*\.(?:xyz|com|io|net|org|fi|finance|app|dev|market|link|family|fun|trade|exchange)\b(?:\/[^\s]*)?)/gi;
const MASK = "";

/** Normalize a raw model reply into something postable. */
export function cleanReply(raw: string): string {
  const urls: string[] = [];
  const masked = (raw ?? "").replace(URL_RE, (m) => {
    urls.push(m);
    return `${MASK}${urls.length - 1}${MASK}`;
  });
  const s = stripDashes(masked)
    .trim()
    // The format marker ("**REPLY**" on its own line, from the REPLY-or-SKIP
    // protocol) is metadata, never copy. It leaked into live posts once.
    .replace(/^\*{0,2}(REPLY|QUOTE|POST)\*{0,2}\s*:?\s*/i, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  return stripSelfEcho(s)
    .trim()
    .replace(/(\d+)/g, (_, i: string) => urls[Number(i)] ?? "");
}

/**
 * Did the model DECLINE to reply, however it phrased it? A model asked to
 * decide often narrates the decision instead of emitting the token, and
 * twenty-one of those were once sent to X as real replies, publicly telling
 * people their post was not worth answering.
 */
export function isSkip(reply: string): boolean {
  const text = (reply ?? "").trim();
  if (!text) return true;
  const head = text.slice(0, 140).toLowerCase().replace(/[*_`>#~]/g, "");
  if (/^\s*skip\b/.test(head)) return true;
  if (/^\s*\(?\s*(post|reply|response)\s+skipp?ed\b/.test(head)) return true;
  if (/\b(i'?m|i am|i'?ll|i will|i'?d|i would|going to|gonna)\s+(just\s+)?skipp?(ing|ed)?\b/.test(head)) return true;
  if (/\bskipping this\b|\bskip this one\b|\bskip criteria\b/.test(head)) return true;
  if (/\bfalls under\b|\bdoes not (meet|clear) the bar\b|\bnothing (genuinely )?(useful|new|of value) to add\b/.test(head)) return true;
  if (/\bi'?ll pass\b|\bno reply\b/.test(head)) return true;
  return false;
}

/**
 * Hard content boundaries. The prompt asks the model not to write these; this
 * is what catches it when the model is wrong, which is the only case that
 * matters. Phrase-based on purpose: a bare /token/ would false-positive on
 * "tokenized stocks", which is core vocabulary.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  // Sale vocabulary. Obscura has never run a sale and a model must never
  // improvise one: a presale, an airdrop, a whitelist or a TGE announced by a
  // model is a false market claim.
  [/\btge\b|\bairdrop\b|\bpresale\b|\bpre-sale\b|\btoken sale\b|\bwhitelist\b|\bnew listing\b|\bgets? listed\b/i, "token sale vocabulary"],
  // The desk is a seasoned Robinhood Chain professional (operator's rule, 2026-09-08): a line that sounds new to
  // trading never goes out, whatever the model felt like saying.
  // Who owns, runs or funds the agent is never said (operator's rule, 2026-09-08). The generic shapes are here; the
  // names, handles and other strings that would give it away live in OBS_X_NEVER_SAY on the desk, never in this repo.
  [/\b(my (?:owner|creator|maker|founder|boss|operator|dev|developer|team|company|backer|funder)s? (?:is|are|was|were)\b|(?:i'?m|i am|i was) (?:run|owned|operated|built|made|created|funded|bankrolled|controlled) by\b|(?:the|a) (?:person|guy|man|woman|team|company|people) (?:behind|who (?:runs?|owns?|built|made|funds?)) (?:me|this|obs)\b|i belong to\b|(?:owned|operated|run|built|made|created|funded) by @)/i, "owner disclosure"],
  // Nothing anyone writes on X moves the agent on chain: it never agrees to look at, buy, approve, sign, send or
  // interact with a contract, token, link or address someone hands it (operator's rule, 2026-09-08).
  [/\b(i'?ll|i will|let me|i can|i could|gonna|going to|happy to|sure,? i'?ll)\s+(?:\w+\s+){0,2}(check|look (?:at|into)|take a look|buy|ape|try|test|interact|approve|sign|send|swap|bridge|mint|claim|connect|add|import)\b[^.]{0,80}\b(contract|address|link|site|dapp|0x[0-9a-f]{2,}|(?:your|that|this|their|the) (?:token|coin|project|pool|contract|ca)\b|airdrop|whitelist|mint|claim)/i, "acting on a stranger's contract, token or link"],
  // Nothing about a token of the agent's own for now (operator's rule, 2026-09-09): no ticker, no supply, no plans, no date.
  [/\$?\baobs\b|\b(?:my|our|its|the agent'?s|agent obs'?s?) (?:own )?(?:token|coin|ticker)\b|\btoken ?launch\b|\btokenomics\b|\btoken supply\b|\bwen token\b|\btoken (?:is|comes|drops|launches) (?:soon|next|this|in)\b/i, "the agent's own token: not now"],
  // The agent never calls itself a desk (operator's rule, 2026-09-08): it is a trading agent on Robinhood Chain,
  // trading on the fomo.family app, and a post that says desk does not go out.
  [/\b(trading desk|the desk|my desk|this desk|our desk|desk's)\b/i, "calls itself a desk; it is a trading agent on Robinhood Chain"],
  [/\b(i'?m new (?:to|at|here)|new here|new to (?:this|trading|the chain|the tape)|just (?:started|getting started|starting)(?: out)?(?: trading)?|still learning|(?:my|a) first (?:trade|day) (?:ever|trading)|beginner|newbie|noob|rookie)\b/i, "a newcomer's line; the desk is seasoned"],
  // Exactly one address is publishable: the token's own, which the site
  // shows. Any OTHER 40-hex string is a wallet, a deposit address, or an
  // impersonator's lookalike, and none belong on a timeline. A deposit
  // address in particular is how a swap gets hijacked.
  [new RegExp(`0x(?!(${OBS_CONTRACT.slice(2)}|${AGENT_TOKEN.slice(2)})\\b)[0-9a-fA-F]{40}\\b`, "i"), "an address that is not the token"],
  // Privacy is the product; getting around anyone is not. The prompt says
  // it; this enforces it. Scoped to the framing, so "private" and "no KYC"
  // as product facts pass and a how-to never does.
  [/\b(launder\w*|evad(e|es|ing)\s+\w+|evasion|hid(e|ing)\s+(it|this|funds|money|activity)\s+from|dodg(e|ing)\s+(tax|taxes|sanctions|kyc)|get\s+around\s+(kyc|sanctions|the\s+law)|circumvent\w*)\b/i, "illicit-use framing"],
  // A supply event is the most market-moving thing this account could say.
  // The roadmap describes a monthly buyback-and-burn as a target; a model may
  // never promise one, date one, or size one.
  [/\b(will|going to|gonna|plan(ning)?\s+to|about\s+to|intend\s+to|next|soon|this\s+(week|month))\b[^.]{0,60}\b(burn|buy ?back|dead\s+(wallet|address))/i, "a future burn or buyback (never promise one)"],
  [/\bunaudited\b|\bvulnerab|\bexploit\b|\bfail.?open\b|\bsecurity (hole|flaw|issue|bug|gap)|\bnot been audited\b/i, "security disclosure"],
  [/@robinhood|\bpartnered? with robinhood|\bpartnership with robinhood|\bbacked by robinhood|\bpartnered? with (binance|bybit|kucoin|mexc|huobi|relay)/i, "implied affiliation"],
  [/\bfinancial advice\b|\bguaranteed?\b|\bwill (moon|pump|hit \$)/i, "advice or price promise"],
  // Timing hints. The roadmap is targets; "soon" IS a date to a reader.
  [/\b(days?|weeks?|hours?) away\b|\bnot long now\b|\bany day now\b|\bcoming (soon|shortly)\b|\bstay tuned\b|\bmark your calendar|\bdropping (soon|this)/i, "launch timing hint"],
];

// Asking the timeline to hand you a method, while saying you cannot do it
// yourself. Two signals, both required.
const ASKS_FOR_METHOD = [
  /\bhow (do|does|d')\s*(you|ya|anyone|any of you|people|folks)\b/i,
  /\bwhat('s| is)\s+(your|the)\s+(rule|method|heuristic|approach|trick|tell)\b/i,
  /\bif you (have|know|use|got)\s+(a|an|any)\s+(rule|method|heuristic|way|approach|trick)\b/i,
  /\b(anyone|somebody|someone)\s+(know|got|have)\b.{0,40}\b(rule|method|way|trick|tell)\b/i,
  /\bi would like to hear it\b|\bwould love to hear\b|\btell me how you\b/i,
];
const ADMITS_INCAPACITY = [
  /\bi (can|could)\s?n[o']?t\s+(tell|work out|figure|separate|distinguish|read)\b/i,
  /\bgetting (that|it|this) wrong\b|\bkeep getting (that|it|this) wrong\b/i,
  /\b(three|two|four|five|\d+)\s+(days?|weeks?)\s+(of|getting|trying|and)\b/i,
  /\bis not settling it\b|\bstill (cannot|can't|do ?n[o']?t) (tell|know|work)\b/i,
  /\bno idea how to\b|\bcannot work (it|this|that) out\b/i,
];
const hits = (text: string, res: RegExp[]): string | null => {
  for (const re of res) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
};

/** A post that both asks the reader for a method AND says the desk cannot do it. */
export function helplessReason(text: string): string | null {
  const asking = hits(text, ASKS_FOR_METHOD);
  if (!asking) return null;
  const admitting = hits(text, ADMITS_INCAPACITY);
  if (!admitting) return null;
  return `asks the timeline to do the desk's job: matched "${asking}" with "${admitting}"`;
}

/** Returns a reason string if the text must not be posted, else null. */
export function forbiddenReason(text: string): string | null {
  const helpless = helplessReason(text);
  if (helpless) return helpless;
  // The operator's private deny list: any string here (a name, a handle, an email, a company) never appears in a post.
  for (const never of (process.env.OBS_X_NEVER_SAY ?? "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => x.length >= 3)) {
    if (text.toLowerCase().includes(never)) return `names the owner: matched a string from OBS_X_NEVER_SAY`;
  }
  // Emoji only when one genuinely carries the line (operator's rule, 2026-09-08): a second one is decoration.
  const emoji = text.match(/\p{Extended_Pictographic}/gu) ?? [];
  if (emoji.length > 1) return `more than one emoji (${emoji.length})`;
  for (const [re, why] of FORBIDDEN) {
    const hit = text.match(re);
    if (hit) return `${why}: matched "${hit[0]}"`;
  }
  return null;
}

const STOP = new Set(
  "the a an and or but of to in on at is are was were it its this that for with as by from you your i my we our they them there here now just still like about into over under more most some any all not no than then so if while when what which who how why be been being have has had do does did can could would should will".split(" "),
);
const words = (s: string): Set<string> =>
  new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

/** Meaningful word overlap, 0..1, against the smaller set. */
export function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/** Highest similarity against any recent post, with the offender. */
export function tooSimilar(text: string, recent: string[], max = 0.45): { hit: string; score: number } | null {
  for (const r of recent) {
    const score = similarity(text, r);
    if (score >= max) return { hit: r, score };
  }
  return null;
}

/**
 * Junk filter for OTHER people's tweets, deciding what is even worth reading.
 * Crypto X is heavy with launchpad promos, giveaway farming and pump chatter
 * that OBS must never be seen replying to.
 */
const JUNK: RegExp[] = [
  /\b(presale|pre-sale|whitelist|airdrop|giveaway|free mint|claim now|1000x|100x|moon(ing|shot)?|pump|ape in|degen play)\b/i,
  /\b(launchpad|fair launch|stealth launch|liquidity locked|dev doxxed|next gem|low ?cap)\b/i,
  /\b(dm me|check my bio|link in bio|join (our|the) (tg|telegram|discord)|follow.{0,12}retweet)\b/i,
  /(\$[A-Za-z]{2,10}\b.*){4,}/,
  /(#\w+\s*){4,}/,
];
export function isJunk(text: string): boolean {
  return JUNK.some((re) => re.test(text));
}
