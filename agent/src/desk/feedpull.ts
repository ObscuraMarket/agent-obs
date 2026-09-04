// The launch feed, pulled to a hosted desk. The launch watcher runs on the
// operator's machine and its feed is append-only; the operator's API serves
// the file's bytes from an offset (GET /api/obs/feed-tail?from=N, a shared
// token in X-OBS-Feed-Token), and this loop appends them to the local copy
// every OBS_FEED_PULL_SEC seconds. On the first run it starts from the last
// OBS_FEED_PULL_TAIL_MB of the file, so the desk has trails to read within
// a minute. Bad or missing settings leave quietly; a source that does not
// answer is retried next time.
import { existsSync, mkdirSync, statSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

const SOURCE = (process.env.OBS_FEED_SOURCE ?? "").replace(/\/+$/, "");
const TOKEN = process.env.OBS_FEED_TOKEN ?? "";
const FILE = process.env.OBS_CANDIDATE_FEED ?? "";
const EVERY = Number(process.env.OBS_FEED_PULL_SEC ?? 30);
const TAIL_MB = Number(process.env.OBS_FEED_PULL_TAIL_MB ?? 24);
const CHUNK = 8 * 1024 * 1024;

if (!SOURCE || !TOKEN || !FILE) {
  console.log("[feedpull] OBS_FEED_SOURCE, OBS_FEED_TOKEN and OBS_CANDIDATE_FEED are needed; nothing to pull");
  process.exit(0);
}
mkdirSync(dirname(FILE), { recursive: true });
let offset: number | null = null;

async function pull(): Promise<void> {
  if (offset == null) {
    // Resume from the local copy's size, or start from the source's tail.
    if (existsSync(FILE) && statSync(FILE).size > 0) {
      offset = statSync(FILE).size;
    } else {
      const head = await fetch(`${SOURCE}/api/obs/feed-tail?from=0&size=1`, { headers: { "X-OBS-Feed-Token": TOKEN } });
      const total = Number(head.headers.get("x-obs-feed-size") ?? 0);
      offset = Math.max(0, total - TAIL_MB * 1024 * 1024);
      // Start on a line boundary: skip the partial first line.
      const first = await fetch(`${SOURCE}/api/obs/feed-tail?from=${offset}&size=65536`, { headers: { "X-OBS-Feed-Token": TOKEN } });
      const text = await first.text();
      const nl = text.indexOf("\n");
      offset += nl >= 0 ? nl + 1 : 0;
      console.log(`[feedpull] starting from byte ${offset} of ${total}`);
    }
  }
  const res = await fetch(`${SOURCE}/api/obs/feed-tail?from=${offset}&size=${CHUNK}`, { headers: { "X-OBS-Feed-Token": TOKEN } });
  if (!res.ok) throw new Error(`source answered ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const total = Number(res.headers.get("x-obs-feed-size") ?? 0);
  if (total && total < (offset ?? 0)) {
    console.log(`[feedpull] the source shrank (${total} < ${offset}); restarting from its tail`);
    offset = null;
    return;
  }
  if (buf.length) {
    appendFileSync(FILE, buf);
    offset = (offset ?? 0) + buf.length;
  }
}

console.log(`[feedpull] ${SOURCE} -> ${FILE}, every ${EVERY} s`);
for (;;) {
  try {
    await pull();
  } catch (e) {
    console.log(`[feedpull] ${e instanceof Error ? e.message : String(e)}`);
  }
  await new Promise((r) => setTimeout(r, EVERY * 1000));
}
