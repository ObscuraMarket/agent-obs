// Check the X keys the desk was given, without posting anything: which account they sign as, whether they may
// write, and what the API tier lets the desk read. Run wherever the four keys are in the environment: locally
// after pasting them into agent/.env, or inside the desk's container after they are set on Railway.
//   npm run x:check
// Prints handles and status codes only, never a key.
import { TwitterApi } from "twitter-api-v2";

const names = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"] as const;
const missing = names.filter((k) => !process.env[k]);
if (missing.length) { console.error(`not set: ${missing.join(", ")}`); process.exit(2); }
const c = new TwitterApi({ appKey: process.env.X_API_KEY as string, appSecret: process.env.X_API_SECRET as string, accessToken: process.env.X_ACCESS_TOKEN as string, accessSecret: process.env.X_ACCESS_SECRET as string });

/** X's own words for a failure: the status and the payload's title or detail, never the request. */
function why(err: unknown): string {
  const e = err as { code?: number; message?: string; data?: { title?: string; detail?: string; reason?: string } };
  const d = e?.data;
  const text = [d?.title, d?.detail, d?.reason].filter(Boolean).join(", ");
  return `${e?.code ?? "?"}${text ? `: ${text}` : e?.message ? `: ${e.message}` : ""}`.slice(0, 200);
}

let me: { id: string; username: string };
try {
  const r = await c.v2.me();
  me = { id: r.data.id, username: r.data.username };
  const want = (process.env.X_HANDLE ?? "").replace(/^@/, "");
  console.log(`the keys sign as @${me.username} (id ${me.id})${want ? (want.toLowerCase() === me.username.toLowerCase() ? `, which is X_HANDLE` : `, but X_HANDLE says @${want}: fix one of them`) : "; X_HANDLE is not set, set it to this handle"}`);
} catch (err) {
  console.error(`the keys do not authenticate (${why(err)}). Regenerate the access token and secret under the app, after its permissions are set.`);
  process.exit(1);
}

// The access level the token was minted with. A token made before the app's permission was raised to Read and
// Write stays read-only, and every post then fails with a 403; this header says so before the first post.
try {
  const r = await c.v1.get<unknown>("account/verify_credentials.json", { skip_status: true }, { fullResponse: true });
  const level = String((r.headers as Record<string, unknown>)["x-access-level"] ?? "");
  if (level) console.log(`access level: ${level}${level.includes("write") ? " (posting allowed)" : " (READ ONLY: regenerate the access token after setting the app to Read and Write)"}`);
  else console.log("access level: the header was not returned; a first draft going live will tell");
} catch (err) {
  console.log(`access level: could not be read on this tier (${why(err)}); a first draft going live will tell`);
}

// What the tier lets the desk read. Posting needs none of this; the reply pass and the post metrics do.
try {
  await c.v2.userMentionTimeline(me.id, { max_results: 5 });
  console.log("mentions: readable, so the reply pass can run (OBS_X_ENGAGE=on) and the desk can see how its posts land");
} catch (err) {
  console.log(`mentions: not readable (${why(err)}). Posting still works; the reply pass and the post metrics need the Basic tier or higher`);
}
