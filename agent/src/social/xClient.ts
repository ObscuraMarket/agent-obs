// X (Twitter) posting client for @ObscuraCEX, OBS's account. DRAFT-FIRST by
// design: it only posts for real when X_LIVE === "true". Anything else
// (unset, "false", "draft") logs the tweet to a ledger and returns without
// posting, so the voice can be reviewed before a single autonomous tweet goes
// out.
//
// Auth: OAuth 1.0a user context (the 4 keys below), required to POST as the
// account. A bearer token is app-only/read and CANNOT post.
import { TwitterApi } from "twitter-api-v2";
import { appendLedger } from "../ledger.ts";
import { stripDashes } from "./postGuards.ts";
import { MAX_TWEET_CHARS } from "../config.ts";

export interface XConfig {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

function readConfig(): XConfig | null {
  const appKey = process.env.X_API_KEY;
  const appSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;
  if (!appKey || !appSecret || !accessToken || !accessSecret) return null;
  return { appKey, appSecret, accessToken, accessSecret };
}
const client = (cfg: XConfig) => new TwitterApi({ appKey: cfg.appKey, appSecret: cfg.appSecret, accessToken: cfg.accessToken, accessSecret: cfg.accessSecret });

export function xConfigured(): boolean {
  return readConfig() !== null;
}
export function xLive(): boolean {
  return process.env.X_LIVE === "true";
}

export interface PostResult {
  posted: boolean; // true only if it actually hit X
  reason?: string;
  id?: string;
  text: string;
}

/**
 * X's real explanation for a failed write. `err.message` is just "Request
 * failed with code 403", which can mean hundreds of consecutive reply
 * failures with no way to tell WHICH 403. The payload lives on `err.data`.
 */
function describeXError(err: unknown): { message: string; status?: number; detail?: string } {
  const e = err as { message?: string; code?: number; data?: unknown };
  const message = e?.message ?? String(err);
  let detail: string | undefined;
  try {
    const d = e?.data as { title?: string; detail?: string; reason?: string; errors?: Array<{ message?: string }> } | undefined;
    if (d) {
      const parts = [d.title, d.detail, d.reason, ...(d.errors ?? []).map((x) => x?.message)].filter(Boolean);
      detail = parts.length ? parts.join(" | ") : JSON.stringify(d);
    }
  } catch {
    /* non-serialisable payload */
  }
  return { message, status: e?.code, detail: detail?.slice(0, 400) };
}

/** Post a tweet, or in draft mode record what WOULD be posted. Always ledgered. */
export async function postTweet(text: string): Promise<PostResult> {
  // Last line of defence on the house no-dash rule: the moment before it publishes.
  const trimmed = stripDashes(text).trim();
  if (!trimmed || trimmed.length > MAX_TWEET_CHARS) {
    return { posted: false, reason: `bad length (${trimmed.length}/${MAX_TWEET_CHARS})`, text: trimmed };
  }
  const cfg = readConfig();
  if (!cfg) {
    appendLedger("x-posts.jsonl", { at: Date.now(), mode: "unconfigured", posted: false, text: trimmed });
    return { posted: false, reason: "X keys not configured", text: trimmed };
  }
  if (!xLive()) {
    appendLedger("x-posts.jsonl", { at: Date.now(), mode: "draft", posted: false, text: trimmed });
    return { posted: false, reason: "draft mode (set X_LIVE=true to post)", text: trimmed };
  }
  try {
    const res = await client(cfg).v2.tweet(trimmed);
    appendLedger("x-posts.jsonl", { at: Date.now(), mode: "live", posted: true, id: res.data.id, text: trimmed });
    return { posted: true, id: res.data.id, text: trimmed };
  } catch (err) {
    const { message, status, detail } = describeXError(err);
    appendLedger("x-posts.jsonl", { at: Date.now(), mode: "live", posted: false, error: message.slice(0, 200), status, detail, text: trimmed });
    console.error(`[x] post failed: ${status ?? "?"} ${detail ?? message}`.slice(0, 300));
    return { posted: false, reason: `post failed: ${(detail ?? message).slice(0, 160)}`, text: trimmed };
  }
}

/** Delete a tweet this account posted. For the case a guard defect ships something broken. */
export async function deleteTweet(id: string): Promise<{ deleted: boolean; reason?: string }> {
  if (!/^\d{5,25}$/.test(id)) return { deleted: false, reason: "not a tweet id" };
  const cfg = readConfig();
  if (!cfg) return { deleted: false, reason: "X keys not configured" };
  if (!xLive()) return { deleted: false, reason: "draft mode (set X_LIVE=true)" };
  try {
    await client(cfg).v2.deleteTweet(id);
    appendLedger("x-posts.jsonl", { at: Date.now(), mode: "live", posted: false, deletedId: id });
    return { deleted: true };
  } catch (err) {
    const { message, status, detail } = describeXError(err);
    return { deleted: false, reason: `delete failed: ${(detail ?? message).slice(0, 160)} (${status ?? "?"})` };
  }
}

export interface Mention {
  id: string;
  text: string;
  authorId: string;
  authorHandle: string;
  createdAt: string;
  parentText?: string;
  parentIsMine?: boolean;
  conversationId?: string;
}

/** Mentions newer than `sinceId` (exclusive), oldest-first. Read-only. */
export async function getMentions(sinceId?: string): Promise<Mention[]> {
  const cfg = readConfig();
  if (!cfg) return [];
  try {
    const c = client(cfg);
    const me = await c.v2.me();
    const page = await c.v2.userMentionTimeline(me.data.id, {
      max_results: 30,
      since_id: sinceId,
      "tweet.fields": ["author_id", "created_at", "text", "conversation_id", "referenced_tweets"],
      expansions: ["author_id", "referenced_tweets.id"],
    });
    const users: Record<string, string> = {};
    for (const u of page.includes?.users ?? []) users[u.id] = u.username;
    const byId: Record<string, { text: string; authorId?: string }> = {};
    for (const t of page.includes?.tweets ?? []) byId[t.id] = { text: t.text, authorId: t.author_id };
    const list = (page.data?.data ?? []).filter((t) => t.author_id !== me.data.id);
    return list
      .map((t) => {
        const parentId = (t.referenced_tweets ?? []).find((r) => r.type === "replied_to")?.id;
        const parent = parentId ? byId[parentId] : undefined;
        return {
          id: t.id,
          text: t.text,
          authorId: t.author_id ?? "",
          authorHandle: users[t.author_id ?? ""] ?? "unknown",
          createdAt: t.created_at ?? "",
          parentText: parent?.text,
          parentIsMine: parent?.authorId === me.data.id,
          conversationId: t.conversation_id,
        };
      })
      .reverse();
  } catch {
    return [];
  }
}

export interface PostMetric {
  id: string;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  impressions: number;
}

/** Engagement on OBS's OWN recent posts. An observation for the voice, never a target. */
export async function getMyPostMetrics(ids: string[]): Promise<Record<string, PostMetric>> {
  const cfg = readConfig();
  if (!cfg || !ids.length) return {};
  try {
    const res = await client(cfg).v2.tweets(ids.slice(0, 100), { "tweet.fields": ["public_metrics"] });
    const out: Record<string, PostMetric> = {};
    for (const t of res.data ?? []) {
      const m = t.public_metrics as { like_count?: number; reply_count?: number; retweet_count?: number; quote_count?: number; impression_count?: number } | undefined;
      if (!m) continue;
      out[t.id] = { id: t.id, likes: m.like_count ?? 0, replies: m.reply_count ?? 0, reposts: m.retweet_count ?? 0, quotes: m.quote_count ?? 0, impressions: m.impression_count ?? 0 };
    }
    return out;
  } catch {
    return {};
  }
}

/** The account is not ALLOWED to reply to strangers (an access-tier fact, not a per-tweet one). */
export function isReplyPermissionError(reason: string | undefined): boolean {
  return /only reply to or quote posts where you are mentioned/i.test(reason ?? "");
}

/** Reply to a specific tweet. Same draft-first gate as postTweet. */
export async function postReply(text: string, inReplyToId: string): Promise<PostResult> {
  const trimmed = stripDashes(text).trim();
  if (!trimmed || trimmed.length > MAX_TWEET_CHARS) {
    return { posted: false, reason: `bad length (${trimmed.length}/${MAX_TWEET_CHARS})`, text: trimmed };
  }
  const cfg = readConfig();
  if (!cfg) {
    appendLedger("x-replies.jsonl", { at: Date.now(), mode: "unconfigured", posted: false, inReplyToId, text: trimmed });
    return { posted: false, reason: "X keys not configured", text: trimmed };
  }
  if (!xLive()) {
    appendLedger("x-replies.jsonl", { at: Date.now(), mode: "draft", posted: false, inReplyToId, text: trimmed });
    return { posted: false, reason: "draft mode (set X_LIVE=true to post)", text: trimmed };
  }
  try {
    const res = await client(cfg).v2.reply(trimmed, inReplyToId);
    appendLedger("x-replies.jsonl", { at: Date.now(), mode: "live", posted: true, id: res.data.id, inReplyToId, text: trimmed });
    return { posted: true, id: res.data.id, text: trimmed };
  } catch (err) {
    const { message, status, detail } = describeXError(err);
    appendLedger("x-replies.jsonl", { at: Date.now(), mode: "live", posted: false, error: message.slice(0, 200), status, detail, inReplyToId, text: trimmed });
    return { posted: false, reason: `reply failed: ${(detail ?? message).slice(0, 160)}`, text: trimmed };
  }
}
